import type { SessionOkState, SessionRow } from './types';

/** The `session` table holds exactly one row (id=1, enforced by a CHECK
 * constraint), so reads/writes never need a key. */
export async function getSession(db: D1Database): Promise<SessionRow | null> {
  const row = await db
    .prepare('SELECT cookie, expires_at, last_ok_at FROM session WHERE id = 1')
    .first<{
      cookie: string | null;
      expires_at: string | null;
      last_ok_at: string | null;
    }>();
  if (row === null) return null;
  return { cookie: row.cookie, expiresAt: row.expires_at, lastOkAt: row.last_ok_at };
}

export async function setSession(db: D1Database, session: SessionRow): Promise<void> {
  await db
    .prepare(
      'INSERT INTO session (id, cookie, expires_at, last_ok_at) VALUES (1, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET cookie = excluded.cookie, expires_at = excluded.expires_at, last_ok_at = excluded.last_ok_at',
    )
    .bind(session.cookie, session.expiresAt, session.lastOkAt)
    .run();
}

/**
 * The heartbeat columns only (`last_ok_at`, `first_ok_at`,
 * `cookie_fingerprint`). Returns null when the row does not exist -- which
 * is the normal state under `SESSION_PROVIDER=manual` until the first
 * healthy tick, since no migration seeds this table.
 */
export async function getSessionOkState(db: D1Database): Promise<SessionOkState | null> {
  const row = await db
    .prepare('SELECT last_ok_at, first_ok_at, cookie_fingerprint FROM session WHERE id = 1')
    .first<{
      last_ok_at: string | null;
      first_ok_at: string | null;
      cookie_fingerprint: string | null;
    }>();
  if (row === null) return null;
  return {
    lastOkAt: row.last_ok_at,
    firstOkAt: row.first_ok_at,
    cookieFingerprint: row.cookie_fingerprint,
  };
}

/**
 * Writes the heartbeat columns, naming ONLY those three.
 *
 * That omission is the point: `cookie` and `expires_at` are absent from both
 * the column list and the `DO UPDATE SET` list, so this never clobbers the
 * packed `SessionRecord` JSON src/sessionStore.ts keeps in `cookie` -- and
 * symmetrically, `setSession` never clobbers these. The two writers of this
 * row (a password login, and the hourly heartbeat) therefore cannot
 * overwrite each other's columns.
 */
export async function setSessionOk(db: D1Database, state: SessionOkState): Promise<void> {
  await db
    .prepare(
      'INSERT INTO session (id, last_ok_at, first_ok_at, cookie_fingerprint) VALUES (1, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET last_ok_at = excluded.last_ok_at, ' +
        'first_ok_at = excluded.first_ok_at, cookie_fingerprint = excluded.cookie_fingerprint',
    )
    .bind(state.lastOkAt, state.firstOkAt, state.cookieFingerprint)
    .run();
}
