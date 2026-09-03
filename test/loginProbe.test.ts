/**
 * Tests for src/loginProbe.ts (`POST /admin/login-probe`) and for
 * `peekSession`, the non-side-effecting session read the dashboard needs.
 *
 * Issue #14's fourth checkbox is "re-test the password provider after any
 * account change". The probe exists so that check does not require flipping
 * the live `SESSION_PROVIDER` var and redeploying to find out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleLoginProbe, type LoginProbeEnv, type LoginProbeResult } from '../src/loginProbe';
import { peekSession, type SessionRecord, type SessionStore } from '../src/api/session';
import { LOGIN_PROBE_LAST_AT_KEY } from '../src/sessionHealth';

const BASE_URL = 'https://fantasy.ligaportugal.pt/api';
const TOKEN = 'dashboard-token-value';

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A D1 fake covering only the `config` reads/writes the probe makes -- the
 * house pattern (cf. `fakeConfigOnlyD1` in test/workflows.test.ts): fake the
 * db helper's surface, never a real database. */
function fakeConfigD1(initial: Record<string, string> = {}): D1Database & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  const db = {
    values,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT value FROM config')) {
                const key = String(args[0]);
                return (values[key] === undefined ? null : { value: values[key] }) as T;
              }
              return null as T;
            },
            async run() {
              if (sql.includes('INSERT INTO config')) {
                values[String(args[0])] = String(args[1]);
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db as unknown as D1Database & { values: Record<string, string> };
}

function makeEnv(overrides: Partial<LoginProbeEnv> = {}): LoginProbeEnv {
  return {
    DB: fakeConfigD1(),
    DASHBOARD_TOKEN: TOKEN,
    FANTASY_BASE_URL: BASE_URL,
    FANTASY_EMAIL: 'agent@example.com',
    FANTASY_PASSWORD: 'hunter2',
    ...overrides,
  };
}

function probeRequest(token: string | null = TOKEN): Request {
  const url = token === null ? '/admin/login-probe' : `/admin/login-probe?token=${token}`;
  return new Request(`https://worker.example.com${url}`, { method: 'POST' });
}

async function body(response: Response): Promise<LoginProbeResult> {
  return (await response.json()) as LoginProbeResult;
}

describe('handleLoginProbe', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('404s without a token, and never reaches the live site', async () => {
    const response = await handleLoginProbe(probeRequest(null), makeEnv());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s on a wrong token rather than 401', async () => {
    // 401 would advertise that a token-gated route exists at this path.
    const response = await handleLoginProbe(probeRequest('wrong'), makeEnv());

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s when DASHBOARD_TOKEN is unconfigured, before touching any binding', async () => {
    // This is what lets the deploy-contract test fetch the route on a bundle
    // loaded with no bindings at all and get a clean 404 rather than a 500.
    const response = await handleLoginProbe(
      probeRequest(),
      makeEnv({ DASHBOARD_TOKEN: undefined, DB: undefined as unknown as D1Database }),
    );

    expect(response.status).toBe(404);
  });

  it('reports configured:false, distinct from a failed login, when the secrets are unset', async () => {
    // Under SESSION_PROVIDER=manual these may simply never have been set.
    // Conflating that with "wrong password" makes the checkbox look like a
    // code bug instead of a missing prerequisite.
    const response = await handleLoginProbe(
      probeRequest(),
      makeEnv({ FANTASY_PASSWORD: undefined }),
    );
    const result = await body(response);

    expect(result).toMatchObject({ configured: false, ok: false });
    expect(result.detail).toContain('wrangler secret put');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the site's own 400 field errors -- the expected outcome for this account", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { non_field_errors: ['Incorrect username or password'] }),
    );

    const result = await body(await handleLoginProbe(probeRequest(), makeEnv()));

    expect(result).toMatchObject({ configured: true, ok: false });
    expect(result.fieldErrors).toEqual({
      non_field_errors: ['Incorrect username or password'],
    });
  });

  it('reports a fingerprint, never the cookie, when a login does succeed', async () => {
    const response = jsonResponse(200, { ok: true });
    response.headers.append('set-cookie', 'sessionid=fresh-live-value; Path=/; HttpOnly');
    fetchMock.mockResolvedValueOnce(response);

    const raw = await handleLoginProbe(probeRequest(), makeEnv());
    const text = await raw.clone().text();
    const result = (await raw.json()) as LoginProbeResult;

    expect(result.ok).toBe(true);
    expect(result.cookieFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(text).not.toContain('fresh-live-value');
  });

  it('rate limits back-to-back probes, because failed logins can lock the account out', async () => {
    const env = makeEnv({ DB: fakeConfigD1({ [LOGIN_PROBE_LAST_AT_KEY]: String(Date.now()) }) });

    const result = await body(await handleLoginProbe(probeRequest(), env));

    expect(result).toMatchObject({ configured: true, ok: false });
    expect(result.detail).toContain('rate limited');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('peekSession', () => {
  function store(initial: SessionRecord | null = null): SessionStore {
    return {
      async getSession() {
        return initial;
      },
      async saveSession() {
        throw new Error('peekSession must never write the session store');
      },
    };
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null instead of throwing when the manual secret is unset', async () => {
    // `getSession` throws here, which would 500 the whole dashboard page.
    const cookie = await peekSession(
      { FANTASY_BASE_URL: BASE_URL, SESSION_PROVIDER: 'manual' },
      store(),
    );

    expect(cookie).toBeNull();
  });

  it('normalizes a bare pasted manual cookie', async () => {
    const cookie = await peekSession(
      { FANTASY_BASE_URL: BASE_URL, SESSION_PROVIDER: 'manual', FANTASY_SESSION_COOKIE: 'abc' },
      store(),
    );

    expect(cookie).toBe('sessionid=abc');
  });

  it('returns the cached password cookie without logging in', async () => {
    const cookie = await peekSession(
      {
        FANTASY_BASE_URL: BASE_URL,
        SESSION_PROVIDER: 'password',
        FANTASY_EMAIL: 'a@b.c',
        FANTASY_PASSWORD: 'x',
      },
      store({ cookie: 'sessionid=cached', fetchedAt: 1 }),
    );

    expect(cookie).toBe('sessionid=cached');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on a password cache miss rather than performing a login on a page render', async () => {
    const cookie = await peekSession(
      {
        FANTASY_BASE_URL: BASE_URL,
        SESSION_PROVIDER: 'password',
        FANTASY_EMAIL: 'a@b.c',
        FANTASY_PASSWORD: 'x',
      },
      store(null),
    );

    expect(cookie).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
