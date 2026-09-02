import type { Projection } from '../types';
import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import type { ProjectionRow } from './types';

const COLUMNS = ['element_id', 'event', 'xmins', 'xpts', 'computed_at'] as const;

const SPEC: JsonUpsertSpec = {
  table: 'projections',
  columns: [...COLUMNS],
  conflictColumns: ['element_id', 'event'],
  guardColumns: ['xmins', 'xpts'],
};

/** Upserts one gameweek's projections (up to ~656 rows -- 7 D1 queries at
 * the default chunk size, in one `db.batch()` call). Skips projections
 * whose xmins/xpts haven't moved since the last computation. */
export async function upsertProjections(
  db: D1Database,
  projections: readonly Projection[],
  computedAt: string,
): Promise<void> {
  const rows = projections.map((p) => ({ ...p, computed_at: computedAt }));
  const statements = buildChunkedJsonUpserts(db, SPEC, rows);
  if (statements.length > 0) await db.batch(statements);
}

/** Used by getProjectionsForEvent()'s caller to read every player's
 * projection for one gameweek -- served by idx_projections_event. */
export async function getProjectionsForEvent(
  db: D1Database,
  event: number,
): Promise<ProjectionRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM projections WHERE event = ?`)
    .bind(event)
    .all<ProjectionRow>();
  return results;
}

export async function getProjection(
  db: D1Database,
  elementId: number,
  event: number,
): Promise<ProjectionRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM projections WHERE element_id = ? AND event = ?`)
    .bind(elementId, event)
    .first<ProjectionRow>();
  return row;
}
