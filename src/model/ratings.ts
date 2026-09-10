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
 * wildly. Every team-level parameter is therefore fit with regularisation
 * toward the league-mean rating of 1.0, weighted so that a team with few
 * games played is pulled hard toward the mean and a team with more
 * evidence is trusted more. This is the "regularise hard toward the league
 * mean" the model spec calls for.
 *
 * HOW HARD to shrink is the single most consequential choice in the fit at
 * this sample size (~3 games per team against 36 free parameters), so it
 * is the axis the two estimator arms differ on -- see `RatingsEstimator`.
 * Both arms share the same model form, the same league-wide scalars and
 * the same alternating fit; they differ only in the per-team update rule.
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

/** Fixed ridge shrinkage toward 1.0, at a strength hand-picked via
 * `shrinkage` (default `DEFAULT_SHRINKAGE` pseudo-matches). The original
 * arm, and still the default: its behaviour is the one every existing
 * snapshot and eval was recorded against. */
export const RATINGS_RIDGE = 'ridge' as const;
/** Shrinkage toward 1.0 at a strength estimated FROM the fixture list
 * rather than hand-picked, by comparing the observed spread in team
 * ratings against the spread Poisson scoring noise alone would produce.
 * See `empiricalBayesUpdate` for the derivation. */
export const RATINGS_EMPIRICAL_BAYES = 'empirical-bayes' as const;
export type RatingsEstimator = typeof RATINGS_RIDGE | typeof RATINGS_EMPIRICAL_BAYES;

export interface FitRatingsOptions {
  /** Which per-team update rule to fit with. Defaults to `'ridge'`; the
   * arms are documented on the two constants above. */
  estimator?: RatingsEstimator;
  /**
   * Pseudo-matches of "average team" evidence blended into every team's
   * attack/defence estimate, expressed in units of matches. With ~4 real
   * gameweeks played per team so far, real evidence is thin (n=4), so this
   * defaults high enough that even a team's whole sample is only a
   * fraction of the weight behind its final rating -- deliberately
   * "regularising hard toward the league mean" per the brief.
   *
   * Only the `'ridge'` arm reads this; `'empirical-bayes'` derives the
   * equivalent strength from the data instead.
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
   * team's, so this is much smaller than `shrinkage`. Shared by both
   * estimator arms -- home advantage is a single league-wide scalar with
   * far more evidence behind it than any one team's rating. */
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
/** Fewest teams the empirical-Bayes arm will estimate a between-team
 * variance from. See `empiricalBayesUpdate`. */
const MIN_TEAMS_FOR_EB = 3;
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

/** One team's sufficient statistics for a single half-update: goals it
 * actually recorded, goals the model currently expects it to record, and
 * how many matches those came from. `observed / expected` is the unshrunk
 * maximum-likelihood ratio; every estimator's job is to decide how far to
 * trust it. */
interface TeamStat {
  id: number;
  observed: number;
  expected: number;
  games: number;
}

/**
 * Both update rules return a blend `1 + w * (ratio - 1)` for each team --
 * they only disagree about `w`. Writing them in that shared form (rather
 * than as two different-looking algebraic expressions) is what makes the
 * A/B a comparison of one decision instead of two rewrites.
 */
type UpdateRule = (stats: readonly TeamStat[]) => Map<number, number>;

/** Additive pseudo-match ridge: blend in `shrinkage` matches' worth of
 * "exactly average" evidence. Equivalent to `w = games / (games +
 * shrinkage)`, i.e. a team needs `shrinkage` matches of its own before its
 * record carries half the weight of its final rating. */
function ridgeUpdate(stats: readonly TeamStat[], shrinkage: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of stats) {
    if (t.games === 0 || t.expected <= 0) continue;
    const avgExpectedPerGame = t.expected / t.games;
    out.set(
      t.id,
      (t.observed + shrinkage * avgExpectedPerGame) / (t.expected + shrinkage * avgExpectedPerGame),
    );
  }
  return out;
}

/**
 * Empirical-Bayes shrinkage: estimate how much real spread there is in
 * team strengths, and shrink by exactly enough to remove the rest.
 *
 * The ridge arm asserts a shrinkage strength. This one derives it. Goals
 * are Poisson, so for team i with `expected` goals under the current
 * model, `Var(observed) ~= expected` and the raw ratio
 * `r_i = observed / expected` has sampling variance
 *
 *   withinVar_i = expected_i / expected_i^2 = 1 / expected_i
 *
 * -- the noise floor: how far `r_i` scatters from team i's TRUE rating
 * purely by chance. The observed scatter of `r_i` across teams contains
 * that noise plus whatever genuine spread exists, so method of moments
 * gives the genuine part by subtraction:
 *
 *   betweenVar = Var(r) - mean(withinVar)
 *
 * and the posterior weight on team i's own record is the usual ratio of
 * signal to signal-plus-noise, using that team's OWN precision:
 *
 *   w_i = betweenVar / (betweenVar + withinVar_i)
 *
 * A team with more matches played has a smaller `withinVar_i` and so is
 * trusted more, which is the same qualitative behaviour as ridge -- but
 * the overall severity now falls out of the fixture list instead of a
 * constant. When results are so tight that observed scatter is entirely
 * explicable as scoring noise, `betweenVar` clamps to 0, every `w_i` is 0
 * and the whole league collapses to exactly 1.0: "no detectable spread
 * beyond chance, so claim none". That is the expected GW2 behaviour on a
 * single round of fixtures, not a degenerate case to guard against.
 *
 * Two details that matter at this sample size:
 *
 *  - Scatter is measured about 1.0, not about the sample mean of the
 *    ratios. 1.0 is not an estimated quantity here -- `attack`/`defence`
 *    are DEFINED as multipliers centred on the league mean -- so there is
 *    no degree of freedom to give up and no `n-1` correction to make.
 *  - `betweenVar` is a variance estimated across teams, so it needs teams
 *    to estimate from. Below `MIN_TEAMS_FOR_EB` the between-team scatter
 *    is dominated by its own sampling error and the arm would confidently
 *    read one lopsided scoreline as league-wide spread, so it shrinks
 *    fully instead. Three is the James-Stein floor: shrinkage toward a
 *    known mean only dominates the raw estimate from dimension 3 up.
 */
function empiricalBayesUpdate(stats: readonly TeamStat[]): Map<number, number> {
  const usable = stats.filter((t) => t.games > 0 && t.expected > 0);
  const out = new Map<number, number>();
  if (usable.length === 0) return out;
  if (usable.length < MIN_TEAMS_FOR_EB) {
    for (const t of usable) out.set(t.id, 1);
    return out;
  }

  const ratios = usable.map((t) => t.observed / t.expected);
  const withinVars = usable.map((t) => 1 / t.expected);
  const totalVar = ratios.reduce((acc, r) => acc + (r - 1) ** 2, 0) / ratios.length;
  const meanWithinVar = withinVars.reduce((a, b) => a + b, 0) / withinVars.length;
  // Clamped at 0: a negative variance is not a smaller variance, it is
  // "the data cannot resolve any spread at all".
  const betweenVar = Math.max(0, totalVar - meanWithinVar);

  for (const [i, t] of usable.entries()) {
    const w = betweenVar / (betweenVar + withinVars[i]!);
    out.set(t.id, 1 + w * (ratios[i]! - 1));
  }
  return out;
}

/**
 * Fits attack/defence ratings and home advantage from played fixtures.
 *
 * Only fixtures with `finished === true` and non-null scores are used.
 * Teams that never appear in a finished fixture are simply absent from the
 * returned map -- callers should treat a missing team as `{attack: 1,
 * defence: 1}` (a promoted team with no history is, by definition, exactly
 * the league-average unknown).
 *
 * `opts.estimator` selects the per-team update rule; everything else about
 * the fit is shared across arms. See `test/ratingsBacktest.test.ts` for
 * the held-out-gameweek comparison between them.
 */
export function fitTeamRatings(
  fixtures: readonly Fixture[],
  opts: FitRatingsOptions = {},
): RatingsModel {
  const estimator = opts.estimator ?? RATINGS_RIDGE;
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

  const update: UpdateRule =
    estimator === RATINGS_EMPIRICAL_BAYES
      ? empiricalBayesUpdate
      : (stats) => ridgeUpdate(stats, shrinkage);

  /** Sufficient statistics for every team under one half of the fit.
   * `expectedFor` is the model's current rate for the stat being
   * re-estimated, holding the other side of the model fixed. */
  const collect = (
    goalsOf: (m: TeamMatch) => number,
    expectedFor: (m: TeamMatch) => number,
  ): TeamStat[] => {
    const stats: TeamStat[] = [];
    for (const id of teamIds) {
      const teamMatches = matchesByTeam.get(id)!;
      let observed = 0;
      let expected = 0;
      for (const m of teamMatches) {
        observed += goalsOf(m);
        expected += expectedFor(m);
      }
      stats.push({ id, observed, expected, games: teamMatches.length });
    }
    return stats;
  };

  // Iterative proportional fitting: alternately re-estimate attack holding
  // defence fixed, then defence holding attack fixed. Each half-update is
  // a ratio estimate (observed / expected-under-current-model) shrunk
  // toward 1.0 by whichever `update` rule this arm selected. A team the
  // rule declined to estimate (no games, or no expected goals to divide
  // by) keeps its current value rather than being reset.
  for (let iter = 0; iter < maxIterations; iter++) {
    const attackStats = collect(
      (m) => m.goalsFor,
      (m) => leagueAvgGoals * (m.isHome ? homeAdvantage : 1) * defence.get(m.opponent)!,
    );
    for (const [id, value] of update(attackStats)) {
      attack.set(id, clamp(value, clampMin, clampMax));
    }

    // m.isHome describes `team` (the defender here); the opponent's
    // scoring rate is boosted by home advantage when the OPPONENT was at
    // home, i.e. when this team was away.
    const defenceStats = collect(
      (m) => m.goalsAgainst,
      (m) => leagueAvgGoals * (m.isHome ? 1 : homeAdvantage) * attack.get(m.opponent)!,
    );
    for (const [id, value] of update(defenceStats)) {
      defence.set(id, clamp(value, clampMin, clampMax));
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
