import type { RawStats } from '../types';
import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import type { GwStatsRow } from './types';

const RAW_STAT_COLUMNS = [
  'minutes',
  'goals_scored',
  'assists',
  'clean_sheets',
  'goals_conceded',
  'penalties_saved',
  'penalties_missed',
  'yellow_cards',
  'red_cards',
  'saves',
  'own_goals',
  'attacking_bonus',
  'defending_bonus',
  'winning_goals',
  'key_passes',
  'clearances_blocks_interceptions',
  'recoveries',
  'shots_on_target',
] as const satisfies readonly (keyof RawStats)[];

const COLUMNS = ['element_id', 'event', 'fixture_id', ...RAW_STAT_COLUMNS, 'total_points'] as const;

const SPEC: JsonUpsertSpec = {
  table: 'element_gw_stats',
  columns: [...COLUMNS],
  conflictColumns: ['element_id', 'event', 'fixture_id'],
  guardColumns: [...RAW_STAT_COLUMNS, 'total_points'],
};

/**
 * Upserts one gameweek's worth of per-fixture stat lines (up to ~656 rows,
 * one per element that appeared). At UPSERT_CHUNK_SIZE=100 this is
 * `ceil(rows.length/100)` D1 queries -- 7 for a full gameweek -- in one
 * `db.batch()` call. A stat line that hasn't changed since the last poll
 * (common while a match is still in progress and gets re-polled) is skipped
 * by the WHERE guard.
 */
export async function upsertGwStats(db: D1Database, rows: readonly GwStatsRow[]): Promise<void> {
  const statements = buildChunkedJsonUpserts(db, SPEC, rows);
  if (statements.length > 0) await db.batch(statements);
}

export async function getGwStatsForEvent(db: D1Database, event: number): Promise<GwStatsRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM element_gw_stats WHERE event = ?`)
    .bind(event)
    .all<GwStatsRow>();
  return results;
}

export async function getGwStatsForElement(
  db: D1Database,
  elementId: number,
): Promise<GwStatsRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS.join(', ')} FROM element_gw_stats WHERE element_id = ? ORDER BY event`,
    )
    .bind(elementId)
    .all<GwStatsRow>();
  return results;
}

/**
 * Every stat line from `minEvent` onward, across all players, oldest event
 * first. This is the trailing window `model-v2` needs: it fits per-90 rates
 * from recent form, so it needs the last N gameweeks for the WHOLE candidate
 * pool, which neither `getGwStatsForEvent` (one event, all players) nor
 * `getGwStatsForElement` (all events, one player) can serve without N or
 * ~656 separate queries.
 *
 * One query, ~656 rows per gameweek in the window. Ordered by event so
 * callers can group into `ProjectionOptions.trailingStatsByElement` -- which
 * is documented as oldest-first -- without re-sorting.
 */
export async function getGwStatsSince(db: D1Database, minEvent: number): Promise<GwStatsRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS.join(', ')} FROM element_gw_stats WHERE event >= ? ORDER BY event, element_id`,
    )
    .bind(minEvent)
    .all<GwStatsRow>();
  return results;
}
