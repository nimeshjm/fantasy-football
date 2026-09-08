/**
 * Backtest for `model-v2` (src/model/projection.ts + src/model/ratings.ts)
 * against real GW1-4 data, scoped honestly to what this repo's fixtures
 * actually allow -- see "WHY NOT A v1 BACKTEST" below before extending this.
 *
 * ---------------------------------------------------------------------
 * WHY NOT A v1 BACKTEST
 *
 * `test/fixtures/bootstrap-static.json` is a SINGLE snapshot taken after
 * GW4 (events 1-4 are finished, 5+ are not). Its `ep_next` is the site's
 * forecast for GW5 -- there is no per-gameweek history of `ep_next`
 * anywhere, and the live API does not expose one. Using that one GW5
 * forecast to "predict" GW1-4 would not be a backtest of v1, it would be
 * leakage (the forecast postdates the results it's being scored against).
 * So there is no v1 arm here, on purpose. The honest baseline used instead
 * is "previous gameweek's actual points", which needs no forecast at all.
 *
 * ---------------------------------------------------------------------
 * A SECOND, SMALLER LEAK THAT IS UNAVOIDABLE WITH ONE SNAPSHOT -- AND WHY
 * IT DOESN'T INVALIDATE THIS
 *
 * Every `Element` fed into `projectModelV2` below is built from that same
 * post-GW4 snapshot, because it is the only `Element` data this repo has.
 * Two fields it carries leak a little bit of GW1-4 hindsight into a
 * "prediction" of GW2/GW3/GW4:
 *
 *  - `status` / `chance_of_playing_next_round` feed `estimateXMinsFromAvailability`
 *    -- a player who got injured in GW3 shows as unavailable when this
 *    backtest "projects" GW2, understating GW2 xmins for a player who was
 *    actually fine at the time.
 *  - `now_cost` feeds `priceFactor` (shots-on-target/saves priors) -- by
 *    GW5 a player's price has partly moved on the strength of their GW1-4
 *    form, which is exactly what a point-in-time backtest must not see.
 *
 * `ep_next` is forced to `null` on every converted element (see
 * `toElement` in eval/suites/fantasy/fixtures.ts) specifically so the one
 * leak big enough to matter cannot sneak back in as a de facto v1 arm. The
 * two leaks above are left
 * in because there is no fix available from the data this repo has (there
 * is exactly one bootstrap-static.json), they pull in OPPOSITE directions
 * (the status leak understates v2, the price leak flatters it), and,
 * unlike `ep_next`, neither one is "the entire signal" -- they perturb one
 * factor each inside a model with several independent inputs. Call this
 * out for what it is rather than pretending the backtest is leak-free.
 */
import { describe, expect, it } from 'vitest';
import {
  actualPointsByElement,
  liveFileByEvent,
  liveFileToEventLive,
  minutesByElement,
  pointInTimeState,
} from '../eval/suites/fantasy/fixtures';
import { deriveGwStatsFromLive } from '../src/workflows/ingest';

// ---------------------------------------------------------------------------
// Part 1: the Spearman rank-correlation helper, written and tested here
// (no new dependency) so a broken metric cannot silently pass the backtest
// below -- see the dedicated `describe('spearman')` block for the
// hand-computed cases this is held to.
// ---------------------------------------------------------------------------

/** 1-based ranks, ties resolved to the AVERAGE of the ranks they span (the
 * standard tie-handling for Spearman's rho -- e.g. two tied-for-2nd values
 * both get rank 2.5, and the next value gets rank 4, not 3). */
function rankWithTiesAveraged(values: readonly number[]): number[] {
  const n = values.length;
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]!] === values[order[i]!]) j++;
    // Average of the 1-based ranks i+1 .. j+1.
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]!] = avgRank;
    i = j + 1;
  }
  return ranks;
}

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  // Zero variance in either arm means correlation is undefined, not zero --
  // returning 0 here would let a degenerate input (e.g. every projection
  // tied) silently read as "no correlation" instead of "not computable",
  // which is exactly the kind of silent failure this helper exists to
  // avoid. NaN forces a caller to notice.
  if (denX === 0 || denY === 0) return NaN;
  return num / Math.sqrt(denX * denY);
}

/** Spearman's rank correlation: Pearson correlation of the two rank
 * sequences (average-rank tie handling, see `rankWithTiesAveraged`). */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length === 0) return NaN;
  return pearson(rankWithTiesAveraged(xs), rankWithTiesAveraged(ys));
}

describe('spearman (hand-computed cases)', () => {
  it('is 1 for a strictly monotonically increasing relationship', () => {
    expect(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 10);
  });

  it('is -1 for a strictly monotonically decreasing relationship', () => {
    expect(spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it('matches a hand-computed value with a tie in one arm', () => {
    // xs has a tie at rank 2/3 (both value 2) -> ranks [1, 2.5, 2.5, 4].
    // ys is untied -> ranks [1, 2, 3, 4].
    // Pearson of those two rank vectors works out to 3/sqrt(10) (derived by
    // hand from the rank vectors above, independent of this file's own
    // `pearson` implementation): mean(ranks_x)=2.5, mean(ranks_y)=2.5,
    // deviations x=[-1.5,0,0,1.5] y=[-1.5,-0.5,0.5,1.5],
    // cov=(-1.5*-1.5)+(1.5*1.5)=4.5, varX=1.5^2*2=4.5,
    // varY=1.5^2+.5^2+.5^2+1.5^2=5, rho=4.5/sqrt(4.5*5)=4.5/sqrt(22.5).
    const expected = 4.5 / Math.sqrt(22.5);
    expect(spearman([1, 2, 2, 3], [1, 2, 3, 4])).toBeCloseTo(expected, 10);
  });

  it('is NaN when one arm has zero variance (undefined, not zero, correlation)', () => {
    expect(spearman([5, 5, 5], [1, 2, 3])).toBeNaN();
  });

  it('is NaN for empty or mismatched-length input', () => {
    expect(spearman([], [])).toBeNaN();
    expect(spearman([1, 2], [1])).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Part 2: the backtest itself
// ---------------------------------------------------------------------------

interface GwResult {
  gw: number;
  populationSize: number;
  v2Spearman: number;
  baselineSpearman: number;
}

/** Runs model-v2 "as of just before gameweek `g`" and scores it against
 * gameweek `g`'s real results. Every input is restricted to what would
 * have been known before `g` kicked off (see the module doc for the two
 * exceptions that are unavoidable with a single post-GW4 snapshot). */
function backtestGameweek(g: number): GwResult {
  const { projections } = pointInTimeState(g);
  const xptsByElement = new Map(projections.map((p) => [p.element_id, p.xpts] as const));

  const targetFile = liveFileByEvent.get(g);
  if (!targetFile) throw new Error(`no live-${g}.json fixture loaded`);
  const actualThisGw = actualPointsByElement(targetFile);
  const minutesThisGw = minutesByElement(deriveGwStatsFromLive(liveFileToEventLive(targetFile), g));

  const priorFile = liveFileByEvent.get(g - 1);
  const actualPriorGw = priorFile ? actualPointsByElement(priorFile) : new Map<number, number>();

  // Restrict the correlation population to players who actually appeared
  // (nonzero minutes) in gameweek g. Every unused player scores 0 whether
  // the model liked them or not, so including the ~450 players who didn't
  // play would mostly measure "did the model correctly guess who'd be an
  // unused sub", not "did the model rank the players who played by how
  // well they'd do" -- a different, uninteresting question this backtest
  // is not trying to answer.
  const population = [...minutesThisGw.entries()].filter(([, mins]) => mins > 0).map(([id]) => id);

  const v2Values = population.map((id) => xptsByElement.get(id) ?? 0);
  const actualValues = population.map((id) => actualThisGw.get(id) ?? 0);
  // Honest, buildable baseline: last gameweek's actual points. A player
  // with no prior-gameweek row (e.g. not yet in the live payload -- see
  // the growing element counts across live-1..4.json) baselines at 0,
  // same as "no evidence this player will score" would predict.
  const baselineValues = population.map((id) => actualPriorGw.get(id) ?? 0);

  return {
    gw: g,
    populationSize: population.length,
    v2Spearman: spearman(v2Values, actualValues),
    baselineSpearman: spearman(baselineValues, actualValues),
  };
}

describe('model-v2 backtest against real GW2-4 results', () => {
  const results = [2, 3, 4].map(backtestGameweek);

  it('logs the per-gameweek comparison table', () => {
    console.log('\nmodel-v2 backtest (Spearman rank correlation vs actual GW points)');
    console.log('gw | population | v2 rho   | baseline (prev-gw-points) rho');
    for (const r of results) {
      console.log(
        `${r.gw}  | ${String(r.populationSize).padStart(10)} | ${r.v2Spearman.toFixed(4).padStart(8)} | ${r.baselineSpearman.toFixed(4)}`,
      );
    }
    const meanV2 = results.reduce((s, r) => s + r.v2Spearman, 0) / results.length;
    const meanBaseline = results.reduce((s, r) => s + r.baselineSpearman, 0) / results.length;
    console.log(
      `mean | ${''.padStart(10)} | ${meanV2.toFixed(4).padStart(8)} | ${meanBaseline.toFixed(4)}`,
    );
    expect(results).toHaveLength(3);
  });

  it('computes a non-trivial, finite Spearman correlation for every gameweek', () => {
    for (const r of results) {
      // "Non-trivial" here means large enough that a rank correlation is a
      // meaningful summary at all, not a coin-flip over a handful of
      // players -- comfortably above the smallest gameweek's fixture-count
      // driven floor (GW3 had only 7 fixtures, still >100 players featured).
      expect(r.populationSize).toBeGreaterThan(100);
      expect(Number.isFinite(r.v2Spearman)).toBe(true);
      expect(Number.isFinite(r.baselineSpearman)).toBe(true);
    }
  });

  it('v2 correlates positively with actual points on average across GW2-4', () => {
    // A per-gameweek assertion here would be brittle -- three real
    // gameweeks of Portuguese top-flight results is a small, noisy sample
    // (GW2's ratings are fit off just 9 finished fixtures), and a single
    // gameweek landing slightly negative would not mean the model is
    // broken. Averaging across the three backtested gameweeks is the
    // least brittle real claim this data supports: that model-v2's
    // ranking is, on the whole, informative rather than noise.
    const meanV2 = results.reduce((s, r) => s + r.v2Spearman, 0) / results.length;
    expect(meanV2).toBeGreaterThan(0);
  });
});
