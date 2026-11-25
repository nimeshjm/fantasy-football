import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import type { PlayerAwardRow } from './types';

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
  columns: COLUMNS,
  conflictColumns: ['award_type', 'period_key', 'element_id'],
  guardColumns: ['fixture_id', 'source_player_name'],
};

interface RawPlayerAwardRow {
  element_id: number;
  award_type: string;
  period_key: string;
  fixture_id: number | null;
  source_player_name: string;
  fetched_at: string;
}

function toRaw(row: PlayerAwardRow): RawPlayerAwardRow {
  return {
    element_id: row.elementId,
    award_type: row.awardType,
    period_key: row.periodKey,
    fixture_id: row.fixtureId,
    source_player_name: row.sourcePlayerName,
    fetched_at: row.fetchedAt,
  };
}

function fromRaw(raw: RawPlayerAwardRow): PlayerAwardRow {
  return {
    elementId: raw.element_id,
    awardType: raw.award_type,
    periodKey: raw.period_key,
    fixtureId: raw.fixture_id,
    sourcePlayerName: raw.source_player_name,
    fetchedAt: raw.fetched_at,
  };
}

export async function upsertPlayerAwards(
  db: D1Database,
  rows: readonly PlayerAwardRow[],
): Promise<void> {
  if (rows.length === 0) return;

  const statements = buildChunkedJsonUpserts(db, SPEC, rows.map(toRaw));
  await db.batch(statements);
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
        `WHERE element_id IN (${placeholders}) ORDER BY fetched_at DESC`,
    )
    .bind(...elementIds)
    .all<RawPlayerAwardRow>();
  return results.map(fromRaw);
}

export async function getPlayerAwardsByPeriod(
  db: D1Database,
  awardType: string,
  periodKey: string,
): Promise<PlayerAwardRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS.join(', ')} FROM player_awards ` +
        'WHERE award_type = ? AND period_key = ? ORDER BY element_id ASC',
    )
    .bind(awardType, periodKey)
    .all<RawPlayerAwardRow>();
  return results.map(fromRaw);
}
