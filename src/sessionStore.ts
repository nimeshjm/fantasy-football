/**
 * Adapts src/db's single-row `session` table (columns: cookie, expires_at,
 * last_ok_at -- see migrations/0001_init.sql) to the `SessionStore`
 * interface `src/api/session.ts` needs (`SessionRecord`: cookie, optional
 * csrfToken, optional entry, fetchedAt).
 *
 * The `session` table has no csrf_token/entry columns of its own (that
 * schema is owned by another workstream and is correct as given -- adding
 * columns is out of this layer's scope). Rather than lose the CSRF token
 * and entry id across a cold start, this adapter packs the full
 * `SessionRecord` as one JSON blob into the existing `cookie` TEXT column
 * and unpacks it on read. This module is the ONLY reader/writer of that
 * column -- nothing else in src/db or src/api should parse it directly.
 */

import { getSession as dbGetSession, setSession as dbSetSession, type DbEnv } from './db';
import type { SessionRecord, SessionStore } from './api/session';

interface PackedSession {
  cookie: string;
  csrfToken?: string;
  entry?: number;
  fetchedAt: number;
}

function isPackedSession(v: unknown): v is PackedSession {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).cookie === 'string' &&
    typeof (v as Record<string, unknown>).fetchedAt === 'number'
  );
}

export function createSessionStore(env: DbEnv): SessionStore {
  return {
    async getSession(): Promise<SessionRecord | null> {
      const row = await dbGetSession(env.DB);
      if (!row?.cookie) return null;
      try {
        const parsed: unknown = JSON.parse(row.cookie);
        if (isPackedSession(parsed)) {
          return {
            cookie: parsed.cookie,
            csrfToken: parsed.csrfToken,
            entry: parsed.entry,
            fetchedAt: parsed.fetchedAt,
          };
        }
      } catch {
        // Not JSON -- fall through to treating the column as a bare cookie
        // string (e.g. a value written before this packing scheme existed).
      }
      return { cookie: row.cookie, fetchedAt: 0 };
    },

    async saveSession(record: SessionRecord): Promise<void> {
      const packed: PackedSession = {
        cookie: record.cookie,
        csrfToken: record.csrfToken,
        entry: record.entry,
        fetchedAt: record.fetchedAt,
      };
      await dbSetSession(env.DB, {
        cookie: JSON.stringify(packed),
        expiresAt: null,
        lastOkAt: new Date(record.fetchedAt).toISOString(),
      });
    },
  };
}
