import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiAuthError,
  ApiNetworkError,
  ApiRetryableError,
  ApiValidationError,
  FantasyApiClient,
  extractCookieValue,
  getSetCookies,
  ApiResponseError,
} from '../src/api/client';
import { getEventLive, getFixtures, getMyTeam, updateMyTeam } from '../src/api/endpoints';
import {
  checkSessionHealth,
  getSession,
  type SessionRecord,
  type SessionStore,
} from '../src/api/session';

const BASE_URL = 'https://fantasy.ligaportugal.pt/api';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const headerMap = new Headers(headers);
  if (!headerMap.has('content-type')) headerMap.set('content-type', 'application/json');
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headerMap,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): Response {
  const headerMap = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headerMap,
    json: async () => {
      throw new SyntaxError('Unexpected token in JSON');
    },
    text: async () => text,
  } as unknown as Response;
}

function inMemoryStore(
  initial: SessionRecord | null = null,
): SessionStore & { saved: SessionRecord[] } {
  let current = initial;
  return {
    saved: [],
    async getSession() {
      return current;
    },
    async saveSession(record: SessionRecord) {
      current = record;
      this.saved.push(record);
    },
  };
}

describe('FantasyApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries on 503 then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { detail: 'temporarily unavailable' }))
      .mockResolvedValueOnce(jsonResponse(200, { elements: [] }));

    const client = new FantasyApiClient(BASE_URL);
    const promise = getEventLive(client, 4);

    // Let the backoff timer for attempt 1 elapse so the retry can fire.
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result).toEqual({ elements: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting retries on repeated 5xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse(502, { detail: 'bad gateway' }));

    const client = new FantasyApiClient(BASE_URL);
    const promise = getEventLive(client, 4);
    const assertion = expect(promise).rejects.toBeInstanceOf(ApiRetryableError);

    await vi.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS
  });

  it('retries a request timeout, then succeeds', async () => {
    // A hung request must not hold the per-host queue forever: the client
    // aborts on a deadline and treats the timeout as transient.
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { elements: [] }));

    const client = new FantasyApiClient(BASE_URL);
    const promise = getEventLive(client, 4);

    await vi.advanceTimersByTimeAsync(5000);

    expect(await promise).toEqual({ elements: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes an abort signal so a request can never hang indefinitely', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { elements: [] }));

    const client = new FantasyApiClient(BASE_URL);
    await getEventLive(client, 4);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails fast on a non-timeout network error rather than retrying', async () => {
    // DNS/TLS/connection-refused will not fix themselves; retrying only burns
    // the Workflow step's budget.
    fetchMock.mockRejectedValue(new TypeError('Network connection lost.'));

    const client = new FantasyApiClient(BASE_URL);
    await expect(getEventLive(client, 4)).rejects.toBeInstanceOf(ApiNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 400 and surfaces the DRF field errors', async () => {
    const fieldErrors = { email: ['This field is required.'] };
    fetchMock.mockResolvedValueOnce(jsonResponse(400, fieldErrors));

    const client = new FantasyApiClient(BASE_URL);
    const promise = client.post('player/login/', { password: 'x' });

    await expect(promise).rejects.toBeInstanceOf(ApiValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(jsonResponse(400, fieldErrors));
    try {
      await client.post('player/login/', { password: 'x' });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiValidationError);
      expect((err as ApiValidationError).fieldErrors).toEqual(fieldErrors);
    }
  });

  it('surfaces raw text when a 400 body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(400, '<html>Bad Request</html>'));

    const client = new FantasyApiClient(BASE_URL);
    try {
      await client.get('bootstrap-static/');
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiValidationError);
      expect((err as ApiValidationError).fieldErrors).toBe('<html>Bad Request</html>');
    }
  });

  it('throws ApiAuthError on 401/403 without retrying', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { detail: 'Forbidden' }));

    const client = new FantasyApiClient(BASE_URL);
    await expect(client.get('me/')).rejects.toBeInstanceOf(ApiAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ApiNetworkError on fetch failure without retrying', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));

    const client = new FantasyApiClient(BASE_URL);
    await expect(client.get('bootstrap-static/')).rejects.toBeInstanceOf(ApiNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('builds exact URLs: trailing slash + query, and nested path params', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));

    const client = new FantasyApiClient(BASE_URL);
    await getFixtures(client, 3);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://fantasy.ligaportugal.pt/api/fixtures/?event=3',
      expect.anything(),
    );

    fetchMock.mockResolvedValue(jsonResponse(200, { picks: [] }));
    const { getEntryPicks } = await import('../src/api/endpoints');
    await getEntryPicks(client, 123, 4);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://fantasy.ligaportugal.pt/api/entry/123/event/4/picks/',
      expect.anything(),
    );
  });

  it('serializes chip: null as a present key, not omitted or empty string', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { picks: [], chips: [] }));

    const client = new FantasyApiClient(BASE_URL);
    await updateMyTeam(client, 42, { cookie: 'sessionid=abc' }, { chip: null, picks: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect('chip' in sentBody).toBe(true);
    expect(sentBody.chip).toBeNull();
  });

  it('sends Cookie, Referer and X-CSRFToken headers on authenticated writes', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { picks: [], chips: [] }));

    const client = new FantasyApiClient(BASE_URL);
    await getMyTeam(client, 42, { cookie: 'sessionid=abc' });
    const [, getInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((getInit.headers as Record<string, string>)['Cookie']).toBe('sessionid=abc');

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse(200, { picks: [], chips: [] }));
    await updateMyTeam(
      client,
      42,
      { cookie: 'sessionid=abc', csrfToken: 'tok123' },
      { chip: null, picks: [] },
    );
    const [, postInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = postInit.headers as Record<string, string>;
    expect(headers['Cookie']).toBe('sessionid=abc');
    expect(headers['X-CSRFToken']).toBe('tok123');
    expect(headers['Referer']).toBe('https://fantasy.ligaportugal.pt/');
  });

  it('never issues overlapping requests to the same host', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    fetchMock.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return jsonResponse(200, { elements: [] });
    });

    const client = new FantasyApiClient(BASE_URL);
    await Promise.all([getEventLive(client, 1), getEventLive(client, 2), getEventLive(client, 3)]);

    expect(maxInFlight).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('cookie helpers', () => {
  it('extracts sessionid from a Set-Cookie header containing a comma (Expires attribute)', () => {
    const headers = new Headers();
    headers.append(
      'set-cookie',
      'sessionid=abc123xyz; expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly; SameSite=Lax',
    );

    const setCookies = getSetCookies(headers);
    expect(extractCookieValue(setCookies, 'sessionid')).toBe('abc123xyz');
  });

  it('does not confuse a comma inside Expires with a second cookie', () => {
    const headers = new Headers();
    headers.append(
      'set-cookie',
      'sessionid=abc123xyz; expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/',
    );
    const setCookies = getSetCookies(headers);
    // Whatever the runtime folded this into, extraction must still recover
    // the correct, un-truncated sessionid value.
    expect(extractCookieValue(setCookies, 'sessionid')).toBe('abc123xyz');
  });
});

describe('session.ts', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('password provider logs in, extracts sessionid, and caches it', async () => {
    const loginResponse = {
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true }),
      text: async () => JSON.stringify({ ok: true }),
    } as unknown as Response;
    // Attach a real Set-Cookie via a Headers instance that supports getSetCookie.
    (loginResponse.headers as Headers).append(
      'set-cookie',
      'sessionid=live-session-value; expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly',
    );
    fetchMock.mockResolvedValueOnce(loginResponse);

    const store = inMemoryStore(null);
    const env = {
      FANTASY_BASE_URL: BASE_URL,
      SESSION_PROVIDER: 'password',
      FANTASY_EMAIL: 'agent@example.com',
      FANTASY_PASSWORD: 'hunter2',
    };

    const cookie = await getSession(env, store);
    expect(cookie).toBe('sessionid=live-session-value');
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.cookie).toBe('sessionid=live-session-value');
  });

  it('manual provider builds the cookie from FANTASY_SESSION_COOKIE without calling the API', async () => {
    const store = inMemoryStore(null);
    const env = {
      FANTASY_BASE_URL: BASE_URL,
      SESSION_PROVIDER: 'manual',
      FANTASY_SESSION_COOKIE: 'pasted-value-123',
    };

    const cookie = await getSession(env, store);
    expect(cookie).toBe('sessionid=pasted-value-123');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses a cached session instead of logging in again', async () => {
    const store = inMemoryStore({ cookie: 'sessionid=cached', fetchedAt: Date.now() });
    const env = {
      FANTASY_BASE_URL: BASE_URL,
      SESSION_PROVIDER: 'password',
      FANTASY_EMAIL: 'agent@example.com',
      FANTASY_PASSWORD: 'hunter2',
    };

    const cookie = await getSession(env, store);
    expect(cookie).toBe('sessionid=cached');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checkSessionHealth surfaces a dead session as unhealthy, never swallowing the null player', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { player: null, watched: [] }));

    const env = { FANTASY_BASE_URL: BASE_URL, SESSION_PROVIDER: 'manual' };
    const result = await checkSessionHealth(env, 'sessionid=dead');

    expect(result.healthy).toBe(false);
    expect(result.entry).toBeUndefined();
  });

  it('checkSessionHealth reports the entry id for a live session', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { player: { entry: 555 }, watched: [] }));

    const env = { FANTASY_BASE_URL: BASE_URL, SESSION_PROVIDER: 'manual' };
    const result = await checkSessionHealth(env, 'sessionid=live');

    expect(result).toEqual({ healthy: true, entry: 555 });
  });
});

describe('non-JSON responses', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats a 2xx with an empty body as success, not a malformed response', async () => {
    // entry-create/ replies with no content-type and an empty body on success.
    // Throwing here made the agent log a failure for a team that HAD been
    // created — and a retry on that false failure could have submitted a
    // second squad.
    fetchMock.mockResolvedValueOnce(new Response('', { status: 201 }));

    const client = new FantasyApiClient('https://example.test/api');
    await expect(client.post('entry-create/', { picks: [] })).resolves.toBeDefined();
  });

  it('still rejects a non-JSON body that actually has content', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>gateway error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const client = new FantasyApiClient('https://example.test/api');
    await expect(client.post('entry-create/', {})).rejects.toBeInstanceOf(ApiResponseError);
  });
});
