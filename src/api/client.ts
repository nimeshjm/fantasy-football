/**
 * Fetch wrapper for the Fantasy Liga Portugal API
 * (`https://fantasy.ligaportugal.pt/api`, a rebranded Fantasy Premier League
 * engine: Django REST Framework, cookie session auth).
 *
 * Responsibilities, and nothing more:
 *  - build the request (base URL, query string, JSON body, headers)
 *  - classify the response into a typed error or a parsed JSON body
 *  - retry 429/5xx with exponential backoff + jitter, bounded at 3 attempts
 *  - serialize all requests to the API host so this client never issues a
 *    parallel burst against it
 *
 * It does NOT know about specific endpoints (see endpoints.ts) or how a
 * session cookie is obtained (see session.ts). It also does not transform or
 * project response bodies: bootstrap-static/ is ~1 MB and JSON.parse alone
 * costs ~1.7 ms of the 10 ms per-invocation CPU budget on the free tier, so
 * this layer parses once and hands the raw object to the caller.
 */

/** The subset of Env this layer needs. Defined once here; session.ts and
 * endpoints.ts import it from this file rather than redeclaring it, so the
 * shape only has one source of truth.
 *
 * `SESSION_PROVIDER` is typed as `string`, not a literal union: wrangler
 * `vars` always arrive as strings, and the real `Env` type (defined
 * elsewhere, wiring wrangler.jsonc) will be `SESSION_PROVIDER: string`. A
 * narrower type here would not be assignable from it.
 */
export interface FantasyEnv {
  FANTASY_BASE_URL: string;
  SESSION_PROVIDER: string;
  FANTASY_EMAIL?: string;
  FANTASY_PASSWORD?: string;
  FANTASY_SESSION_COOKIE?: string;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  /** Cookie header value, e.g. "sessionid=abc123". Omit for public GETs. */
  cookie?: string;
  /** Value of a captured csrftoken cookie, if any. Sent as X-CSRFToken on writes only. */
  csrfToken?: string;
}

/** 400: Django REST Framework field-validation errors. Body shape varies by
 * endpoint (e.g. `{"email": ["This field is required."]}`), so it is kept
 * as `unknown` and surfaced to the caller rather than guessed at. */
export class ApiValidationError extends Error {
  readonly status = 400 as const;
  constructor(
    public readonly fieldErrors: unknown,
    message = 'Validation failed (400)',
  ) {
    super(message);
    this.name = 'ApiValidationError';
  }
}

/** 401/403: the session cookie is missing, expired, or otherwise rejected. */
export class ApiAuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message = 'Authentication failed',
  ) {
    super(message);
    this.name = 'ApiAuthError';
  }
}

/** 429/5xx after all retry attempts are exhausted. */
export class ApiRetryableError extends Error {
  constructor(
    public readonly status: number,
    public readonly attempts: number,
    message = 'Retryable API error',
  ) {
    super(message);
    this.name = 'ApiRetryableError';
  }
}

/** fetch() itself threw (DNS, TLS, connection reset, ...). Never retried:
 * only 429/5xx get backoff, per spec. */
export class ApiNetworkError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ApiNetworkError';
  }
}

/** Any other unexpected status, or a response that claimed to be JSON but
 * wasn't (or claimed 2xx but wasn't JSON at all — e.g. an HTML error page
 * from a proxy in front of the API). */
export class ApiResponseError extends Error {
  constructor(
    public readonly status: number,
    message = 'Unexpected API response',
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

const MAX_ATTEMPTS = 3;

/**
 * Per-request timeout. Non-negotiable given two other properties of this
 * client: requests to a host are serialised through `enqueueForHost`, and
 * Cloudflare Workflow steps have unlimited wall-clock time. Without a
 * deadline, one hung fetch would hold the host queue forever and the workflow
 * step would stall indefinitely rather than failing and being retried. A
 * timeout guarantees every queued promise settles, so the queue always drains.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const BASE_DELAY_MS = 300;
const MAX_DELAY_MS = 4000;

/** Equal jitter: half fixed, half random. A retry never fires at ~0ms (full
 * jitter allows that), which matters for "never issue parallel bursts" —
 * we want spacing, not a coin-flip that lands back-to-back with attempt 1. */
function backoffDelayMs(attempt: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  return exp / 2 + Math.random() * (exp / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Per-host serialization so no two FantasyApiClient instances (or two calls
 * on the same instance) ever have requests in flight to the API host at the
 * same time. Module-scoped rather than per-instance so the guarantee holds
 * even if a caller builds more than one client. */
const hostQueues = new Map<string, Promise<void>>();

function enqueueForHost<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const prior = hostQueues.get(host) ?? Promise.resolve();
  const settled = prior.then(fn, fn);
  hostQueues.set(
    host,
    settled.then(
      () => undefined,
      () => undefined,
    ),
  );
  return settled;
}

/** Standard fetch spec exposes `Headers.getSetCookie()` (workerd and modern
 * Node implement it) to get every Set-Cookie header, since `Headers.get`
 * folds multiple values into one comma-joined string and Set-Cookie values
 * routinely contain commas themselves (e.g. in the Expires attribute) —
 * naive comma-splitting corrupts them. Fall back to a single `get()` read
 * for runtimes/test doubles that don't implement it. */
export function getSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

/** Pull one cookie's value out of a list of raw Set-Cookie header strings. */
export function extractCookieValue(setCookieHeaders: string[], name: string): string | undefined {
  const pattern = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`);
  for (const header of setCookieHeaders) {
    const match = pattern.exec(header);
    if (match) return match[1];
  }
  return undefined;
}

export class FantasyApiClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(
    baseUrl: string,
    userAgent = 'fantasy-football-agent/0.1 (Cloudflare Worker; +https://fantasy.ligaportugal.pt)',
  ) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.userAgent = userAgent;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, options).then((r) => r.data);
  }

  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, options, body).then((r) => r.data);
  }

  /** Like post(), but also returns the raw Response so a caller (namely
   * session.ts, logging in) can read response headers such as Set-Cookie.
   * Its body has already been consumed to produce `data` — don't call
   * `.json()`/`.text()` on the returned response again. */
  postRaw<T>(
    path: string,
    body: unknown,
    options?: RequestOptions,
  ): Promise<{ data: T; response: Response }> {
    return this.request<T>('POST', path, options, body);
  }

  private buildUrl(path: string, query?: RequestOptions['query']): { url: string; host: string } {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return { url: url.toString(), host: url.host };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options?: RequestOptions,
    body?: unknown,
  ): Promise<{ data: T; response: Response }> {
    const { url, host } = this.buildUrl(path, options?.query);

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
    };
    if (options?.cookie) headers['Cookie'] = options.cookie;

    let serializedBody: string | undefined;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers['Referer'] = 'https://fantasy.ligaportugal.pt/';
      if (options?.csrfToken) headers['X-CSRFToken'] = options.csrfToken;
      serializedBody = JSON.stringify(body ?? null);
    }

    return enqueueForHost(host, () => this.attempt<T>(method, path, url, headers, serializedBody));
  }

  private async attempt<T>(
    method: 'GET' | 'POST',
    path: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ data: T; response: Response }> {
    let lastRetryableStatus = -1;

    for (let attemptNum = 1; attemptNum <= MAX_ATTEMPTS; attemptNum++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // A timeout is a transient condition, not a broken request, so unlike
        // other network failures it earns a retry. Everything else (DNS, TLS,
        // connection refused) fails fast — retrying those just burns the
        // step's budget on an error that will not resolve itself.
        const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
        if (timedOut && attemptNum < MAX_ATTEMPTS) {
          await sleep(backoffDelayMs(attemptNum));
          continue;
        }
        throw new ApiNetworkError(
          timedOut
            ? `Timed out after ${REQUEST_TIMEOUT_MS}ms calling ${method} ${path} (${attemptNum} attempts)`
            : `Network failure calling ${method} ${path}`,
          err,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        lastRetryableStatus = response.status;
        if (attemptNum < MAX_ATTEMPTS) {
          await sleep(backoffDelayMs(attemptNum));
          continue;
        }
        throw new ApiRetryableError(
          response.status,
          attemptNum,
          `Retryable status ${response.status} from ${method} ${path} after ${attemptNum} attempts`,
        );
      }

      if (response.status === 401 || response.status === 403) {
        throw new ApiAuthError(
          response.status,
          `Auth error ${response.status} from ${method} ${path}`,
        );
      }

      if (response.status === 400) {
        const text = await response.text();
        let fieldErrors: unknown = text;
        try {
          fieldErrors = JSON.parse(text);
        } catch {
          // Non-JSON 400 body (e.g. an HTML error page) — surface the raw text.
        }
        throw new ApiValidationError(fieldErrors, `Validation error from ${method} ${path}`);
      }

      if (!response.ok) {
        throw new ApiResponseError(
          response.status,
          `Unexpected status ${response.status} from ${method} ${path}`,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const text = await response.text().catch(() => '');
        throw new ApiResponseError(
          response.status,
          `Expected JSON from ${method} ${path}, got content-type "${contentType}": ${text.slice(0, 200)}`,
        );
      }

      try {
        const data = (await response.json()) as T;
        return { data, response };
      } catch (err) {
        throw new ApiResponseError(
          response.status,
          `Response from ${method} ${path} claimed content-type application/json but failed to parse: ${String(err)}`,
        );
      }
    }

    // Unreachable: the loop above always returns or throws. Kept for TS
    // control-flow analysis and to document the invariant.
    throw new ApiRetryableError(
      lastRetryableStatus,
      MAX_ATTEMPTS,
      `Exhausted retries for ${method} ${path}`,
    );
  }
}
