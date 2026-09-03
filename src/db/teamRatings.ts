import { buildChunkedJsonUpserts, type JsonUpsertSpec } from './bulk';
import { getConfig, setConfig } from './config';
import type { RatingsModel, TeamRating } from '../model/ratings';
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

// ---------------------------------------------------------------------------
// The whole model, not just the per-team half
// ---------------------------------------------------------------------------

/**
 * `expectedGoals` is
 * `leagueAvgGoals * homeAdvantage * attack[home] * defence[away]`, so the two
 * league-wide scalars are as load-bearing as the per-team ratings. The
 * `team_ratings` table holds only `attack`/`defence`; reconstructing a
 * `RatingsModel` from that table alone would leave every expected-goals
 * figure wrong by a constant multiplicative factor, silently and with no
 * error. Both scalars are therefore persisted alongside, in `config` (the
 * existing string k/v store -- two scalars do not warrant a table).
 */
const KEY_LEAGUE_AVG_GOALS = 'ratings_league_avg_goals';
const KEY_HOME_ADVANTAGE = 'ratings_home_advantage';

/** `fitTeamRatings`'s own no-data return values. Used as the fallback when a
 * scalar is missing or unparsable, so a half-written model degrades to the
 * neutral fit rather than to zero. */
const NEUTRAL_LEAGUE_AVG_GOALS = 1;
const NEUTRAL_HOME_ADVANTAGE = 1.15;

/**
 * Parses a persisted scalar. Rejects anything not positive-and-finite, for
 * the reason src/env.ts documents at length: `Number('')` is `0`, and a
 * `leagueAvgGoals` of 0 multiplies EVERY projection in the model to zero --
 * a silent, total model failure that looks like valid data.
 */
function parsePositiveScalar(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Persists a fitted `RatingsModel` in full: per-team rows plus the two
 * league-wide scalars. */
export async function saveRatingsModel(
  db: D1Database,
  model: RatingsModel,
  updatedAt: string,
): Promise<void> {
  const rows = [...model.ratings.entries()].map(([team_id, r]) => ({
    team_id,
    attack: r.attack,
    defence: r.defence,
  }));
  await upsertTeamRatings(db, rows, updatedAt);
  await setConfig(db, KEY_LEAGUE_AVG_GOALS, String(model.leagueAvgGoals));
  await setConfig(db, KEY_HOME_ADVANTAGE, String(model.homeAdvantage));
}

/**
 * Reads back a full `RatingsModel`. An empty `team_ratings` table yields an
 * empty ratings map, which `expectedGoals` already handles by treating every
 * team as exactly league-average -- the correct behaviour before any fixture
 * has been played, and not an error.
 */
export async function loadRatingsModel(db: D1Database): Promise<RatingsModel> {
  const [rows, leagueAvgRaw, homeAdvRaw] = await Promise.all([
    getTeamRatings(db),
    getConfig(db, KEY_LEAGUE_AVG_GOALS),
    getConfig(db, KEY_HOME_ADVANTAGE),
  ]);
  const ratings = new Map<number, TeamRating>(
    rows.map((r) => [r.team_id, { attack: r.attack, defence: r.defence }] as const),
  );
  return {
    ratings,
    leagueAvgGoals: parsePositiveScalar(leagueAvgRaw, NEUTRAL_LEAGUE_AVG_GOALS),
    homeAdvantage: parsePositiveScalar(homeAdvRaw, NEUTRAL_HOME_ADVANTAGE),
  };
}
