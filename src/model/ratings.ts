/**
 * Team attack/defence ratings, fit from played fixture scorelines.
 *
 * The bootstrap-static API gives us NO usable fixture difficulty: every
 * `teams[].strength*` field is null and `teams[].played`/`points` sit at 0
 * all season (confirmed against the live payload -- see project notes). The
 * only signal available is the scoreline of fixtures that have actually
 * been played, so this module fits a small multiplicative Poisson-style
 * attack/defence model directly from `Fixture.team_h_score` /
 * `team_a_score` where `finished` is true.
 *
 * With a whole season (2/3/whatever) still ahead and only a handful of
 * gameweeks played, a per-team maximum-likelihood fit is extremely noisy --
 * one 4-0 in a team's only game so far would otherwise swing its rating
 * wildly. Every team-level parameter is therefore fit with additive
 * ("pseudo-match") ridge regularisation toward the league-mean rating of
 * 1.0, weighted so that a team with few games played is pulled hard toward
 * the mean and a team with more evidence is trusted more. This is the
 * "regularise hard toward the league mean" the model spec calls for.
 *
 * Model form (a standard simplification of the Maher / Dixon-Coles
 * attack-defence model):
 *
 *   E[home goals] = leagueAvgGoals * homeAdvantage * attack[home] * defence[away]
 *   E[away goals] = leagueAvgGoals *                 attack[away] * defence[home]
 *
 * `attack`/`defence` are multiplicative factors centred on 1.0 (1.0 = league
 * average; >1 = scores/concedes more than average). `homeAdvantage` is a
 * single scalar boosting only the home side, also shrunk toward a neutral
 * prior since even the league-wide home/away split is thin evidence this
 * early in a season.
 */

import type { Fixture } from '../types';

export interface TeamRating {
  /** Multiplicative attacking strength, centred on 1.0 (league average). */
  attack: number;
  /** Multiplicative defensive weakness, centred on 1.0 (league average).
   * >1 concedes more than average, <1 concedes less. */
  defence: number;
}

export interface RatingsModel {
  ratings: Map<number, TeamRating>;
  /** Mean goals scored by one team in one fixture (home+away pooled), over
   * every finished fixture seen. The common multiplicative baseline that
   * `attack`/`defence` scale. */
  leagueAvgGoals: number;
  /** Home team's goals scored are boosted by this multiplicative factor
   * relative to what attack/defence alone predict. Shrunk toward
   * `homeAdvantagePrior` when few fixtures are in. */
  homeAdvantage: number;
}

export interface FitRatingsOptions {
  /**
   * Pseudo-matches of "average team" evidence blended into every team's
   * attack/defence estimate, expressed in units of matches. With ~4 real
   * gameweeks played per team so far, real evidence is thin (n=4), so this
   * defaults high enough that even a team's whole sample is only a
   * fraction of the weight behind its final rating -- deliberately
   * "regularising hard toward the league mean" per the brief.
   */
  shrinkage?: number;
  /** Alternating IPF-style update rounds for the attack/defence fit. The
   * system is tiny (at most ~18-20 teams) and converges in a handful of
   * iterations; this is a hard cap, not a convergence loop, so the fit
   * stays cheap and bounded no matter what fixture list is passed in. */
  maxIterations?: number;
  /** Neutral prior for home advantage (no evidence at all -> this value). */
  homeAdvantagePrior?: number;
  /** Pseudo-matches of league-wide evidence blended into the home
   * advantage estimate. League-wide samples accumulate faster than any one
   * team's, so this is much smaller than `shrinkage`. */
  homeAdvantageShrinkage?: number;
  /** Attack/defence factors are clamped to this range after fitting, so a
   * single small sample can't produce an absurd multiplier. */
  clampRange?: readonly [number, number];
}

const DEFAULT_SHRINKAGE = 8;
const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_HOME_ADVANTAGE_PRIOR = 1.15;
const DEFAULT_HOME_ADVANTAGE_SHRINKAGE = 10;
const DEFAULT_CLAMP_RANGE: readonly [number, number] = [0.35, 2.75];
/** Neutral rating for a team with no finished fixtures at all (e.g. a
 * blank-gameweek edge case, or data not loaded yet). */
const NEUTRAL_RATING: TeamRating = { attack: 1, defence: 1 };

interface TeamMatch {
  team: number;
  opponent: number;
  isHome: boolean;
  goalsFor: number;
  goalsAgainst: number;
}

/**
 * Fits attack/defence ratings and home advantage from played fixtures.
 *
 * Only fixtures with `finished === true` and non-null scores are used.
 * Teams that never appear in a finished fixture are simply absent from the
 * returned map -- callers should treat a missing team as `{attack: 1,
 * defence: 1}` (a promoted team with no history is, by definition, exactly
 * the league-average unknown).
 */
export function fitTeamRatings(
  fixtures: readonly Fixture[],
  opts: FitRatingsOptions = {},
): RatingsModel {
  const shrinkage = opts.shrinkage ?? DEFAULT_SHRINKAGE;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const homeAdvantagePrior = opts.homeAdvantagePrior ?? DEFAULT_HOME_ADVANTAGE_PRIOR;
  const homeAdvantageShrinkage = opts.homeAdvantageShrinkage ?? DEFAULT_HOME_ADVANTAGE_SHRINKAGE;
  const [clampMin, clampMax] = opts.clampRange ?? DEFAULT_CLAMP_RANGE;

  const finished = fixtures.filter(
    (f): f is Fixture & { team_h_score: number; team_a_score: number } =>
      f.finished && f.team_h_score !== null && f.team_a_score !== null,
  );

  if (finished.length === 0) {
    return { ratings: new Map(), leagueAvgGoals: 1, homeAdvantage: homeAdvantagePrior };
  }

  let totalHomeGoals = 0;
  let totalAwayGoals = 0;
  for (const f of finished) {
    totalHomeGoals += f.team_h_score;
    totalAwayGoals += f.team_a_score;
  }
  const n = finished.length;
  const leagueAvgGoals = (totalHomeGoals + totalAwayGoals) / (2 * n);
  const rawHomeAdvantage =
    totalAwayGoals > 0 ? totalHomeGoals / totalAwayGoals : homeAdvantagePrior;
  // League-wide shrinkage: blend the observed home/away split with the
  // neutral prior, weighted by how many fixtures we actually have.
  const homeAdvantage =
    (n * rawHomeAdvantage + homeAdvantageShrinkage * homeAdvantagePrior) /
    (n + homeAdvantageShrinkage);

  // Build the per-team, per-match view used by the iterative fit.
  const matches: TeamMatch[] = [];
  const teamIds = new Set<number>();
  for (const f of finished) {
    teamIds.add(f.team_h);
    teamIds.add(f.team_a);
    matches.push({
      team: f.team_h,
      opponent: f.team_a,
      isHome: true,
      goalsFor: f.team_h_score,
      goalsAgainst: f.team_a_score,
    });
    matches.push({
      team: f.team_a,
      opponent: f.team_h,
      isHome: false,
      goalsFor: f.team_a_score,
      goalsAgainst: f.team_h_score,
    });
  }

  const attack = new Map<number, number>();
  const defence = new Map<number, number>();
  for (const id of teamIds) {
    attack.set(id, 1);
    defence.set(id, 1);
  }

  const matchesByTeam = new Map<number, TeamMatch[]>();
  for (const id of teamIds) matchesByTeam.set(id, []);
  for (const m of matches) matchesByTeam.get(m.team)!.push(m);

  // Iterative proportional fitting: alternately re-estimate attack holding
  // defence fixed, then defence holding attack fixed. Each update is a
  // ridge-shrunk ratio estimate (observed / expected-under-current-model),
  // shrunk toward 1.0 by `shrinkage` matches' worth of "average" evidence.
  for (let iter = 0; iter < maxIterations; iter++) {
    for (const id of teamIds) {
      const teamMatches = matchesByTeam.get(id)!;
      let numerator = 0;
      let denominator = 0;
      for (const m of teamMatches) {
        const baseRate = leagueAvgGoals * (m.isHome ? homeAdvantage : 1);
        const expected = baseRate * defence.get(m.opponent)!;
        numerator += m.goalsFor;
        denominator += expected;
      }
      const games = teamMatches.length;
      if (games === 0 || denominator <= 0) continue;
      const avgDenomPerGame = denominator / games;
      const shrunk =
        (numerator + shrinkage * avgDenomPerGame) / (denominator + shrinkage * avgDenomPerGame);
      attack.set(id, clamp(shrunk, clampMin, clampMax));
    }

    for (const id of teamIds) {
      const teamMatches = matchesByTeam.get(id)!;
      let numerator = 0;
      let denominator = 0;
      for (const m of teamMatches) {
        // m.isHome describes `team` (the defender here); the opponent's
        // scoring rate is boosted by home advantage when the OPPONENT was
        // at home, i.e. when this team was away.
        const baseRate = leagueAvgGoals * (m.isHome ? 1 : homeAdvantage);
        const expected = baseRate * attack.get(m.opponent)!;
        numerator += m.goalsAgainst;
        denominator += expected;
      }
      const games = teamMatches.length;
      if (games === 0 || denominator <= 0) continue;
      const avgDenomPerGame = denominator / games;
      const shrunk =
        (numerator + shrinkage * avgDenomPerGame) / (denominator + shrinkage * avgDenomPerGame);
      defence.set(id, clamp(shrunk, clampMin, clampMax));
    }
  }

  const ratings = new Map<number, TeamRating>();
  for (const id of teamIds) {
    ratings.set(id, { attack: attack.get(id)!, defence: defence.get(id)! });
  }

  return { ratings, leagueAvgGoals, homeAdvantage };
}

/**
 * Expected goals for both sides of a single fixture. Missing teams (no
 * finished fixtures fitted for them yet) fall back to the neutral
 * league-average rating rather than throwing -- this is the correct
 * behaviour for a promoted/newly-seen team.
 */
export function expectedGoals(
  model: RatingsModel,
  homeTeam: number,
  awayTeam: number,
): { home: number; away: number } {
  const home = model.ratings.get(homeTeam) ?? NEUTRAL_RATING;
  const away = model.ratings.get(awayTeam) ?? NEUTRAL_RATING;
  return {
    home: model.leagueAvgGoals * model.homeAdvantage * home.attack * away.defence,
    away: model.leagueAvgGoals * away.attack * home.defence,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
