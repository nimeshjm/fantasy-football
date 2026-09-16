import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import { toBit, toBool, type UefaAppearanceRow } from './types';

const COLUMNS = [
  'element_id',
  'fixture_id',
  'competition',
  'opponent',
  'kickoff_time',
  'started',
  'subbed_off_minute',
  'minutes_played',
  'fetched_at',
] as const;

/** `fetched_at` is set unconditionally on every write and MUST stay out of
 * the guard (see bulk.ts's doc comment) -- it is excluded here, not just
 * `element_id`/`fixture_id`. One consequence worth calling out: since a
 * re-upsert of an unchanged appearance is a guarded no-op, `fetched_at`
 * stays at whatever value it had on the row's FIRST write, not the most
 * recent fetch that merely reconfirmed the same data. Treat it as "first
 * stored at", not "last fetched at". */
const SPEC: JsonUpsertSpec = {
  table: 'uefa_appearances',
  columns: [...COLUMNS],
  conflictColumns: ['element_id', 'fixture_id'],
  guardColumns: [
    'competition',
    'opponent',
    'kickoff_time',
    'started',
    'subbed_off_minute',
    'minutes_played',
  ],
};

interface RawUefaAppearanceRow {
  element_id: number;
  fixture_id: number;
  competition: 'UCL' | 'UEL' | 'UECL';
  opponent: string;
  kickoff_time: string;
  started: number;
  subbed_off_minute: number | null;
  minutes_played: number;
  fetched_at: string;
}

function fromRaw(row: RawUefaAppearanceRow): UefaAppearanceRow {
  return {
    elementId: row.element_id,
    fixtureId: row.fixture_id,
    competition: row.competition,
    opponent: row.opponent,
    kickoffTime: row.kickoff_time,
    started: toBool(row.started),
    subbedOffMinute: row.subbed_off_minute,
    minutesPlayed: row.minutes_played,
    fetchedAt: row.fetched_at,
  };
}

function toRaw(row: UefaAppearanceRow): RawUefaAppearanceRow {
  return {
    element_id: row.elementId,
    fixture_id: row.fixtureId,
    competition: row.competition,
    opponent: row.opponent,
    kickoff_time: row.kickoffTime,
    started: toBit(row.started),
    subbed_off_minute: row.subbedOffMinute,
    minutes_played: row.minutesPlayed,
    fetched_at: row.fetchedAt,
  };
}

/** Batched upsert of UEFA appearances (see bulk.ts for why this goes through
 * the JSON path rather than per-row statements). Skips rows whose
 * competition/opponent/kickoff/started/subbed-off/minutes are unchanged from
 * what's stored -- the common case when a fixture already ingested gets
 * re-polled -- so `fetched_at` on those rows keeps its first-seen value
 * rather than being bumped on every re-fetch. */
export async function upsertUefaAppearances(
  db: D1Database,
  rows: readonly UefaAppearanceRow[],
): Promise<void> {
  const raw = rows.map(toRaw);
  const statements = buildChunkedJsonUpserts(db, SPEC, raw);
  if (statements.length > 0) await db.batch(statements);
}

/** Every stored UEFA appearance for the given element ids, most-recent
 * kickoff first. Deliberately does not collapse to "one row per player":
 * the prompt-surfacing feature that needs the single most recent appearance
 * per player can just take the first row it sees for each `elementId` off
 * this ordering, so that logic doesn't need to live here too. */
export async function getUefaAppearancesForElements(
  db: D1Database,
  elementIds: readonly number[],
): Promise<UefaAppearanceRow[]> {
  if (elementIds.length === 0) return [];

  const placeholders = elementIds.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS.join(', ')} FROM uefa_appearances ` +
        `WHERE element_id IN (${placeholders}) ORDER BY kickoff_time DESC`,
    )
    .bind(...elementIds)
    .all<RawUefaAppearanceRow>();
  return results.map(fromRaw);
}

/** Cheap existence check for one (elementId, fixtureId) pair -- kept because
 * the contract names it explicitly, but prefer `hasUefaAppearances` below
 * when checking more than one pair: the ingest workflow's actual caller
 * checks a whole owned squad (~15 players) against a handful of fixtures
 * per tick, and one query beats one query per player. */
export async function hasUefaAppearance(
  db: D1Database,
  elementId: number,
  fixtureId: number,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM uefa_appearances WHERE element_id = ? AND fixture_id = ?')
    .bind(elementId, fixtureId)
    .first();
  return row !== null;
}

/** Batched existence check: which of the given (elementId, fixtureId) pairs
 * are already stored, as a `Set` of `"elementId:fixtureId"` keys the caller
 * can probe with the same key shape. This is the real fit for the ingest
 * workflow's "don't re-fetch a cached fixture's events" budget guard -- it
 * checks a whole squad against a handful of fixtures in one query rather
 * than one query per (player, fixture) pair, matching this codebase's
 * general preference for batched reads over N+1 loops (see bulk.ts). A
 * plain `IN` list is fine at this scale (a squad is ~15 players, never
 * anywhere near the 100-bound-parameter cap `bulk.ts` guards against). */
export async function hasUefaAppearances(
  db: D1Database,
  elementIds: readonly number[],
  fixtureIds: readonly number[],
): Promise<Set<string>> {
  if (elementIds.length === 0 || fixtureIds.length === 0) return new Set();

  const elementPlaceholders = elementIds.map(() => '?').join(', ');
  const fixturePlaceholders = fixtureIds.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      'SELECT element_id, fixture_id FROM uefa_appearances ' +
        `WHERE element_id IN (${elementPlaceholders}) AND fixture_id IN (${fixturePlaceholders})`,
    )
    .bind(...elementIds, ...fixtureIds)
    .all<{ element_id: number; fixture_id: number }>();
  return new Set(results.map((r) => `${r.element_id}:${r.fixture_id}`));
}
