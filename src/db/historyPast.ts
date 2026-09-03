import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import type { ElementHistoryPastRow } from './types';

const COLUMNS = [
  'element_code',
  'season_name',
  'total_points',
  'minutes',
  'goals_scored',
  'assists',
  'clean_sheets',
] as const;

const SPEC: JsonUpsertSpec = {
  table: 'element_history_past',
  columns: [...COLUMNS],
  conflictColumns: ['element_code', 'season_name'],
  // Past-season rows are immutable once the season is over; overwrite
  // unconditionally on conflict rather than compare every aggregate.
  guardColumns: [],
};

/** Upserts prior-season aggregates. Cheap and infrequent (once per element
 * per past season, not a daily job), so chunked the same way as everything
 * else for consistency rather than for budget reasons. */
export async function upsertElementHistoryPast(
  db: D1Database,
  rows: readonly ElementHistoryPastRow[],
): Promise<void> {
  const statements = buildChunkedJsonUpserts(db, SPEC, rows);
  if (statements.length > 0) await db.batch(statements);
}

export async function getHistoryPastForElement(
  db: D1Database,
  elementCode: number,
): Promise<ElementHistoryPastRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS.join(', ')} FROM element_history_past WHERE element_code = ? ORDER BY season_name`,
    )
    .bind(elementCode)
    .all<ElementHistoryPastRow>();
  return results;
}
