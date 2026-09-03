import type { SessionRow } from './types';

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
