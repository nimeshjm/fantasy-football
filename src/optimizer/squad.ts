/**
 * Squad builder: pick a legal 15 maximising horizon-weighted, starting-XI-
 * aware expected points.
 *
 * Pure function, typed-array hot path, explicitly bounded search -- see the
 * PERFORMANCE section of the task brief. Nothing here touches D1/fetch/env;
 * everything is arrays and records in, values out.
 */

import {
  Position,
  RULES,
  type Element,
  type Pick,
  type Projection,
  type ValidationError,
} from '../types';

const POSITIONS = [Position.GK, Position.DEF, Position.MID, Position.FWD] as const;

/** Non-null indexed read. `noUncheckedIndexedAccess` types every numeric
 * index read (plain arrays AND typed arrays) as possibly-`undefined`; every
 * call site below only ever indexes within a length it just checked or
 * built, so the assertion is safe and keeps the arithmetic-heavy hot path
 * readable instead of drowning in inline `!`. */
function at<T>(arr: { readonly [i: number]: T }, i: number): T {
  return arr[i] as T;
}

// ---------------------------------------------------------------------------
// Candidate model & horizon scoring
// ---------------------------------------------------------------------------

/** One selectable player, with a single already-horizon-weighted score.
 * Build this from raw `Element[]` + one or more gameweeks of `Projection[]`
 * via `buildHorizonScores`, or assemble it yourself if you have a different
 * horizon-weighting scheme in mind. */
export interface SquadCandidate {
  element: number;
  position: Position;
  team: number;
  now_cost: number;
  /** Horizon-weighted expected points -- the sole objective the search
   * maximises. NOT the same as a single gameweek's xpts once a multi-week
   * horizon is in play. */
  score: number;
}

/**
 * Combines several gameweeks' worth of `Projection[]` into one
 * horizon-weighted score per element: `sum_w weight[w] * xpts_w(element)`.
 * A player absent from a given gameweek's projections (blank gameweek, or
 * simply not projected) contributes 0 for that week rather than throwing.
 * `weights[i]` pairs with `projectionsByGw[i]`; extra entries on either
 * side beyond the shorter length are ignored.
 */
export function buildHorizonScores(
  projectionsByGw: readonly (readonly Projection[])[],
  weights: readonly number[],
): Map<number, number> {
  const scores = new Map<number, number>();
  const weeks = Math.min(projectionsByGw.length, weights.length);
  for (let w = 0; w < weeks; w++) {
    const weight = at(weights, w);
    if (weight === 0) continue;
    for (const p of at(projectionsByGw, w)) {
      scores.set(p.element_id, (scores.get(p.element_id) ?? 0) + weight * p.xpts);
    }
  }
  return scores;
}

/** Convenience: builds `SquadCandidate[]` from elements + a horizon score
 * map (e.g. from `buildHorizonScores`). Elements absent from the score map
 * score 0 (still selectable, just worthless to the objective). */
export function candidatesFromElements(
  elements: readonly Element[],
  scores: ReadonlyMap<number, number>,
): SquadCandidate[] {
  return elements.map((e) => ({
    element: e.id,
    position: e.element_type,
    team: e.team,
    now_cost: e.now_cost,
    score: scores.get(e.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Formations (starting-XI-aware objective)
// ---------------------------------------------------------------------------

interface Formation {
  gk: number;
  def: number;
  mid: number;
  fwd: number;
}

/** Every legal starting formation under `RULES.play`, computed from the
 * rules rather than hardcoded. The space is tiny (a handful of
 * combinations), so this is enumerated fully and cheaply once per process,
 * not searched. */
function enumerateFormations(): Formation[] {
  const { play, squadPlay } = RULES;
  const out: Formation[] = [];
  for (let gk = play[Position.GK].min; gk <= play[Position.GK].max; gk++) {
    for (let def = play[Position.DEF].min; def <= play[Position.DEF].max; def++) {
      for (let mid = play[Position.MID].min; mid <= play[Position.MID].max; mid++) {
        const fwd = squadPlay - gk - def - mid;
        if (fwd < play[Position.FWD].min || fwd > play[Position.FWD].max) continue;
        out.push({ gk, def, mid, fwd });
      }
    }
  }
  return out;
}

const FORMATIONS = enumerateFormations();

/** Reusable scratch buffers for `scoreSquad`, one {sorted, prefix} pair per
 * position. Allocated ONCE per search (see `buildSquad`) and mutated in
 * place on every call -- with `FORMATIONS.length` (~10-15) candidate
 * formations to try per evaluation, sorting each position ONCE and reusing
 * the prefix sums across every formation (instead of re-sorting per
 * formation) is what keeps a single `scoreSquad` call cheap enough for a
 * many-thousand-evaluation search to fit the 10ms budget (see
 * `DEFAULT_MAX_EVALUATIONS` for the actual measured cost per evaluation). */
interface ScoreScratch {
  sorted: Record<Position, number[]>;
  prefix: Record<Position, number[]>;
}

function makeScoreScratch(): ScoreScratch {
  return {
    sorted: { [Position.GK]: [], [Position.DEF]: [], [Position.MID]: [], [Position.FWD]: [] },
    prefix: { [Position.GK]: [0], [Position.DEF]: [0], [Position.MID]: [0], [Position.FWD]: [0] },
  };
}

/** Fills `prefix` with running sums of an ALREADY-sorted-descending
 * `sorted` (`prefix[0] = 0`, `prefix[k]` = sum of the top `k`). Mutates
 * `prefix` in place -- no allocation. */
function fillPrefixFromSorted(sorted: readonly number[], prefix: number[]): void {
  prefix.length = 1;
  prefix[0] = 0;
  for (let i = 0; i < sorted.length; i++) prefix.push(at(prefix, i) + at(sorted, i));
}

/** Sorts `values` descending into `sorted` and fills `prefix` with running
 * sums, both reused buffers mutated in place -- no allocation. */
function fillPrefix(values: readonly number[], sorted: number[], prefix: number[]): void {
  sorted.length = 0;
  for (const v of values) sorted.push(v);
  sorted.sort((a, b) => b - a);
  fillPrefixFromSorted(sorted, prefix);
}

/** Best starting-XI value from a `ScoreScratch`'s cached per-position prefix
 * sums -- no sorting, no allocation, just `FORMATIONS.length` cheap lookups. */
function computeBestXi(scratch: ScoreScratch): number {
  let bestXi = 0;
  for (const f of FORMATIONS) {
    const xi =
      at(scratch.prefix[Position.GK], f.gk) +
      at(scratch.prefix[Position.DEF], f.def) +
      at(scratch.prefix[Position.MID], f.mid) +
      at(scratch.prefix[Position.FWD], f.fwd);
    if (xi > bestXi) bestXi = xi;
  }
  return bestXi;
}

/** Same as `computeBestXi`, but with one position's prefix sums swapped out
 * for a trial array -- used to score a hypothetical 1-for-1 swap without
 * touching (or re-sorting) the other three positions' cached state. */
function computeBestXiOverride1(
  scratch: ScoreScratch,
  overridePos: Position,
  overridePrefix: readonly number[],
): number {
  let bestXi = 0;
  for (const f of FORMATIONS) {
    const gk = overridePos === Position.GK ? overridePrefix : scratch.prefix[Position.GK];
    const def = overridePos === Position.DEF ? overridePrefix : scratch.prefix[Position.DEF];
    const mid = overridePos === Position.MID ? overridePrefix : scratch.prefix[Position.MID];
    const fwd = overridePos === Position.FWD ? overridePrefix : scratch.prefix[Position.FWD];
    const xi = at(gk, f.gk) + at(def, f.def) + at(mid, f.mid) + at(fwd, f.fwd);
    if (xi > bestXi) bestXi = xi;
  }
  return bestXi;
}

/** Same idea as `computeBestXiOverride1`, but for a 2-for-2 trial touching
 * two distinct positions at once. */
function computeBestXiOverride2(
  scratch: ScoreScratch,
  posA: Position,
  prefixA: readonly number[],
  posB: Position,
  prefixB: readonly number[],
): number {
  let bestXi = 0;
  for (const f of FORMATIONS) {
    const gk =
      posA === Position.GK ? prefixA : posB === Position.GK ? prefixB : scratch.prefix[Position.GK];
    const def =
      posA === Position.DEF
        ? prefixA
        : posB === Position.DEF
          ? prefixB
          : scratch.prefix[Position.DEF];
    const mid =
      posA === Position.MID
        ? prefixA
        : posB === Position.MID
          ? prefixB
          : scratch.prefix[Position.MID];
    const fwd =
      posA === Position.FWD
        ? prefixA
        : posB === Position.FWD
          ? prefixB
          : scratch.prefix[Position.FWD];
    const xi = at(gk, f.gk) + at(def, f.def) + at(mid, f.mid) + at(fwd, f.fwd);
    if (xi > bestXi) bestXi = xi;
  }
  return bestXi;
}

/** Removes one occurrence of `value` from `arr` (by value, not index) --
 * used to pull a specific player's score out of a small sorted position
 * group before inserting a replacement's. */
function removeOneValue(arr: number[], value: number): void {
  const idx = arr.indexOf(value);
  if (idx !== -1) arr.splice(idx, 1);
}

/**
 * Starting-XI-aware score for one candidate 15: `benchWeight * totalSquad +
 * (1 - benchWeight) * bestStartingXIValue`. A naive sum-of-15 objective
 * happily buys 15 expensive starters' worth of player and wastes 4 slots on
 * a bench that will almost never play; weighting the bench down (default
 * 0.12) makes a cheap, low-score bench free from the objective's point of
 * view, which is the correct incentive -- the bench exists for autosub
 * insurance and budget flexibility, not points.
 *
 * Used to score a FULL squad from scratch (the greedy seed, and once per
 * accepted swap to refresh `state.score`) -- NOT in the swap-trial hot
 * loop, which instead uses the incremental `computeBestXiOverride*` helpers
 * above so it never re-sorts an unaffected position.
 */
function scoreSquad(
  byPosition: Readonly<Record<Position, number[]>>,
  benchWeight: number,
  scratch: ScoreScratch,
): number {
  let total = 0;
  for (const pos of POSITIONS) for (const v of byPosition[pos]) total += v;
  for (const pos of POSITIONS)
    fillPrefix(byPosition[pos], scratch.sorted[pos], scratch.prefix[pos]);
  return benchWeight * total + (1 - benchWeight) * computeBestXi(scratch);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface BuildSquadOptions {
  budget?: number;
  teamLimit?: number;
  /** Weight applied to bench players' contribution in the objective (the
   * rest, `1 - benchWeight`, goes to the best starting XI). Default 0.12:
   * bench players still nudge the objective (so ties break toward a
   * slightly-better bench) without being anywhere near as valuable as a
   * starter. */
  benchWeight?: number;
  /** Hard cap on total squad-score evaluations across the whole search
   * (greedy seed excluded -- that's a single O(n log n) sort). This is the
   * knob the 10ms Worker budget is enforced through: ~200k simple typed-
   * array evaluations cost ~1.9ms per the measured reference in the brief,
   * so the default here is picked to leave comfortable headroom. */
  maxEvaluations?: number;
  /** Independent greedy-seed + local-search attempts; the best result
   * across all of them is returned. Each restart perturbs the greedy seed's
   * tie-breaking via the seeded PRNG below, so restarts explore genuinely
   * different starting points rather than reconverging immediately. */
  maxRestarts?: number;
  /** Steepest-descent rounds of 1-for-1 swaps per restart. Each round
   * either applies the single best improving swap found or stops. */
  max1for1Rounds?: number;
  /** Steepest-descent rounds of 2-for-2 swaps per restart, run after the
   * 1-for-1 phase settles. */
  max2for2Rounds?: number;
  /** How many top-scoring not-yet-owned candidates per position to
   * consider as swap-in options for a 1-for-1 trial. Keeps every swap
   * evaluation O(1)-ish regardless of how large the full candidate pool
   * is. A 1-for-1 trial is cheap (one squad slot at a time), so this can
   * afford to be generous. */
  swapCandidatesPerPosition?: number;
  /** Same idea as `swapCandidatesPerPosition`, but for 2-for-2 trials.
   * Kept much smaller by default: a 2-for-2 round tries every pair of
   * squad slots (up to `C(15,2)` = 105) against `K^2` incoming pairs, so
   * this parameter's cost is QUADRATIC where `swapCandidatesPerPosition`'s
   * is linear -- doubling it roughly quadruples the round's work. */
  doubleSwapCandidatesPerPosition?: number;
  /** Deterministic PRNG seed (mulberry32). Same seed + same inputs always
   * returns the same squad -- important for tests and for not surprising a
   * user with a different answer on every run of an otherwise-unchanged
   * gameweek. */
  seed?: number;
}

export interface BuildSquadResult {
  picks: Pick[];
  projectedPoints: number;
  feasible: boolean;
}

const DEFAULT_BENCH_WEIGHT = 0.12;
/**
 * Hard cap on total squad-score evaluations across the whole search
 * (greedy seed excluded -- that's a single O(n log n) sort). Measured
 * against the real 656-candidate bootstrap fixture, each evaluation here
 * costs roughly 500ns (it searches every legal formation via cached prefix
 * sums, not a single raw comparison), so 15,000 evaluations is a ~7-8ms
 * ceiling -- comfortably inside the 10ms Worker budget with headroom for
 * the rest of a request. See test/optimizer.test.ts's wall-clock test.
 */
/**
 * Search budget, chosen by measurement against the 10 ms Worker CPU limit on
 * the free plan — NOT picked for headroom's sake.
 *
 * Measured cold (fresh isolate, 656 real candidates from the bootstrap
 * fixture), which is the case that matters: a cron-triggered Worker frequently
 * runs cold and pays JIT warmup inside the same 10 ms budget.
 *
 *   evals/restarts   cold cost   solution xPts
 *   15000 / 4        13.8 ms     157.90   <- over the CPU limit
 *    8000 / 3         9.7 ms     157.90   <- at the limit, no margin
 *    4000 / 2         5.4 ms     157.90   <- same answer, fits with margin
 *    3000 / 2         4.9 ms     154.30   <- starts losing quality
 *
 * So 4000/2 is not a compromise: the search has fully converged by 4000 on
 * real data, and the previous 15000/4 default spent 2.5x the CPU budget to
 * reach an identical squad. Under-converging on some other score distribution
 * would cost solution quality, not legality — `buildSquad` returns a legal
 * squad or `feasible: false` either way.
 */
const DEFAULT_MAX_EVALUATIONS = 4_000;
const DEFAULT_MAX_RESTARTS = 2;
const DEFAULT_MAX_1FOR1_ROUNDS = 30;
const DEFAULT_MAX_2FOR2_ROUNDS = 10;
const DEFAULT_SWAP_CANDIDATES_PER_POSITION = 12;
/** Small on purpose -- see `doubleSwapCandidatesPerPosition`'s doc: this
 * parameter's cost is quadratic, not linear. */
const DEFAULT_DOUBLE_SWAP_CANDIDATES_PER_POSITION = 6;

/** mulberry32: tiny, fast, deterministic PRNG -- more than sufficient for
 * tie-breaking a greedy seed, and avoids pulling in a dependency for it. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pool {
  n: number;
  ids: Int32Array;
  positions: Int32Array;
  teams: Int32Array;
  costs: Int32Array;
  scores: Float64Array;
}

function buildPool(candidates: readonly SquadCandidate[]): Pool {
  const n = candidates.length;
  const ids = new Int32Array(n);
  const positions = new Int32Array(n);
  const teams = new Int32Array(n);
  const costs = new Int32Array(n);
  const scores = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = at(candidates, i);
    ids[i] = c.element;
    positions[i] = c.position;
    teams[i] = c.team;
    costs[i] = c.now_cost;
    scores[i] = c.score;
  }
  return { n, ids, positions, teams, costs, scores };
}

/** Greedy seed: repeatedly take the best not-yet-full-quota, affordable,
 * team-limit-respecting candidate by score/cost density. This is a single
 * pass over a pre-sorted index list (O(n log n) once, O(n) to consume), not
 * a search -- the local search below does the actual optimisation. */
function greedySeed(
  pool: Pool,
  budget: number,
  teamLimit: number,
  quotas: Readonly<Record<Position, number>>,
  rng: () => number,
): number[] | null {
  const order = Array.from({ length: pool.n }, (_, i) => i);
  // Tiny random jitter on the density tie-break so restarts genuinely
  // diversify instead of reproducing the same seed every time.
  const density = new Float64Array(pool.n);
  for (let i = 0; i < pool.n; i++) {
    density[i] = at(pool.scores, i) / Math.max(at(pool.costs, i), 1) + rng() * 1e-6;
  }
  order.sort((a, b) => at(density, b) - at(density, a));

  const remaining: Record<Position, number> = { ...quotas };
  const teamCounts = new Map<number, number>();
  let budgetLeft = budget;
  const squad: number[] = [];

  for (const i of order) {
    const pos = at(pool.positions, i) as Position;
    if (remaining[pos] <= 0) continue;
    const team = at(pool.teams, i);
    const teamCount = teamCounts.get(team) ?? 0;
    if (teamCount >= teamLimit) continue;
    const cost = at(pool.costs, i);
    if (cost > budgetLeft) continue;
    squad.push(i);
    remaining[pos] -= 1;
    teamCounts.set(team, teamCount + 1);
    budgetLeft -= cost;
    if (squad.length === RULES.squadSize) break;
  }

  if (squad.length === RULES.squadSize) return squad;

  // Fallback pass: quotas unmet by the density-greedy pass are filled
  // cheapest-first, maximising the chance of a feasible squad even when the
  // score-optimal greedy choice left an expensive position short.
  const byCost = Array.from({ length: pool.n }, (_, i) => i).sort(
    (a, b) => at(pool.costs, a) - at(pool.costs, b),
  );
  for (const i of byCost) {
    if (squad.length === RULES.squadSize) break;
    const pos = at(pool.positions, i) as Position;
    if (remaining[pos] <= 0) continue;
    if (squad.includes(i)) continue;
    const team = at(pool.teams, i);
    const teamCount = teamCounts.get(team) ?? 0;
    if (teamCount >= teamLimit) continue;
    const cost = at(pool.costs, i);
    if (cost > budgetLeft) continue;
    squad.push(i);
    remaining[pos] -= 1;
    teamCounts.set(team, teamCount + 1);
    budgetLeft -= cost;
  }

  return squad.length === RULES.squadSize ? squad : null;
}

function groupByPosition(pool: Pool, squad: readonly number[]): Record<Position, number[]> {
  const byPosition: Record<Position, number[]> = {
    [Position.GK]: [],
    [Position.DEF]: [],
    [Position.MID]: [],
    [Position.FWD]: [],
  };
  for (const i of squad) byPosition[at(pool.positions, i) as Position].push(at(pool.scores, i));
  return byPosition;
}

/** Per-search-state cache: the CURRENTLY ACCEPTED squad's per-position
 * sorted scores + prefix sums (kept in sync incrementally by the swap
 * functions below), plus the running total and objective score. Rebuilding
 * this from scratch happens only once per restart (in `makeState`) -- every
 * accepted swap thereafter patches just the position(s) it touched. */
interface SearchState {
  squad: number[]; // pool indices, length 15
  teamCounts: Map<number, number>;
  budgetLeft: number;
  scratch: ScoreScratch;
  total: number;
  score: number;
}

/** Small reusable buffers for building a TRIAL (not-yet-accepted) 1 or
 * 2-position prefix-sum override during the swap-evaluation hot loop.
 * Allocated once per `buildSquad` call and reused across every trial. */
interface TrialScratch {
  sortedA: number[];
  prefixA: number[];
  sortedB: number[];
  prefixB: number[];
}

function makeTrialScratch(): TrialScratch {
  return { sortedA: [], prefixA: [0], sortedB: [], prefixB: [0] };
}

function makeState(
  pool: Pool,
  squad: readonly number[],
  budget: number,
  benchWeight: number,
): SearchState {
  const teamCounts = new Map<number, number>();
  let cost = 0;
  for (const i of squad) {
    const team = at(pool.teams, i);
    teamCounts.set(team, (teamCounts.get(team) ?? 0) + 1);
    cost += at(pool.costs, i);
  }
  const scratch = makeScoreScratch();
  const byPosition = groupByPosition(pool, squad);
  let total = 0;
  for (const pos of POSITIONS) {
    fillPrefix(byPosition[pos], scratch.sorted[pos], scratch.prefix[pos]);
    for (const v of byPosition[pos]) total += v;
  }
  const score = benchWeight * total + (1 - benchWeight) * computeBestXi(scratch);
  return { squad: [...squad], teamCounts, budgetLeft: budget - cost, scratch, total, score };
}

/** Every pool index for one position, sorted descending by score ONCE
 * (the pool's scores never change during a search) -- reused by every
 * restart and every round via `topCandidatesForPosition` instead of
 * re-filtering-and-sorting the whole pool on every call. */
function sortPoolByPosition(pool: Pool): Record<Position, number[]> {
  const byPosition: Record<Position, number[]> = {
    [Position.GK]: [],
    [Position.DEF]: [],
    [Position.MID]: [],
    [Position.FWD]: [],
  };
  for (let i = 0; i < pool.n; i++) byPosition[at(pool.positions, i) as Position].push(i);
  for (const pos of POSITIONS)
    byPosition[pos].sort((a, b) => at(pool.scores, b) - at(pool.scores, a));
  return byPosition;
}

/** Top-K not-in-squad candidate indices for one position, by raw score.
 * `sortedPosition` is that position's full pool, already sorted descending
 * (see `sortPoolByPosition`) -- this just walks it in order and skips
 * owned indices, so it's O(k + a few) rather than O(pool size * log). */
function topCandidatesForPosition(
  sortedPosition: readonly number[],
  inSquad: ReadonlySet<number>,
  k: number,
): number[] {
  const out: number[] = [];
  for (const i of sortedPosition) {
    if (inSquad.has(i)) continue;
    out.push(i);
    if (out.length >= k) break;
  }
  return out;
}

/** One steepest-descent round of same-position 1-for-1 swaps: finds the
 * single best-improving (out, in) pair across every squad slot and its
 * top-K same-position replacement candidates, applies it if it improves the
 * score, and reports whether it did (the caller loops this until it
 * doesn't, or a round cap is hit).
 *
 * Every trial evaluation is incremental: only the ONE affected position's
 * small (<=5-element) sorted/prefix array is rebuilt into `trial`; the
 * other three positions' cached prefix sums in `state.scratch` are reused
 * untouched via `computeBestXiOverride1`. This is what keeps a trial cheap
 * regardless of squad size or how many candidates are tried -- no full
 * squad clone, no full `groupByPosition`/`scoreSquad` re-run per trial. */
function try1for1Round(
  pool: Pool,
  sortedPoolByPosition: Readonly<Record<Position, number[]>>,
  state: SearchState,
  teamLimit: number,
  benchWeight: number,
  candidatesPerPosition: number,
  evalBudget: { remaining: number },
  trial: TrialScratch,
): boolean {
  const inSquad = new Set(state.squad);
  let bestDelta = 0;
  let bestOut = -1;
  let bestIn = -1;

  for (const pos of POSITIONS) {
    const topIn = topCandidatesForPosition(
      sortedPoolByPosition[pos],
      inSquad,
      candidatesPerPosition,
    );
    const baseSorted = state.scratch.sorted[pos];
    for (const outIdx of state.squad) {
      if (at(pool.positions, outIdx) !== pos) continue;
      const outScore = at(pool.scores, outIdx);
      const outCost = at(pool.costs, outIdx);
      const outTeam = at(pool.teams, outIdx);
      for (const inIdx of topIn) {
        if (evalBudget.remaining <= 0) break;
        evalBudget.remaining--;
        const inCost = at(pool.costs, inIdx);
        if (state.budgetLeft + outCost - inCost < 0) continue;
        const inTeam = at(pool.teams, inIdx);
        const inCount = state.teamCounts.get(inTeam) ?? 0;
        const sameTeam = outTeam === inTeam;
        if (!sameTeam && inCount + 1 > teamLimit) continue;
        if (sameTeam && inCount > teamLimit) continue;

        const inScore = at(pool.scores, inIdx);
        trial.sortedA.length = 0;
        for (const v of baseSorted) trial.sortedA.push(v);
        removeOneValue(trial.sortedA, outScore);
        trial.sortedA.push(inScore);
        trial.sortedA.sort((a, b) => b - a);
        fillPrefixFromSorted(trial.sortedA, trial.prefixA);

        const newTotal = state.total - outScore + inScore;
        const newBestXi = computeBestXiOverride1(state.scratch, pos, trial.prefixA);
        const candidateScore = benchWeight * newTotal + (1 - benchWeight) * newBestXi;
        const delta = candidateScore - state.score;
        if (delta > bestDelta) {
          bestDelta = delta;
          bestOut = outIdx;
          bestIn = inIdx;
        }
      }
      if (evalBudget.remaining <= 0) break;
    }
    if (evalBudget.remaining <= 0) break;
  }

  if (bestOut === -1) return false;

  const pos = at(pool.positions, bestOut) as Position;
  const outScore = at(pool.scores, bestOut);
  const inScore = at(pool.scores, bestIn);
  const outCost = at(pool.costs, bestOut);
  const inCost = at(pool.costs, bestIn);
  const outTeam = at(pool.teams, bestOut);
  const inTeam = at(pool.teams, bestIn);

  state.squad = state.squad.map((i) => (i === bestOut ? bestIn : i));
  state.budgetLeft = state.budgetLeft + outCost - inCost;
  state.teamCounts.set(outTeam, (state.teamCounts.get(outTeam) ?? 1) - 1);
  state.teamCounts.set(inTeam, (state.teamCounts.get(inTeam) ?? 0) + 1);
  state.total = state.total - outScore + inScore;

  const sorted = state.scratch.sorted[pos];
  removeOneValue(sorted, outScore);
  sorted.push(inScore);
  sorted.sort((a, b) => b - a);
  fillPrefixFromSorted(sorted, state.scratch.prefix[pos]);

  state.score = benchWeight * state.total + (1 - benchWeight) * computeBestXi(state.scratch);
  return true;
}

/** Builds a same-position combined trial: removes TWO scores and adds TWO
 * scores from one position group, into `trial.sortedA`/`trial.prefixA`. */
function buildCombinedTrial(
  baseSorted: readonly number[],
  removeScores: readonly [number, number],
  addScores: readonly [number, number],
  trial: TrialScratch,
): void {
  trial.sortedA.length = 0;
  for (const v of baseSorted) trial.sortedA.push(v);
  removeOneValue(trial.sortedA, removeScores[0]);
  removeOneValue(trial.sortedA, removeScores[1]);
  trial.sortedA.push(addScores[0], addScores[1]);
  trial.sortedA.sort((a, b) => b - a);
  fillPrefixFromSorted(trial.sortedA, trial.prefixA);
}

/** Builds a single-position trial (remove one score, add one) into the
 * given `sortedBuf`/`prefixBuf` pair. */
function buildSingleTrial(
  baseSorted: readonly number[],
  removeScore: number,
  addScore: number,
  sortedBuf: number[],
  prefixBuf: number[],
): void {
  sortedBuf.length = 0;
  for (const v of baseSorted) sortedBuf.push(v);
  removeOneValue(sortedBuf, removeScore);
  sortedBuf.push(addScore);
  sortedBuf.sort((a, b) => b - a);
  fillPrefixFromSorted(sortedBuf, prefixBuf);
}

/** One steepest-descent round of 2-for-2 swaps. Unlike 1-for-1, the two
 * removed players may be in different positions -- as long as the pair of
 * incoming players matches the same two positions, quotas stay exact. This
 * catches budget-reshuffling improvements a same-position-only search can't
 * reach (e.g. downgrade a DEF and upgrade a MID for the same total spend).
 *
 * Like `try1for1Round`, every trial only rebuilds the 1-2 affected
 * position(s)' small sorted/prefix arrays (via `computeBestXiOverride1/2`),
 * never the whole squad. */
function try2for2Round(
  pool: Pool,
  sortedPoolByPosition: Readonly<Record<Position, number[]>>,
  state: SearchState,
  teamLimit: number,
  benchWeight: number,
  candidatesPerPosition: number,
  evalBudget: { remaining: number },
  trial: TrialScratch,
): boolean {
  const inSquad = new Set(state.squad);
  const topByPosition = new Map<Position, number[]>();
  for (const pos of POSITIONS) {
    topByPosition.set(
      pos,
      topCandidatesForPosition(sortedPoolByPosition[pos], inSquad, candidatesPerPosition),
    );
  }

  let bestDelta = 0;
  let bestOutA = -1;
  let bestOutB = -1;
  let bestInA = -1;
  let bestInB = -1;

  for (let a = 0; a < state.squad.length; a++) {
    for (let b = a + 1; b < state.squad.length; b++) {
      if (evalBudget.remaining <= 0) break;
      const outA = at(state.squad, a);
      const outB = at(state.squad, b);
      const posA = at(pool.positions, outA) as Position;
      const posB = at(pool.positions, outB) as Position;
      const outAScore = at(pool.scores, outA);
      const outBScore = at(pool.scores, outB);
      const freedBudget = state.budgetLeft + at(pool.costs, outA) + at(pool.costs, outB);

      const candA = topByPosition.get(posA) ?? [];
      const candB = topByPosition.get(posB) ?? [];
      for (const inA of candA) {
        if (inA === outA || inA === outB) continue;
        for (const inB of candB) {
          if (inB === outA || inB === outB || inB === inA) continue;
          if (evalBudget.remaining <= 0) break;
          evalBudget.remaining--;

          const cost = at(pool.costs, inA) + at(pool.costs, inB);
          if (cost > freedBudget) continue;

          const outATeam = at(pool.teams, outA);
          const outBTeam = at(pool.teams, outB);
          const inATeam = at(pool.teams, inA);
          const inBTeam = at(pool.teams, inB);
          const teamDelta = new Map<number, number>();
          teamDelta.set(outATeam, (teamDelta.get(outATeam) ?? 0) - 1);
          teamDelta.set(outBTeam, (teamDelta.get(outBTeam) ?? 0) - 1);
          teamDelta.set(inATeam, (teamDelta.get(inATeam) ?? 0) + 1);
          teamDelta.set(inBTeam, (teamDelta.get(inBTeam) ?? 0) + 1);
          let teamLimitOk = true;
          for (const [team, delta] of teamDelta) {
            if ((state.teamCounts.get(team) ?? 0) + delta > teamLimit) {
              teamLimitOk = false;
              break;
            }
          }
          if (!teamLimitOk) continue;

          const inAScore = at(pool.scores, inA);
          const inBScore = at(pool.scores, inB);
          const newTotal = state.total - outAScore - outBScore + inAScore + inBScore;

          let newBestXi: number;
          if (posA === posB) {
            buildCombinedTrial(
              state.scratch.sorted[posA],
              [outAScore, outBScore],
              [inAScore, inBScore],
              trial,
            );
            newBestXi = computeBestXiOverride1(state.scratch, posA, trial.prefixA);
          } else {
            buildSingleTrial(
              state.scratch.sorted[posA],
              outAScore,
              inAScore,
              trial.sortedA,
              trial.prefixA,
            );
            buildSingleTrial(
              state.scratch.sorted[posB],
              outBScore,
              inBScore,
              trial.sortedB,
              trial.prefixB,
            );
            newBestXi = computeBestXiOverride2(
              state.scratch,
              posA,
              trial.prefixA,
              posB,
              trial.prefixB,
            );
          }

          const candidateScore = benchWeight * newTotal + (1 - benchWeight) * newBestXi;
          const delta = candidateScore - state.score;
          if (delta > bestDelta) {
            bestDelta = delta;
            bestOutA = outA;
            bestOutB = outB;
            bestInA = inA;
            bestInB = inB;
          }
        }
      }
    }
    if (evalBudget.remaining <= 0) break;
  }

  if (bestOutA === -1) return false;

  const posA = at(pool.positions, bestOutA) as Position;
  const posB = at(pool.positions, bestOutB) as Position;
  const outAScore = at(pool.scores, bestOutA);
  const outBScore = at(pool.scores, bestOutB);
  const inAScore = at(pool.scores, bestInA);
  const inBScore = at(pool.scores, bestInB);
  const outACost = at(pool.costs, bestOutA);
  const outBCost = at(pool.costs, bestOutB);
  const inACost = at(pool.costs, bestInA);
  const inBCost = at(pool.costs, bestInB);

  state.squad = state.squad.map((i) => {
    if (i === bestOutA) return bestInA;
    if (i === bestOutB) return bestInB;
    return i;
  });
  state.budgetLeft = state.budgetLeft + outACost + outBCost - inACost - inBCost;
  const deltas: Array<readonly [number, number]> = [
    [at(pool.teams, bestOutA), -1],
    [at(pool.teams, bestOutB), -1],
    [at(pool.teams, bestInA), 1],
    [at(pool.teams, bestInB), 1],
  ];
  for (const [team, delta] of deltas) {
    state.teamCounts.set(team, (state.teamCounts.get(team) ?? 0) + delta);
  }
  state.total = state.total - outAScore - outBScore + inAScore + inBScore;

  if (posA === posB) {
    const sorted = state.scratch.sorted[posA];
    removeOneValue(sorted, outAScore);
    removeOneValue(sorted, outBScore);
    sorted.push(inAScore, inBScore);
    sorted.sort((x, y) => y - x);
    fillPrefixFromSorted(sorted, state.scratch.prefix[posA]);
  } else {
    const sortedA = state.scratch.sorted[posA];
    removeOneValue(sortedA, outAScore);
    sortedA.push(inAScore);
    sortedA.sort((x, y) => y - x);
    fillPrefixFromSorted(sortedA, state.scratch.prefix[posA]);

    const sortedB = state.scratch.sorted[posB];
    removeOneValue(sortedB, outBScore);
    sortedB.push(inBScore);
    sortedB.sort((x, y) => y - x);
    fillPrefixFromSorted(sortedB, state.scratch.prefix[posB]);
  }

  state.score = benchWeight * state.total + (1 - benchWeight) * computeBestXi(state.scratch);
  return true;
}

/** Splits a finished squad into starters (best formation) and bench, and
 * emits `Pick[]` with `position` 1-11 for starters / 12-15 for bench.
 * Captain/vice-captain are NOT set here -- that is `lineup.ts`'s job once
 * this squad is actually being played week to week. */
function toPicks(pool: Pool, squad: readonly number[]): Pick[] {
  const byPosition: Record<Position, number[]> = {
    [Position.GK]: [],
    [Position.DEF]: [],
    [Position.MID]: [],
    [Position.FWD]: [],
  };
  for (const i of squad) byPosition[at(pool.positions, i) as Position].push(i);
  for (const pos of POSITIONS)
    byPosition[pos].sort((a, b) => at(pool.scores, b) - at(pool.scores, a));

  let bestFormation: Formation = at(FORMATIONS, 0);
  let bestXi = -Infinity;
  const scratch: ScoreScratch = makeScoreScratch();
  for (const pos of POSITIONS) {
    fillPrefix(
      byPosition[pos].map((i) => at(pool.scores, i)),
      scratch.sorted[pos],
      scratch.prefix[pos],
    );
  }
  for (const f of FORMATIONS) {
    const xi =
      at(scratch.prefix[Position.GK], f.gk) +
      at(scratch.prefix[Position.DEF], f.def) +
      at(scratch.prefix[Position.MID], f.mid) +
      at(scratch.prefix[Position.FWD], f.fwd);
    if (xi > bestXi) {
      bestXi = xi;
      bestFormation = f;
    }
  }

  const starters: number[] = [
    ...byPosition[Position.GK].slice(0, bestFormation.gk),
    ...byPosition[Position.DEF].slice(0, bestFormation.def),
    ...byPosition[Position.MID].slice(0, bestFormation.mid),
    ...byPosition[Position.FWD].slice(0, bestFormation.fwd),
  ];
  const starterSet = new Set(starters);
  const bench: number[] = squad.filter((i) => !starterSet.has(i));

  const picks: Pick[] = [];
  starters.forEach((i, idx) => {
    picks.push({
      element: at(pool.ids, i),
      position: idx + 1,
      is_captain: false,
      is_vice_captain: false,
    });
  });
  bench.forEach((i, idx) => {
    picks.push({
      element: at(pool.ids, i),
      position: RULES.squadPlay + idx + 1,
      is_captain: false,
      is_vice_captain: false,
    });
  });
  return picks;
}

/**
 * Builds a legal 15 maximising horizon-weighted, starting-XI-aware expected
 * points. Bounded by `opts.maxEvaluations` (default 4,000) regardless of
 * pool size, restart count, or round caps -- the search always stops, and
 * always returns its best squad found so far.
 */
export function buildSquad(
  candidates: readonly SquadCandidate[],
  opts: BuildSquadOptions = {},
): BuildSquadResult {
  const budget = opts.budget ?? RULES.budget;
  const teamLimit = opts.teamLimit ?? RULES.teamLimit;
  const benchWeight = opts.benchWeight ?? DEFAULT_BENCH_WEIGHT;
  const maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const max1for1Rounds = opts.max1for1Rounds ?? DEFAULT_MAX_1FOR1_ROUNDS;
  const max2for2Rounds = opts.max2for2Rounds ?? DEFAULT_MAX_2FOR2_ROUNDS;
  const candidatesPerPosition =
    opts.swapCandidatesPerPosition ?? DEFAULT_SWAP_CANDIDATES_PER_POSITION;
  const doubleCandidatesPerPosition =
    opts.doubleSwapCandidatesPerPosition ?? DEFAULT_DOUBLE_SWAP_CANDIDATES_PER_POSITION;
  const evalBudget = { remaining: opts.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS };
  const rng = mulberry32(opts.seed ?? 0x5eed);

  const pool = buildPool(candidates);
  const sortedPoolByPosition = sortPoolByPosition(pool);
  const trial = makeTrialScratch();

  let best: SearchState | null = null;

  for (let restart = 0; restart < maxRestarts && evalBudget.remaining > 0; restart++) {
    const seed = greedySeed(pool, budget, teamLimit, RULES.squadSelect, rng);
    if (seed === null) continue;

    const state = makeState(pool, seed, budget, benchWeight);

    for (let r = 0; r < max1for1Rounds && evalBudget.remaining > 0; r++) {
      const improved = try1for1Round(
        pool,
        sortedPoolByPosition,
        state,
        teamLimit,
        benchWeight,
        candidatesPerPosition,
        evalBudget,
        trial,
      );
      if (!improved) break;
    }

    for (let r = 0; r < max2for2Rounds && evalBudget.remaining > 0; r++) {
      const improved = try2for2Round(
        pool,
        sortedPoolByPosition,
        state,
        teamLimit,
        benchWeight,
        doubleCandidatesPerPosition,
        evalBudget,
        trial,
      );
      if (!improved) break;
    }

    if (best === null || state.score > best.score) best = state;
  }

  if (best === null) {
    return { picks: [], projectedPoints: 0, feasible: false };
  }

  const picks = toPicks(pool, best.squad);
  let projectedPoints = 0;
  for (const i of best.squad) projectedPoints += at(pool.scores, i);

  return { picks, projectedPoints, feasible: true };
}

// ---------------------------------------------------------------------------
// Legality validation
// ---------------------------------------------------------------------------

/**
 * Structural legality of a 15-player squad: right size, right per-position
 * counts, no duplicate element, no club over `RULES.teamLimit`, and total
 * cost (looked up by id in `elements`) within `budget`.
 *
 * The budget check models "could this squad be bought from scratch for
 * `budget`" using each player's CURRENT `now_cost` -- correct for
 * `buildSquad`'s use case (drafting a squad), but NOT the right check for
 * an existing squad after a transfer, where retained players may have
 * risen in price above what was originally paid for them. Callers
 * validating a post-transfer squad should pass `budget: Number.POSITIVE_INFINITY`
 * and rely on their own selling-price-based affordability check instead
 * (see `transfers.ts`).
 */
export function isLegalSquad(
  picks: readonly Pick[],
  elements: readonly Element[],
  budget: number = RULES.budget,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const byId = new Map(elements.map((e) => [e.id, e]));

  if (picks.length !== RULES.squadSize) {
    errors.push({
      rule: 'squad-size',
      detail: `expected ${RULES.squadSize} picks, got ${picks.length}`,
    });
  }

  const seen = new Set<number>();
  for (const p of picks) {
    if (seen.has(p.element)) {
      errors.push({
        rule: 'duplicate-element',
        detail: `element ${p.element} picked more than once`,
      });
    }
    seen.add(p.element);
  }

  const counts: Record<Position, number> = {
    [Position.GK]: 0,
    [Position.DEF]: 0,
    [Position.MID]: 0,
    [Position.FWD]: 0,
  };
  const teamCounts = new Map<number, number>();
  let totalCost = 0;
  let missing = false;

  for (const p of picks) {
    const el = byId.get(p.element);
    if (!el) {
      errors.push({ rule: 'unknown-element', detail: `element ${p.element} not found` });
      missing = true;
      continue;
    }
    counts[el.element_type] += 1;
    teamCounts.set(el.team, (teamCounts.get(el.team) ?? 0) + 1);
    totalCost += el.now_cost;
  }

  if (!missing) {
    for (const pos of POSITIONS) {
      if (counts[pos] !== RULES.squadSelect[pos]) {
        errors.push({
          rule: 'position-quota',
          detail: `position ${pos}: expected ${RULES.squadSelect[pos]}, got ${counts[pos]}`,
        });
      }
    }
    for (const [team, count] of teamCounts) {
      if (count > RULES.teamLimit) {
        errors.push({
          rule: 'team-limit',
          detail: `team ${team}: ${count} players, limit ${RULES.teamLimit}`,
        });
      }
    }
    if (totalCost > budget) {
      errors.push({ rule: 'budget', detail: `total cost ${totalCost} exceeds budget ${budget}` });
    }
  }

  return errors;
}
