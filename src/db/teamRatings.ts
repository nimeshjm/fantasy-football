import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import type { TeamRatingRow } from './types';

const COLUMNS = ['team_id', 'attack', 'defence', 'updated_at'] as const;

const SPEC: JsonUpsertSpec = {
  table: 'team_ratings',
  columns: [...COLUMNS],
  conflictColumns: ['team_id'],
  guardColumns: ['attack', 'defence'],
};

/** Upserts computed attack/defence ratings for all teams (18 rows, 1 D1
 * query). Skips teams whose rating hasn't moved since the last computation. */
export async function upsertTeamRatings(
  db: D1Database,
  ratings: readonly Omit<TeamRatingRow, 'updated_at'>[],
  updatedAt: string,
): Promise<void> {
  const rows = ratings.map((r) => ({ ...r, updated_at: updatedAt }));
  const statements = buildChunkedJsonUpserts(db, SPEC, rows);
  if (statements.length > 0) await db.batch(statements);
}

export async function getTeamRatings(db: D1Database): Promise<TeamRatingRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM team_ratings ORDER BY team_id`)
    .all<TeamRatingRow>();
  return results;
}
