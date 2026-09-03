/**
 * The scoring function. Single source of truth for how points are awarded.
 *
 * `game_config.scoring` from bootstrap-static gives per-unit coefficients but
 * OMITS the divisors, which makes it misleading if taken at face value. The
 * rules below were recovered empirically by aggregating every
 * `explain[].stats[]` block returned by `GET /api/event/{1..4}/live/` across all
 * 656 players and reading off the observed value -> points mapping.
 *
 * Divisors that differ from Fantasy Premier League, and therefore from most
 * intuitions about this game:
 *
 *   saves            floor(n / 2)   [FPL is floor(n / 3)]
 *   shots_on_target  floor(n / 2)   [FPL awards nothing for shots at all]
 *   goals_conceded   -floor(n / 2)  [GK and DEF only]
 *
 * Because shots on target and saves score at floor(n/2), shot-volume forwards
 * and high-workload goalkeepers are worth materially more here than in FPL, and
 * attacking defenders pick up shot points too.
 *
 * Observed evidence for each rule is in the table in test/scoring.test.ts.
 */

import { Position, type RawStats } from './types';

/** Points for a goal, by position. */
export const GOAL_POINTS: Record<Position, number> = {
  [Position.GK]: 6,
  [Position.DEF]: 6,
  [Position.MID]: 5,
  [Position.FWD]: 4,
};

/** Points for a clean sheet, by position. */
export const CLEAN_SHEET_POINTS: Record<Position, number> = {
  [Position.GK]: 4,
  [Position.DEF]: 4,
  [Position.MID]: 1,
  [Position.FWD]: 0,
};

/** Positions penalised for goals conceded. */
export const CONCEDE_PENALISED: ReadonlySet<Position> = new Set([Position.GK, Position.DEF]);

export const APPEARANCE_SHORT = 1;
export const APPEARANCE_LONG = 2;
/** Minutes at or above this earn APPEARANCE_LONG rather than APPEARANCE_SHORT. */
export const LONG_PLAY_MINUTES = 60;

export const ASSIST_POINTS = 3;
export const PENALTY_SAVE_POINTS = 5;
export const PENALTY_MISS_POINTS = -2;
export const OWN_GOAL_POINTS = -2;
export const YELLOW_CARD_POINTS = -1;
export const RED_CARD_POINTS = -3;
export const WINNING_GOAL_POINTS = 1;
export const ATTACKING_BONUS_POINTS = 1;
export const DEFENDING_BONUS_POINTS = 1;

/** Every counter that scores as floor(n / 2). */
export const SAVES_PER_POINT = 2;
export const SHOTS_ON_TARGET_PER_POINT = 2;
export const CONCEDED_PER_PENALTY = 2;

/**
 * Points earned by one player in ONE FIXTURE from that fixture's stat line.
 *
 * The fixture boundary matters and is not cosmetic. Appearance points are
 * per-fixture and the floor() divisors do not distribute over addition:
 * a player with 3 saves in each of two fixtures earns floor(3/2)*2 = 2, not
 * floor(6/2) = 3. Passing a gameweek-aggregated stat line here silently
 * overpays saves/shots and underpays appearances whenever a gameweek contains a
 * rescheduled second fixture. Use `scoreGameweek` for a gameweek total.
 *
 * (GW1-4 of 2026/27 happen to have exactly one fixture per player, so the
 * golden test replays at fixture level and would not catch this on its own.)
 *
 * `stats.clean_sheets` already encodes the 60-minute eligibility rule server
 * side (it is 0 for a sub who came on late into a goalless game), so it is
 * multiplied through directly rather than re-gated on minutes here.
 *
 * key_passes, recoveries and clearances_blocks_interceptions award nothing
 * directly — they are the provider's inputs to the attacking_bonus and
 * defending_bonus counts, which arrive already computed.
 */
export function scoreFixture(stats: RawStats, position: Position): number {
  // Appearance points require minutes on the pitch, but NOTHING else does.
  // An unused substitute booked on the bench scores -1 (verified: GW4 element
  // 329, a goalkeeper with 0 minutes and a yellow card, total_points -1). An
  // early return on minutes <= 0 gets that row wrong.
  let points = 0;
  if (stats.minutes > 0) {
    points += stats.minutes >= LONG_PLAY_MINUTES ? APPEARANCE_LONG : APPEARANCE_SHORT;
  }

  points += stats.goals_scored * GOAL_POINTS[position];
  points += stats.assists * ASSIST_POINTS;
  points += stats.clean_sheets * CLEAN_SHEET_POINTS[position];

  if (CONCEDE_PENALISED.has(position)) {
    points -= Math.floor(stats.goals_conceded / CONCEDED_PER_PENALTY);
  }

  points += Math.floor(stats.saves / SAVES_PER_POINT);
  points += Math.floor(stats.shots_on_target / SHOTS_ON_TARGET_PER_POINT);

  points += stats.penalties_saved * PENALTY_SAVE_POINTS;
  points += stats.penalties_missed * PENALTY_MISS_POINTS;
  points += stats.own_goals * OWN_GOAL_POINTS;
  points += stats.yellow_cards * YELLOW_CARD_POINTS;
  points += stats.red_cards * RED_CARD_POINTS;
  points += stats.winning_goals * WINNING_GOAL_POINTS;
  points += stats.attacking_bonus * ATTACKING_BONUS_POINTS;
  points += stats.defending_bonus * DEFENDING_BONUS_POINTS;

  return points;
}

/**
 * Points earned by one player across a whole gameweek.
 *
 * Takes one stat line PER FIXTURE played in that gameweek (normally one, two in
 * a rescheduled double). Never pass a pre-summed stat line — see `scoreFixture`.
 */
export function scoreGameweek(perFixture: readonly RawStats[], position: Position): number {
  let total = 0;
  for (const stats of perFixture) {
    total += scoreFixture(stats, position);
  }
  return total;
}
