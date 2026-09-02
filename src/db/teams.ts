import type { Team } from '../types';
import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import type { TeamRow } from './types';

const SPEC: JsonUpsertSpec = {
  table: 'teams',
  columns: ['id', 'code', 'name', 'short_name'],
  conflictColumns: ['id'],
  guardColumns: ['code', 'name', 'short_name'],
};

/** Upserts all 18 Liga Portugal teams. Costs 1 D1 query (18 rows fits in a
 * single chunk). Skips rows whose code/name/short_name are unchanged. */
export async function upsertTeams(db: D1Database, teams: readonly Team[]): Promise<void> {
  const statements = buildChunkedJsonUpserts(db, SPEC, teams);
  if (statements.length > 0) await db.batch(statements);
}

export async function getTeams(db: D1Database): Promise<TeamRow[]> {
  const { results } = await db
    .prepare('SELECT id, code, name, short_name FROM teams ORDER BY id')
    .all<TeamRow>();
  return results;
}
