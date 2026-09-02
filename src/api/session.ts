/**
 * Session acquisition for the Fantasy Liga Portugal API.
 *
 * The API authenticates with a `sessionid` cookie, not a bearer token.
 * Two providers, chosen by `env.SESSION_PROVIDER`:
 *  - 'password': POST player/login/ with FANTASY_EMAIL / FANTASY_PASSWORD
 *    secrets, extract `sessionid` from the Set-Cookie response header, cache it.
 *  - 'manual': read a pasted sessionid straight from FANTASY_SESSION_COOKIE.
 *
 * This file does not import src/db. Session caching goes through the
 * `SessionStore` interface below, which another workstream wires to D1.
 */

import {
  ApiValidationError,
  FantasyApiClient,
  extractCookieValue,
  getSetCookies,
  type FantasyEnv,
} from './client';
import { getMe, loginRaw, type MeResponse } from './endpoints';

export type { FantasyEnv } from './client';

/** Everything a write request needs for auth: the Cookie header, and — if a
 * csrftoken cookie was ever captured — the value to echo back as
 * X-CSRFToken. Threading this as one object (rather than a bare cookie
 * string) means a write endpoint can't accidentally forget the CSRF header:
 * it takes an AuthContext or it doesn't compile against endpoints.ts. */
export interface AuthContext {
  /** Cookie header value, e.g. "sessionid=abc123". */
  cookie: string;
  csrfToken?: string;
}

export interface SessionRecord {
  cookie: string;
  csrfToken?: string;
  /** The authenticated entry (team) id, when known. */
  entry?: number;
  fetchedAt: number;
}

/** Minimal persistence contract for session caching. Another workstream
 * implements this against D1; nothing here reaches into src/db directly. */
export interface SessionStore {
  getSession(): Promise<SessionRecord | null>;
  saveSession(record: SessionRecord): Promise<void>;
}

function normalizeManualCookie(raw: string): string {
  // Accept either a bare sessionid value or an already-formed "sessionid=..."
  // cookie header, so a pasted value from a browser's dev tools works either way.
  return raw.includes('=') ? raw : `sessionid=${raw}`;
}

/**
 * Resolve a Cookie header value to use against the API, per
 * `env.SESSION_PROVIDER`. For 'password', the result is cached via `db` so
 * repeated invocations don't re-login; for 'manual' there is nothing to
 * cache, the secret itself is the session.
 */
export async function getSession(env: FantasyEnv, db: SessionStore): Promise<string> {
  if (env.SESSION_PROVIDER === 'manual') {
    if (!env.FANTASY_SESSION_COOKIE) {
      throw new Error('SESSION_PROVIDER=manual requires FANTASY_SESSION_COOKIE to be set');
    }
    return normalizeManualCookie(env.FANTASY_SESSION_COOKIE);
  }

  if (env.SESSION_PROVIDER === 'password') {
    const cached = await db.getSession();
    if (cached?.cookie) {
      return cached.cookie;
    }

    if (!env.FANTASY_EMAIL || !env.FANTASY_PASSWORD) {
      throw new Error(
        'SESSION_PROVIDER=password requires FANTASY_EMAIL and FANTASY_PASSWORD secrets',
      );
    }

    const record = await login(env, env.FANTASY_EMAIL, env.FANTASY_PASSWORD);
    await db.saveSession(record);
    return record.cookie;
  }

  throw new Error(`Unknown SESSION_PROVIDER: ${env.SESSION_PROVIDER}`);
}

/** Also returns the CSRF token (if any) alongside the cookie, for callers
 * that need a full AuthContext rather than just the Cookie header — e.g. a
 * caller about to make a write request right after establishing a session. */
export async function getAuthContext(env: FantasyEnv, db: SessionStore): Promise<AuthContext> {
  if (env.SESSION_PROVIDER === 'manual') {
    return { cookie: await getSession(env, db) };
  }
  const cached = await db.getSession();
  if (cached?.cookie) {
    return { cookie: cached.cookie, csrfToken: cached.csrfToken };
  }
  // No cache hit: getSession() will perform the login and populate the
  // cache, so read it back rather than duplicating the login call.
  const cookie = await getSession(env, db);
  const refreshed = await db.getSession();
  return { cookie, csrfToken: refreshed?.csrfToken };
}

async function login(env: FantasyEnv, email: string, password: string): Promise<SessionRecord> {
  const client = new FantasyApiClient(env.FANTASY_BASE_URL);

  let response: Response;
  try {
    ({ response } = await loginRaw(client, { email, password }));
  } catch (err) {
    if (err instanceof ApiValidationError) {
      throw new Error(`Login rejected by API (400): ${JSON.stringify(err.fieldErrors)}`);
    }
    throw err;
  }

  const setCookies = getSetCookies(response.headers);
  const sessionid = extractCookieValue(setCookies, 'sessionid');
  if (!sessionid) {
    throw new Error('Login response did not include a sessionid cookie');
  }
  const csrfToken = extractCookieValue(setCookies, 'csrftoken');

  return {
    cookie: `sessionid=${sessionid}`,
    csrfToken,
    fetchedAt: Date.now(),
  };
}

export interface SessionHealth {
  healthy: boolean;
  /** The authenticated entry (team) id. Present only when healthy. */
  entry?: number;
}

/**
 * GET me/ and report whether the session is actually authenticated.
 * `player` is null when the session cookie is missing/expired — that is a
 * dead session and must be surfaced (via the returned `healthy: false`),
 * never treated as success or silently ignored by a caller.
 */
export async function checkSessionHealth(env: FantasyEnv, cookie: string): Promise<SessionHealth> {
  const client = new FantasyApiClient(env.FANTASY_BASE_URL);
  const me: MeResponse = await getMe(client, cookie);
  if (!me.player) {
    return { healthy: false };
  }
  return { healthy: true, entry: me.player.entry };
}
