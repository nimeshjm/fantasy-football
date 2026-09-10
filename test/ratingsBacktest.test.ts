/**
 * A/B backtest for the two `fitTeamRatings` estimator arms
 * (src/model/ratings.ts), scored on held-out gameweeks of real GW1-4 data.
 *
 * ---------------------------------------------------------------------
 * WHY THIS IS SCORED ON SCORELINES, NOT ON PLAYER POINTS
 *
 * `test/backtest.test.ts` scores per-PLAYER xpts against actual player
 * points. Team ratings reach that number only through `projectModelV2`'s
 * fixture-difficulty term, where they are diluted by minutes modelling,
 * trailing form, price factors and availability. A ratings change that
 * genuinely improved fixture difficulty could easily show up there as
 * nothing at all, and a null result would say more about the metric's
 * distance from the estimator than about the estimator.
 *
 * So this file scores the ratings where they live: fit on `event < g`,
 * predict the scoreline of every gameweek-`g` fixture via `expectedGoals`,
 * and compare against what those fixtures actually finished. No player
 * modelling is involved, and there is no leakage to reason about beyond
 * the fixture filter itself -- `Fixture` carries scores and nothing else
 * the fit could cheat with.
 *
 * ---------------------------------------------------------------------
 * WHY POISSON LOG-LIKELIHOOD IS THE PRIMARY METRIC
 *
 * The model predicts a goal RATE, not a goal count, and is explicitly
 * Poisson (see src/model/ratings.ts). Mean log-likelihood is the proper
 * scoring rule for that: it rewards a prediction for putting probability
 * mass where the result actually landed, and it punishes confident wrong
 * predictions harder than timid wrong ones -- which is exactly the axis
 * the two arms differ on, since the whole disagreement is about how much
 * confidence a thin sample earns. MAE on goals is reported alongside it
 * because it is interpretable in goals, but MAE is minimised by predicting
 * the conditional median and is close to blind to overconfidence, so it is
 * the secondary number here, not the tiebreaker.
 *
 * ---------------------------------------------------------------------
 * THE `neutral` ARM IS THE ONE THAT MATTERS MOST
 *
 * `neutral` keeps every rating at exactly 1.0 while sharing the two
 * league-wide scalars, i.e. "this league has a goal rate and a home
 * advantage, and no team is distinguishable from any other". Any arm that
 * cannot beat it has not earned the right to have per-team ratings at all
 * at this sample size. With 3 held-out gameweeks of an 18-team league this
 * is a small, noisy comparison, so the assertions below deliberately claim
 * only what that sample supports -- see the final test.
 */
import { describe, expect, it } from 'vitest';
import {
  expectedGoals,
  fitTeamRatings,
  RATINGS_EMPIRICAL_BAYES,
  RATINGS_RIDGE,
  type RatingsEstimator,
  type RatingsModel,
} from '../src/model/ratings';
import { fixtures } from '../eval/suites/fantasy/fixtures';
import type { Fixture } from '../src/types';

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** log P(k | lambda) for a Poisson with mean `lambda`, via lgamma-free
 * accumulation of log(k!) -- k is a goal count, so it is always tiny. */
function poissonLogPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 0 : -Infinity;
  let logFactorial = 0;
  for (let i = 2; i <= k; i++) logFactorial += Math.log(i);
  return k * Math.log(lambda) - lambda - logFactorial;
}

interface ArmScore {
  /** Mean Poisson log-likelihood per predicted team-side goal count.
   * Higher (less negative) is better. */
  meanLogLik: number;
  /** Mean absolute error in goals per predicted team-side goal count. */
  mae: number;
  /** Team-side predictions scored (2 per fixture). */
  predictions: number;
}

/** Scores one fitted model against the actual scorelines of `targets`. */
function scoreModel(model: RatingsModel, targets: readonly PlayedFixture[]): ArmScore {
  let logLik = 0;
  let absError = 0;
  let n = 0;
  for (const f of targets) {
    const eg = expectedGoals(model, f.team_h, f.team_a);
    logLik += poissonLogPmf(f.team_h_score, eg.home) + poissonLogPmf(f.team_a_score, eg.away);
    absError += Math.abs(f.team_h_score - eg.home) + Math.abs(f.team_a_score - eg.away);
    n += 2;
  }
  return { meanLogLik: logLik / n, mae: absError / n, predictions: n };
}

// ---------------------------------------------------------------------------
// Point-in-time fit + hold-out
// ---------------------------------------------------------------------------

type PlayedFixture = Fixture & { team_h_score: number; team_a_score: number };

function playedInEvent(g: number): PlayedFixture[] {
  return fixtures.filter(
    (f): f is PlayedFixture =>
      f.event === g && f.finished && f.team_h_score !== null && f.team_a_score !== null,
  );
}

/** Every fixture that had been played before gameweek `g` kicked off --
 * the only evidence a fit predicting `g` is allowed to see. */
function fixturesBefore(g: number): Fixture[] {
  return fixtures.filter((f) => f.event !== null && f.event < g);
}

/** `neutral` is not a `RatingsEstimator`; it is the no-per-team-ratings
 * floor, built by fitting normally and then discarding the ratings while
 * keeping `leagueAvgGoals` and `homeAdvantage`. */
type Arm = RatingsEstimator | 'neutral';
const ARMS: readonly Arm[] = [RATINGS_RIDGE, RATINGS_EMPIRICAL_BAYES, 'neutral'];

function fitArm(arm: Arm, g: number): RatingsModel {
  const history = fixturesBefore(g);
  if (arm === 'neutral') {
    const { leagueAvgGoals, homeAdvantage } = fitTeamRatings(history);
    return { ratings: new Map(), leagueAvgGoals, homeAdvantage };
  }
  return fitTeamRatings(history, { estimator: arm });
}

const HELD_OUT_GAMEWEEKS = [2, 3, 4] as const;

interface GwRow {
  gw: number;
  fixtures: number;
  byArm: Map<Arm, ArmScore>;
}

const rows: GwRow[] = HELD_OUT_GAMEWEEKS.map((g) => {
  const targets = playedInEvent(g);
  const byArm = new Map<Arm, ArmScore>();
  for (const arm of ARMS) byArm.set(arm, scoreModel(fitArm(arm, g), targets));
  return { gw: g, fixtures: targets.length, byArm };
});

function meanAcrossGameweeks(arm: Arm, pick: (s: ArmScore) => number): number {
  return rows.reduce((acc, r) => acc + pick(r.byArm.get(arm)!), 0) / rows.length;
}

// ---------------------------------------------------------------------------
// The A/B
// ---------------------------------------------------------------------------

describe('ratings estimator A/B on held-out GW2-4 scorelines', () => {
  it('logs the per-gameweek comparison table', () => {
    console.log('\nratings A/B (held-out gameweek, scored on real scorelines)');
    console.log('gw | fixtures | arm             | mean logLik | MAE (goals)');
    for (const r of rows) {
      for (const arm of ARMS) {
        const s = r.byArm.get(arm)!;
        console.log(
          `${r.gw}  | ${String(r.fixtures).padStart(8)} | ${arm.padEnd(15)} | ` +
            `${s.meanLogLik.toFixed(4).padStart(11)} | ${s.mae.toFixed(4)}`,
        );
      }
    }
    console.log('--');
    for (const arm of ARMS) {
      console.log(
        `mean over GW${HELD_OUT_GAMEWEEKS.join(',')} | ${arm.padEnd(15)} | ` +
          `${meanAcrossGameweeks(arm, (s) => s.meanLogLik)
            .toFixed(4)
            .padStart(11)} | ` +
          `${meanAcrossGameweeks(arm, (s) => s.mae).toFixed(4)}`,
      );
    }
    expect(rows).toHaveLength(HELD_OUT_GAMEWEEKS.length);
  });

  it('scores every arm on the same non-empty population in every gameweek', () => {
    // A comparison across arms is only meaningful if they were scored on
    // identical fixtures -- guard that rather than assuming it.
    for (const r of rows) {
      expect(r.fixtures).toBeGreaterThan(0);
      const counts = new Set(ARMS.map((a) => r.byArm.get(a)!.predictions));
      expect(counts.size).toBe(1);
      expect(r.byArm.get(RATINGS_RIDGE)!.predictions).toBe(r.fixtures * 2);
    }
  });

  it('produces finite scores for every arm and gameweek', () => {
    for (const r of rows) {
      for (const arm of ARMS) {
        const s = r.byArm.get(arm)!;
        expect(Number.isFinite(s.meanLogLik)).toBe(true);
        expect(Number.isFinite(s.mae)).toBe(true);
      }
    }
  });

  it('gives the empirical-bayes arm a defined, in-range fit on every held-out gameweek', () => {
    for (const g of HELD_OUT_GAMEWEEKS) {
      const model = fitArm(RATINGS_EMPIRICAL_BAYES, g);
      for (const r of model.ratings.values()) {
        expect(Number.isFinite(r.attack)).toBe(true);
        expect(Number.isFinite(r.defence)).toBe(true);
        expect(r.attack).toBeGreaterThan(0);
        expect(r.defence).toBeGreaterThan(0);
      }
    }
  });

  it('collapses the empirical-bayes arm to the league mean off a single round of fixtures', () => {
    // GW2's fit sees only GW1 -- one match per team. On that evidence the
    // observed scatter in team ratings is entirely explicable as Poisson
    // scoring noise, so `betweenVar` clamps to 0 and the arm declines to
    // claim any team is distinguishable from average. It therefore scores
    // IDENTICALLY to the no-ratings floor at GW2, which is the whole point
    // of the arm rather than a shortcoming: it spends no confidence it
    // has not earned. This is the behaviour that makes it lose to ridge on
    // the GW2 row of the logged table.
    const model = fitArm(RATINGS_EMPIRICAL_BAYES, 2);
    for (const r of model.ratings.values()) {
      expect(r.attack).toBeCloseTo(1, 10);
      expect(r.defence).toBeCloseTo(1, 10);
    }
    const gw2 = rows.find((r) => r.gw === 2)!;
    expect(gw2.byArm.get(RATINGS_EMPIRICAL_BAYES)!.meanLogLik).toBeCloseTo(
      gw2.byArm.get('neutral')!.meanLogLik,
      10,
    );
  });

  it('has both rating arms beat the no-ratings floor on average across GW2-4', () => {
    // The claim three gameweeks of an 18-team league can support. A
    // per-gameweek assertion would be brittle (GW2's fit sees one round of
    // fixtures), so this averages, matching how test/backtest.test.ts
    // scopes its own claim. What it establishes is the thing worth
    // establishing: fitting per-team ratings at all beats assuming every
    // team is league-average, for both arms. It is deliberately NOT an
    // assertion about which arm wins -- see the module doc and the logged
    // table for that; the two are within 0.01 nats of each other on this
    // sample, which is not a result.
    const neutral = meanAcrossGameweeks('neutral', (s) => s.meanLogLik);
    for (const arm of [RATINGS_RIDGE, RATINGS_EMPIRICAL_BAYES] as const) {
      expect(meanAcrossGameweeks(arm, (s) => s.meanLogLik)).toBeGreaterThan(neutral);
    }
  });
});
