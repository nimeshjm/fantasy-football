/**
 * Transfer candidate generation: every legal single transfer, and the best
 * bounded search over double transfers, ranked by starting-XI-aware
 * horizon gain. Every candidate returned has already been validated legal
 * -- a later LLM step picks among them, so an illegal candidate must never
 * appear in the list (see `isLegalSquad` calls below).
 *
 * Pure function: no D1/fetch/env, arrays and records in, values out.
 */

import {
  Position,
  RULES,
  type Element,
  type Pick,
  type SquadState,
  type TransferMove,
} from '../types';
import type { Projection } from '../types';
import { buildHorizonScores, isLegalSquad } from './squad';

const POSITIONS = [Position.GK, Position.DEF, Position.MID, Position.FWD] as const;

/** Non-null indexed read -- see the identical helper in squad.ts for why
 * this is safe here: every call site indexes within a length it just
 * checked or built. */
function at<T>(arr: { readonly [i: number]: T }, i: number): T {
  return arr[i] as T;
}

interface Formation {
  gk: number;
  def: number;
  mid: number;
  fwd: number;
}

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

function sumTopKSorted(sortedDesc: readonly number[], k: number): number {
  let sum = 0;
  const n = Math.min(k, sortedDesc.length);
  for (let i = 0; i < n; i++) sum += at(sortedDesc, i);
  return sum;
}

/** Best starting-XI value given each position's scores ALREADY sorted
 * descending. Callers keep unaffected positions' arrays untouched between
 * evaluations and only re-sort the (small, <=5-element) group(s) a
 * candidate transfer actually changes -- this is the "incremental, not
 * re-solved from scratch" scoring the 656x15 single-candidate search
 * needs to stay inside the Worker's CPU budget. */
function bestXiValue(sortedByPosition: Readonly<Record<Position, readonly number[]>>): number {
  let best = 0;
  for (const f of FORMATIONS) {
    const value =
      sumTopKSorted(sortedByPosition[Position.GK], f.gk) +
      sumTopKSorted(sortedByPosition[Position.DEF], f.def) +
      sumTopKSorted(sortedByPosition[Position.MID], f.mid) +
      sumTopKSorted(sortedByPosition[Position.FWD], f.fwd);
    if (value > best) best = value;
  }
  return best;
}

/** Starting-XI-aware squad value: mirrors `squad.ts`'s objective so a
 * transfer's "gain" is measured the same way a squad is built -- a swap
 * that only improves bench depth barely moves this number. */
function squadValue(
  sortedByPosition: Readonly<Record<Position, readonly number[]>>,
  total: number,
  benchWeight: number,
): number {
  return benchWeight * total + (1 - benchWeight) * bestXiValue(sortedByPosition);
}

interface OwnedInfo {
  pickIndex: number;
  element: number;
  position: Position;
  team: number;
  sellingPrice: number;
  score: number;
}

interface PoolCandidate {
  element: number;
  position: Position;
  team: number;
  now_cost: number;
  score: number;
}

export interface CandidateTransfersOptions {
  /** Weight per horizon gameweek, aligned index-for-index with
   * `projectionsByGw`. Defaults to a 0.85-per-week decay -- later weeks
   * count for progressively less, reflecting compounding uncertainty. */
  horizonWeights?: readonly number[];
  /** Weight of total-squad value vs starting-XI value in the objective,
   * matching `squad.ts`'s default so transfer suggestions and squad
   * construction agree on what "better" means. */
  benchWeight?: number;
  teamLimit?: number;
  /** How many top single-transfer candidates to return. */
  maxSingle?: number;
  /** How many top double-transfer candidates to return (the double search
   * is a bounded heuristic, not exhaustive -- see `maxDoubleEvaluations`). */
  maxDouble?: number;
  /** Top-K not-owned candidates per position considered as the "in" half
   * of a double transfer. Keeps the O(pairs * K^2) double search bounded
   * regardless of pool size. */
  doubleCandidatesPerPosition?: number;
  /** Hard cap on double-transfer evaluations. 105 owned pairs * up to K^2
   * incoming pairs can exceed this for large K; the search stops early
   * (keeping whatever it's found) once the cap is hit. */
  maxDoubleEvaluations?: number;
}

export interface TransferCandidate {
  /** Length 1 for a single transfer, 2 for a double. */
  moves: TransferMove[];
  /** Starting-XI-aware horizon-weighted point gain vs standing pat. */
  gain: number;
  /** The resulting 15-man squad membership after applying `moves`. Not
   * lineup-ordered -- pass to `bestLineup` for an actual starting XI. */
  resultingSquad: Pick[];
}

const DEFAULT_HORIZON_DECAY = 0.85;
const DEFAULT_BENCH_WEIGHT = 0.12;
const DEFAULT_MAX_SINGLE = 10;
const DEFAULT_MAX_DOUBLE = 3;
const DEFAULT_DOUBLE_CANDIDATES_PER_POSITION = 12;
const DEFAULT_MAX_DOUBLE_EVALUATIONS = 20_000;

function insertRanked<T>(list: T[], item: T, gain: (t: T) => number, limit: number): void {
  let i = list.length;
  list.push(item);
  while (i > 0 && gain(at(list, i - 1)) < gain(at(list, i))) {
    const tmp = at(list, i - 1);
    list[i - 1] = at(list, i);
    list[i] = tmp;
    i--;
  }
  if (list.length > limit) list.length = limit;
}

function toResultingSquad(
  owned: readonly OwnedInfo[],
  excluded: ReadonlySet<number>,
  added: readonly PoolCandidate[],
): Pick[] {
  const kept = owned.filter((o) => !excluded.has(o.pickIndex));
  const picks: Pick[] = kept.map((o) => ({
    element: o.element,
    position: 0, // renumbered below
    is_captain: false,
    is_vice_captain: false,
  }));
  for (const a of added)
    picks.push({ element: a.element, position: 0, is_captain: false, is_vice_captain: false });
  picks.forEach((p, idx) => (p.position = idx + 1));
  return picks;
}

/**
 * Every legal single transfer (every owned player x every affordable
 * same-position replacement), plus a bounded search over double transfers,
 * ranked by starting-XI-aware horizon-weighted point gain. Every returned
 * candidate has passed `isLegalSquad` (composition/team-limit/no-duplicate;
 * budget is checked separately and precisely via selling price below, so
 * `isLegalSquad` is called with an unbounded budget here on purpose).
 */
export function candidateTransfers(
  state: SquadState,
  elements: readonly Element[],
  projections: readonly (readonly Projection[])[],
  opts: CandidateTransfersOptions = {},
): TransferCandidate[] {
  const benchWeight = opts.benchWeight ?? DEFAULT_BENCH_WEIGHT;
  const teamLimit = opts.teamLimit ?? RULES.teamLimit;
  const maxSingle = opts.maxSingle ?? DEFAULT_MAX_SINGLE;
  const maxDouble = opts.maxDouble ?? DEFAULT_MAX_DOUBLE;
  const doubleCandidatesPerPosition =
    opts.doubleCandidatesPerPosition ?? DEFAULT_DOUBLE_CANDIDATES_PER_POSITION;
  const horizonWeights =
    opts.horizonWeights ?? projections.map((_, i) => Math.pow(DEFAULT_HORIZON_DECAY, i));
  const evalBudget = { remaining: opts.maxDoubleEvaluations ?? DEFAULT_MAX_DOUBLE_EVALUATIONS };

  const byId = new Map(elements.map((e) => [e.id, e]));
  const scores = buildHorizonScores(projections, horizonWeights);

  const owned: OwnedInfo[] = state.picks.map((pick, pickIndex) => {
    const el = byId.get(pick.element);
    if (!el) throw new Error(`candidateTransfers: owned element ${pick.element} not found`);
    // Authoritative sale value per the brief: NEVER now_cost. Falls back to
    // purchase_price then now_cost only when the live my-team/ selling_price
    // is genuinely unavailable (e.g. synthetic test data) -- production
    // callers always have selling_price from the my-team/ response.
    const sellingPrice = pick.selling_price ?? pick.purchase_price ?? el.now_cost;
    return {
      pickIndex,
      element: pick.element,
      position: el.element_type,
      team: el.team,
      sellingPrice,
      score: scores.get(pick.element) ?? 0,
    };
  });
  const ownedIds = new Set(owned.map((o) => o.element));

  const pool: PoolCandidate[] = elements
    .filter((e) => !ownedIds.has(e.id) && e.can_select && e.can_transact && !e.removed)
    .map((e) => ({
      element: e.id,
      position: e.element_type,
      team: e.team,
      now_cost: e.now_cost,
      score: scores.get(e.id) ?? 0,
    }));

  const baselineByPosition: Record<Position, number[]> = {
    [Position.GK]: [],
    [Position.DEF]: [],
    [Position.MID]: [],
    [Position.FWD]: [],
  };
  for (const o of owned) baselineByPosition[o.position].push(o.score);
  for (const pos of POSITIONS) baselineByPosition[pos].sort((a, b) => b - a);
  let baselineTotal = 0;
  for (const o of owned) baselineTotal += o.score;
  const baselineValue = squadValue(baselineByPosition, baselineTotal, benchWeight);

  const teamCounts = new Map<number, number>();
  for (const o of owned) teamCounts.set(o.team, (teamCounts.get(o.team) ?? 0) + 1);

  const poolByPosition: Record<Position, PoolCandidate[]> = {
    [Position.GK]: [],
    [Position.DEF]: [],
    [Position.MID]: [],
    [Position.FWD]: [],
  };
  for (const c of pool) poolByPosition[c.position].push(c);
  for (const pos of POSITIONS) poolByPosition[pos].sort((a, b) => b.score - a.score);

  // -------------------------------------------------------------------
  // Singles: exhaustive over every owned player x every affordable
  // same-position replacement. Each evaluation only re-sorts the one
  // (<=6-element) affected position group -- incremental, not a full
  // squad re-solve.
  // -------------------------------------------------------------------
  const singles: TransferCandidate[] = [];
  const scratchGroup: number[] = [];

  for (const o of owned) {
    const available = state.bank + o.sellingPrice;
    const otherTeamCount = (teamCounts.get(o.team) ?? 0) - 1;

    for (const c of poolByPosition[o.position]) {
      if (c.now_cost > available) continue;
      const incomingTeamCount =
        c.team === o.team ? otherTeamCount + 1 : (teamCounts.get(c.team) ?? 0) + 1;
      if (incomingTeamCount > teamLimit) continue;

      scratchGroup.length = 0;
      for (const v of baselineByPosition[o.position]) scratchGroup.push(v);
      const removeIdx = scratchGroup.indexOf(o.score);
      if (removeIdx !== -1) scratchGroup.splice(removeIdx, 1);
      scratchGroup.push(c.score);
      scratchGroup.sort((a, b) => b - a);

      const newByPosition: Record<Position, readonly number[]> = {
        ...baselineByPosition,
        [o.position]: scratchGroup,
      };
      const newTotal = baselineTotal - o.score + c.score;
      const gain = squadValue(newByPosition, newTotal, benchWeight) - baselineValue;

      const move: TransferMove = {
        element_in: c.element,
        element_out: o.element,
        purchase_price: c.now_cost,
        selling_price: o.sellingPrice,
      };
      const resultingSquad = toResultingSquad(owned, new Set([o.pickIndex]), [c]);
      if (isLegalSquad(resultingSquad, elements, Number.POSITIVE_INFINITY).length > 0) continue;

      insertRanked(singles, { moves: [move], gain, resultingSquad }, (t) => t.gain, maxSingle);
    }
  }

  // -------------------------------------------------------------------
  // Doubles: bounded search, not exhaustive (C(15,2) * C(pool,2) is far
  // too large). For each pair of owned players, only the top-K pool
  // candidates per freed position are tried as replacements.
  // -------------------------------------------------------------------
  const doubles: TransferCandidate[] = [];

  outer: for (let a = 0; a < owned.length; a++) {
    for (let b = a + 1; b < owned.length; b++) {
      if (evalBudget.remaining <= 0) break outer;
      const oA = at(owned, a);
      const oB = at(owned, b);
      const freedBudget = state.bank + oA.sellingPrice + oB.sellingPrice;

      const candA = poolByPosition[oA.position].slice(0, doubleCandidatesPerPosition);
      const candB = poolByPosition[oB.position].slice(0, doubleCandidatesPerPosition);

      for (const cA of candA) {
        for (const cB of candB) {
          if (cA.element === cB.element) continue;
          if (evalBudget.remaining <= 0) break outer;
          evalBudget.remaining--;

          const cost = cA.now_cost + cB.now_cost;
          if (cost > freedBudget) continue;

          const teamDelta = new Map<number, number>();
          teamDelta.set(oA.team, (teamDelta.get(oA.team) ?? 0) - 1);
          teamDelta.set(oB.team, (teamDelta.get(oB.team) ?? 0) - 1);
          teamDelta.set(cA.team, (teamDelta.get(cA.team) ?? 0) + 1);
          teamDelta.set(cB.team, (teamDelta.get(cB.team) ?? 0) + 1);
          let teamOk = true;
          for (const [team, delta] of teamDelta) {
            if ((teamCounts.get(team) ?? 0) + delta > teamLimit) {
              teamOk = false;
              break;
            }
          }
          if (!teamOk) continue;

          // Rebuild only the affected position groups (1 group if oA/oB
          // share a position, otherwise 2).
          const changed = new Map<Position, number[]>();
          const groupFor = (pos: Position): number[] => {
            let g = changed.get(pos);
            if (!g) {
              g = [...baselineByPosition[pos]];
              changed.set(pos, g);
            }
            return g;
          };
          const removeOne = (pos: Position, score: number): void => {
            const g = groupFor(pos);
            const idx = g.indexOf(score);
            if (idx !== -1) g.splice(idx, 1);
          };
          removeOne(oA.position, oA.score);
          removeOne(oB.position, oB.score);
          groupFor(cA.position).push(cA.score);
          groupFor(cB.position).push(cB.score);
          for (const g of changed.values()) g.sort((x, y) => y - x);

          const newByPosition: Record<Position, readonly number[]> = { ...baselineByPosition };
          for (const [pos, g] of changed) newByPosition[pos] = g;
          const newTotal = baselineTotal - oA.score - oB.score + cA.score + cB.score;
          const gain = squadValue(newByPosition, newTotal, benchWeight) - baselineValue;

          const moves: TransferMove[] = [
            {
              element_in: cA.element,
              element_out: oA.element,
              purchase_price: cA.now_cost,
              selling_price: oA.sellingPrice,
            },
            {
              element_in: cB.element,
              element_out: oB.element,
              purchase_price: cB.now_cost,
              selling_price: oB.sellingPrice,
            },
          ];
          const resultingSquad = toResultingSquad(owned, new Set([oA.pickIndex, oB.pickIndex]), [
            cA,
            cB,
          ]);
          if (isLegalSquad(resultingSquad, elements, Number.POSITIVE_INFINITY).length > 0) continue;

          insertRanked(doubles, { moves, gain, resultingSquad }, (t) => t.gain, maxDouble);
        }
      }
    }
  }

  return [...singles, ...doubles].sort((x, y) => y.gain - x.gain);
}
