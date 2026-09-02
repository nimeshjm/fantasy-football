import type { Fixture } from '../types';
import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import { toBit, toBool, type FixtureRow } from './types';

const COLUMNS = [
  'id',
  'code',
  'event',
  'team_h',
  'team_a',
  'team_h_score',
  'team_a_score',
  'kickoff_time',
  'started',
  'finished',
  'minutes',
] as const;

const SPEC: JsonUpsertSpec = {
  table: 'fixtures',
  columns: [...COLUMNS],
  conflictColumns: ['id'],
  guardColumns: COLUMNS.filter((c) => c !== 'id'),
};

interface RawFixtureRow {
  id: number;
  code: number;
  event: number | null;
  team_h: number;
  team_a: number;
  team_h_score: number | null;
  team_a_score: number | null;
  kickoff_time: string | null;
  started: number;
  finished: number;
  minutes: number;
}

function fromRaw(row: RawFixtureRow): FixtureRow {
  return { ...row, started: toBool(row.started), finished: toBool(row.finished) };
}

/** Upserts a batch of fixtures (a season is ~306 rows for 18 teams --
 * 4 statements at the default chunk size). Skips fixtures whose score/state
 * are unchanged, which is the common case for a fixture list re-polled
 * before kickoff. */
export async function upsertFixtures(db: D1Database, fixtures: readonly Fixture[]): Promise<void> {
  const rows = fixtures.map((f) => ({
    ...f,
    started: toBit(f.started),
    finished: toBit(f.finished),
  }));
  const statements = buildChunkedJsonUpserts(db, SPEC, rows);
  if (statements.length > 0) await db.batch(statements);
}

export async function getFixturesForEvent(db: D1Database, event: number): Promise<FixtureRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM fixtures WHERE event = ? ORDER BY kickoff_time`)
    .bind(event)
    .all<RawFixtureRow>();
  return results.map(fromRaw);
}

export async function getFixtureById(db: D1Database, id: number): Promise<FixtureRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS.join(', ')} FROM fixtures WHERE id = ?`)
    .bind(id)
    .first<RawFixtureRow>();
  return row === null ? null : fromRaw(row);
}
