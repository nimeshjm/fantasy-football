import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import { type PlayerAwardRow } from './types';

const COLUMNS = [
  'element_id',
  'award_type',
  'period_key',
  'fixture_id',
  'source_player_name',
  'fetched_at',
] as const;

const SPEC: JsonUpsertSpec = {
  table: 'player_awards',
  columns: [...COLUMNS],
  conflictColumns: ['award_type', 'period_key', 'element_id'],
  guardColumns: ['fixture_id', 'source_player_name'],
};

export async function initPlayerAwardsTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS player_awards (' +
        'element_id INTEGER NOT NULL, ' +
        'award_type TEXT NOT NULL, ' +
        'period_key TEXT NOT NULL, ' +
        'fixture_id INTEGER, ' +
        'source_player_name TEXT NOT NULL, ' +
        'fetched_at TEXT NOT NULL, ' +
        'PRIMARY KEY (award_type, period_key, element_id))',
    )
    .run();
}

export async function upsertPlayerAwards(
  db: D1Database,
  rows: readonly PlayerAwardRow[],
): Promise<void> {
  await initPlayerAwardsTable(db);
  const statements = buildChunkedJsonUpserts(db, SPEC, rows);
  if (statements.length > 0) await db.batch(statements);
}

export async function getPlayerAwardsForElements(
  db: D1Database,
  elementIds: readonly number[],
): Promise<PlayerAwardRow[]> {
  if (elementIds.length === 0) return [];

  const placeholders = elementIds.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS.join(', ')} FROM player_awards ` +
        `WHERE element_id IN (${placeholders}) ORDER BY period_key DESC`,
    )
    .bind(...elementIds)
    .all<PlayerAwardRow>();
  return results;
}
