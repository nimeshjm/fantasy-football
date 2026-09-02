/**
 * Per-player expected points for an upcoming gameweek.
 *
 * Two strategies are exported, selectable by name, and BOTH are kept:
 *
 *  - `'ep-next'` (v1): trust the site's own `ep_next` field. Ship this
 *    first, keep it forever as a cheap sanity baseline / fallback.
 *  - `'model-v2'`: xMins from availability signals, per-90 rates over a
 *    trailing window shrunk toward positional priors, fixture-adjusted via
 *    `ratings.ts`.
 *
 * ---------------------------------------------------------------------
 * THE CRITICAL CORRECTNESS REQUIREMENT (read this before touching v2):
 *
 * `saves`, `shots_on_target` and `goals_conceded` all score as
 * `floor(n / 2)` (see scoring.ts). For a random count X (modelled here as
 * Poisson), `E[floor(X/2)] != floor(E[X]/2)` -- floor is not linear, and
 * plugging the mean straight into floor() systematically MISPRICES exactly
 * the goalkeepers and shot-volume forwards this scoring system rewards
 * (their points come in lumpy floor(n/2) steps, not smoothly). Every
 * expectation over one of these three stats in this file goes through
 * `poissonFloorDivExpectation`, which sums `P(X=k) * floor(k/2)` over the
 * count distribution instead. See test/model.test.ts for the correctness
 * tests this is held to.
 * ---------------------------------------------------------------------
 */

import {
  APPEARANCE_LONG,
  APPEARANCE_SHORT,
  ASSIST_POINTS,
  CLEAN_SHEET_POINTS,
  CONCEDE_PENALISED,
  GOAL_POINTS,
  LONG_PLAY_MINUTES,
  RED_CARD_POINTS,
  YELLOW_CARD_POINTS,
} from '../scoring';
import { Position, type Element, type GwStats, type Projection } from '../types';
import { expectedGoals, type RatingsModel } from './ratings';

export const STRATEGY_EP_NEXT = 'ep-next' as const;
export const STRATEGY_MODEL_V2 = 'model-v2' as const;
export type ProjectionStrategy = typeof STRATEGY_EP_NEXT | typeof STRATEGY_MODEL_V2;

/** A player's team has exactly this one fixture in the target gameweek.
 * Blank gameweeks are represented by the team being absent from the map;
 * double gameweeks are not modelled here (the fixture list this project
 * runs against has never shown one -- see scoring.ts's fixture-boundary
 * note) -- a future double-GW extension would widen this to an array. */
export interface UpcomingFixtureInfo {
  opponent: number;
  isHome: boolean;
}

export interface ProjectionOptions {
  strategy?: ProjectionStrategy;
  /** Team ratings from `fitTeamRatings`. Required (and used) only by
   * `'model-v2'`. */
  ratings?: RatingsModel;
  /** This gameweek's fixture per team, keyed by team id. A team missing
   * from the map is treated as having a blank gameweek: v2 projects 0
   * xmins / 0 xpts for its players regardless of anything else. */
  fixturesByTeam?: ReadonlyMap<number, UpcomingFixtureInfo>;
  /** Recent per-fixture stat lines for each player, keyed by element id,
   * oldest first. Only the last `trailingWindow` entries are used. */
  trailingStatsByElement?: ReadonlyMap<number, readonly GwStats[]>;
  /** How many trailing fixtures to look back over. Only 4 gameweeks of
   * data exist for a fresh season, so the default is small on purpose. */
  trailingWindow?: number;
  /** Shrinkage strength for per-90 rate priors, expressed as minutes of
   * "average player" evidence blended in. 270 minutes = 3 full matches'
   * worth of prior pull, which dominates early in a season when a player
   * might have only 1-4 matches of real data. */
  shrinkagePseudoMinutes?: number;
  /** Truncation cap for the floor(n/2) count-distribution sums. See
   * `poissonFloorDivExpectation`. */
  kMaxPoisson?: number;
  /** Assumed minutes for a fully fit, undoubted starter with no minutes
   * history to go on yet (a fresh signing, or GW1 with no trailing data). */
  baseMinutesIfFit?: number;
}

const DEFAULT_TRAILING_WINDOW = 6;
const DEFAULT_SHRINKAGE_PSEUDO_MINUTES = 270;
const DEFAULT_K_MAX_POISSON = 20;
const DEFAULT_BASE_MINUTES_IF_FIT = 75;

/**
 * Rough per-90 priors by position. These are NOT fit from
 * `element_history_past` -- `shots_on_target` and `recoveries` are 0 for
 * every player in that table because last season didn't track them, so
 * treating that column as a prior would silently teach the model "nobody
 * ever has a shot on target". Instead these are hand-set league-typical
 * rates, and `shotsOnTargetPer90`/`savesPer90` specifically are additionally
 * scaled by price (see `priceFactor`) as the brief requires, precisely
 * because there is no non-zero historical column to fall back on for them.
 */
interface PositionPriors {
  goalsPer90: number;
  assistsPer90: number;
  shotsOnTargetPer90: number;
  savesPer90: number;
  yellowPer90: number;
  redPer90: number;
}

const POSITION_PRIORS: Record<Position, PositionPriors> = {
  [Position.GK]: {
    goalsPer90: 0,
    assistsPer90: 0.01,
    shotsOnTargetPer90: 0,
    savesPer90: 2.2,
    yellowPer90: 0.08,
    redPer90: 0.01,
  },
  [Position.DEF]: {
    goalsPer90: 0.03,
    assistsPer90: 0.05,
    shotsOnTargetPer90: 0.3,
    savesPer90: 0,
    yellowPer90: 0.18,
    redPer90: 0.01,
  },
  [Position.MID]: {
    goalsPer90: 0.12,
    assistsPer90: 0.12,
    shotsOnTargetPer90: 0.7,
    savesPer90: 0,
    yellowPer90: 0.15,
    redPer90: 0.01,
  },
  [Position.FWD]: {
    goalsPer90: 0.35,
    assistsPer90: 0.1,
    shotsOnTargetPer90: 1.3,
    savesPer90: 0,
    yellowPer90: 0.12,
    redPer90: 0.01,
  },
};

/**
 * E[floor(X / divisor)] for X ~ Poisson(lambda), computed by summing the
 * count distribution rather than plugging the mean into floor() -- see the
 * module-level correctness note. `divisor` is 2 for every stat currently in
 * scoring.ts, but this stays general rather than hardcoding that.
 *
 * Truncated at `kMax` (default 20): the omitted tail mass `P(X > kMax)` for
 * the lambdas this module ever produces (single-fixture goal/save/shot
 * counts, realistically < 8) is below 1e-9 at kMax=20, negligible next to
 * everything else being estimated in this pipeline.
 */
export function poissonFloorDivExpectation(
  lambda: number,
  divisor: number,
  kMax: number = DEFAULT_K_MAX_POISSON,
): number {
  if (lambda <= 0) return 0;
  let pmf = Math.exp(-lambda); // P(X = 0)
  let expectation = 0; // floor(0 / divisor) contributes 0
  for (let k = 1; k <= kMax; k++) {
    pmf = (pmf * lambda) / k; // recurrence: P(X=k) = P(X=k-1) * lambda / k
    expectation += pmf * Math.floor(k / divisor);
  }
  return expectation;
}

/** Bayesian-shrunk per-90 rate: blends `pseudoMinutes` of "average player"
 * evidence (at `priorPer90`) with the observed count over `observedMinutes`.
 * Equivalent to adding `pseudoMinutes` of playing time at exactly the prior
 * rate before computing the ratio -- pulls small samples hard toward the
 * prior and lets large samples dominate their own estimate. */
function shrinkRatePer90(
  observedCount: number,
  observedMinutes: number,
  priorPer90: number,
  pseudoMinutes: number,
): number {
  const numerator = observedCount + priorPer90 * (pseudoMinutes / 90);
  const denominator = observedMinutes / 90 + pseudoMinutes / 90;
  return denominator > 0 ? numerator / denominator : priorPer90;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Naive availability-only minutes estimate used by the v1 (`ep-next`)
 * strategy, which doesn't otherwise touch minutes modelling at all. Also
 * the fallback for v2 when no trailing minutes history is available. */
function estimateXMinsFromAvailability(element: Element, baseMinutesIfFit: number): number {
  if (element.status === 'u') return 0; // unavailable for the season/long-term
  const chance = element.chance_of_playing_next_round;
  if (chance !== null) return (chance / 100) * baseMinutesIfFit;
  return element.status === 'a' ? baseMinutesIfFit : baseMinutesIfFit * 0.25;
}

/** v2 minutes estimate: blends the player's own recent minutes-when-used
 * with the availability signal above. `trailing` is already sliced to the
 * lookback window and ordered oldest-first. */
function estimateXMinsV2(
  element: Element,
  trailing: readonly GwStats[],
  baseMinutesIfFit: number,
): number {
  const availability = estimateXMinsFromAvailability(element, baseMinutesIfFit);
  if (trailing.length === 0) return availability;

  const appearances = trailing.filter((g) => g.minutes > 0);
  const appearanceRate = appearances.length / trailing.length;
  const avgMinutesWhenUsed =
    appearances.length > 0
      ? appearances.reduce((sum, g) => sum + g.minutes, 0) / appearances.length
      : 0;

  // Shrink the "minutes when used" estimate toward the generic baseline
  // with a small pseudo-sample so 1 game of data isn't taken at face value.
  const pseudoGames = 2;
  const shrunkMinutesWhenUsed =
    (avgMinutesWhenUsed * appearances.length + baseMinutesIfFit * pseudoGames) /
    (appearances.length + pseudoGames);

  // Availability (status/chance-of-playing) caps the upside; recent
  // appearance rate captures rotation risk that status alone won't show.
  const availabilityFactor = clamp(availability / baseMinutesIfFit, 0, 1);
  return shrunkMinutesWhenUsed * appearanceRate * availabilityFactor;
}

function sumStat(stats: readonly GwStats[], pick: (g: GwStats) => number): number {
  let total = 0;
  for (const g of stats) total += pick(g);
  return total;
}

/** v1: the site's own next-gameweek expected points. Kept as the shippable
 * baseline and the fallback strategy -- see module doc. */
function projectEpNext(element: Element, event: number, baseMinutesIfFit: number): Projection {
  const parsed = element.ep_next !== null ? Number.parseFloat(element.ep_next) : NaN;
  const xpts = Number.isFinite(parsed) ? parsed : 0;
  return {
    element_id: element.id,
    event,
    xmins: estimateXMinsFromAvailability(element, baseMinutesIfFit),
    xpts,
  };
}

function projectModelV2(
  element: Element,
  event: number,
  opts: Required<
    Pick<
      ProjectionOptions,
      'trailingWindow' | 'shrinkagePseudoMinutes' | 'kMaxPoisson' | 'baseMinutesIfFit'
    >
  >,
  positionAvgCost: Readonly<Record<Position, number>>,
  ratings: RatingsModel | undefined,
  fixturesByTeam: ReadonlyMap<number, UpcomingFixtureInfo> | undefined,
  trailingStatsByElement: ReadonlyMap<number, readonly GwStats[]> | undefined,
): Projection {
  const fixture = fixturesByTeam?.get(element.team);
  if (!fixture) {
    // Blank gameweek for this team: nothing to project.
    return { element_id: element.id, event, xmins: 0, xpts: 0 };
  }

  const allTrailing = trailingStatsByElement?.get(element.id) ?? [];
  const trailing = allTrailing.slice(-opts.trailingWindow);
  const xmins = estimateXMinsV2(element, trailing, opts.baseMinutesIfFit);
  if (xmins <= 0) return { element_id: element.id, event, xmins: 0, xpts: 0 };

  const position = element.element_type;
  const priors = POSITION_PRIORS[position];
  const avgCost = positionAvgCost[position] > 0 ? positionAvgCost[position] : element.now_cost;
  // Price factor only touches shots-on-target and saves priors, per the
  // brief: those two have no valid historical column to prior from (both
  // are 0 in element_history_past for last season), so price stands in as
  // the proxy for "shoots a lot" / "faces a lot of shots and is trusted to
  // start" that a real per-90 history would otherwise give us.
  const priceFactor = clamp(element.now_cost / avgCost, 0.6, 1.8);

  const observedMinutes = sumStat(trailing, (g) => g.minutes);
  const goalsPer90 = shrinkRatePer90(
    sumStat(trailing, (g) => g.goals_scored),
    observedMinutes,
    priors.goalsPer90,
    opts.shrinkagePseudoMinutes,
  );
  const assistsPer90 = shrinkRatePer90(
    sumStat(trailing, (g) => g.assists),
    observedMinutes,
    priors.assistsPer90,
    opts.shrinkagePseudoMinutes,
  );
  const shotsOnTargetPer90 = shrinkRatePer90(
    sumStat(trailing, (g) => g.shots_on_target),
    observedMinutes,
    priors.shotsOnTargetPer90 * priceFactor,
    opts.shrinkagePseudoMinutes,
  );
  const savesPer90 = shrinkRatePer90(
    sumStat(trailing, (g) => g.saves),
    observedMinutes,
    priors.savesPer90 * priceFactor,
    opts.shrinkagePseudoMinutes,
  );
  const yellowPer90 = shrinkRatePer90(
    sumStat(trailing, (g) => g.yellow_cards),
    observedMinutes,
    priors.yellowPer90,
    opts.shrinkagePseudoMinutes,
  );
  const redPer90 = shrinkRatePer90(
    sumStat(trailing, (g) => g.red_cards),
    observedMinutes,
    priors.redPer90,
    opts.shrinkagePseudoMinutes,
  );

  const minutesFactor = xmins / 90;

  let attackFactor = 1;
  let opponentGoalsExpected = 1;
  if (ratings) {
    const homeTeam = fixture.isHome ? element.team : fixture.opponent;
    const awayTeam = fixture.isHome ? fixture.opponent : element.team;
    const eg = expectedGoals(ratings, homeTeam, awayTeam);
    const teamGoalsExpected = fixture.isHome ? eg.home : eg.away;
    opponentGoalsExpected = fixture.isHome ? eg.away : eg.home;
    attackFactor = ratings.leagueAvgGoals > 0 ? teamGoalsExpected / ratings.leagueAvgGoals : 1;
  }

  const lambdaGoals = goalsPer90 * minutesFactor * attackFactor;
  const lambdaAssists = assistsPer90 * minutesFactor * attackFactor;
  const lambdaShotsOnTarget = shotsOnTargetPer90 * minutesFactor * attackFactor;
  const lambdaSaves =
    savesPer90 * minutesFactor * (opponentGoalsExpected / (ratings?.leagueAvgGoals || 1));
  const lambdaYellow = yellowPer90 * minutesFactor;
  const lambdaRed = redPer90 * minutesFactor;

  let xpts = 0;
  xpts += xmins >= LONG_PLAY_MINUTES ? APPEARANCE_LONG : xmins > 0 ? APPEARANCE_SHORT : 0;
  xpts += lambdaGoals * GOAL_POINTS[position];
  xpts += lambdaAssists * ASSIST_POINTS;
  xpts += poissonFloorDivExpectation(lambdaShotsOnTarget, 2, opts.kMaxPoisson);
  if (position === Position.GK) {
    xpts += poissonFloorDivExpectation(lambdaSaves, 2, opts.kMaxPoisson);
  }
  xpts += lambdaYellow * YELLOW_CARD_POINTS;
  xpts += lambdaRed * RED_CARD_POINTS;

  if (CONCEDE_PENALISED.has(position)) {
    // Both the clean-sheet bonus and the goals-conceded penalty are gated
    // on the same crude "did they play a meaningful share of the match"
    // proxy, since we don't model a full minutes distribution here.
    const playedMeaningfulShare = clamp(xmins / LONG_PLAY_MINUTES, 0, 1);
    const cleanSheetProbability = Math.exp(-opponentGoalsExpected); // P(X=0), Poisson
    xpts += cleanSheetProbability * playedMeaningfulShare * CLEAN_SHEET_POINTS[position];
    xpts -=
      poissonFloorDivExpectation(opponentGoalsExpected, 2, opts.kMaxPoisson) *
      playedMeaningfulShare;
  }

  return { element_id: element.id, event, xmins, xpts };
}

/** Projects a single player. `positionAvgCost` (only used by `model-v2`) is
 * the average `now_cost` for each position across whatever candidate pool
 * the caller is projecting -- pass the output of `computePositionAvgCost`,
 * or let `projectAll` compute it once for the whole pool. */
export function projectPlayer(
  element: Element,
  event: number,
  opts: ProjectionOptions = {},
  positionAvgCost: Readonly<Record<Position, number>> = DEFAULT_POSITION_AVG_COST,
): Projection {
  const strategy = opts.strategy ?? STRATEGY_EP_NEXT;
  const baseMinutesIfFit = opts.baseMinutesIfFit ?? DEFAULT_BASE_MINUTES_IF_FIT;

  if (strategy === STRATEGY_EP_NEXT) {
    return projectEpNext(element, event, baseMinutesIfFit);
  }

  return projectModelV2(
    element,
    event,
    {
      trailingWindow: opts.trailingWindow ?? DEFAULT_TRAILING_WINDOW,
      shrinkagePseudoMinutes: opts.shrinkagePseudoMinutes ?? DEFAULT_SHRINKAGE_PSEUDO_MINUTES,
      kMaxPoisson: opts.kMaxPoisson ?? DEFAULT_K_MAX_POISSON,
      baseMinutesIfFit,
    },
    positionAvgCost,
    opts.ratings,
    opts.fixturesByTeam,
    opts.trailingStatsByElement,
  );
}

const DEFAULT_POSITION_AVG_COST: Record<Position, number> = {
  [Position.GK]: 45,
  [Position.DEF]: 45,
  [Position.MID]: 55,
  [Position.FWD]: 60,
};

/** Average `now_cost` per position across a candidate pool -- the price
 * denominator `projectModelV2` uses to turn each player's own price into a
 * relative "is this an expensive/premium option at their position" factor. */
export function computePositionAvgCost(elements: readonly Element[]): Record<Position, number> {
  const totals: Record<Position, number> = {
    [Position.GK]: 0,
    [Position.DEF]: 0,
    [Position.MID]: 0,
    [Position.FWD]: 0,
  };
  const counts: Record<Position, number> = {
    [Position.GK]: 0,
    [Position.DEF]: 0,
    [Position.MID]: 0,
    [Position.FWD]: 0,
  };
  for (const e of elements) {
    totals[e.element_type] += e.now_cost;
    counts[e.element_type] += 1;
  }
  const result = { ...DEFAULT_POSITION_AVG_COST };
  for (const pos of [Position.GK, Position.DEF, Position.MID, Position.FWD]) {
    if (counts[pos] > 0) result[pos] = totals[pos] / counts[pos];
  }
  return result;
}

/** Projects every element for one gameweek under one strategy. Computes
 * `positionAvgCost` once for the whole pool rather than per player. */
export function projectAll(
  elements: readonly Element[],
  event: number,
  opts: ProjectionOptions = {},
): Projection[] {
  const positionAvgCost = computePositionAvgCost(elements);
  return elements.map((e) => projectPlayer(e, event, opts, positionAvgCost));
}
