/**
 * Exact lineup solve: pick the best legal starting XI out of 15 owned
 * players, order the bench, and set captain/vice.
 *
 * The formation space under `RULES.play` is tiny (a handful of
 * combinations of DEF/MID/FWD counts with GK fixed at 1), and within a
 * fixed formation the optimal choice per position is simply "the top-N
 * players by projected points" -- there is no interaction between
 * positions beyond the totals adding to 11, so enumerating every formation
 * and taking the best is an EXACT solve, not a heuristic, despite being
 * cheap enough to not need one.
 *
 * Pure function: no D1/fetch/env, arrays and records in, values out.
 */

import { Position, RULES, type Pick, type Projection } from '../types';

const POSITIONS = [Position.GK, Position.DEF, Position.MID, Position.FWD] as const;

/** Non-null indexed read -- see the identical helper in squad.ts for why
 * this is safe here: every call site indexes within a length it just
 * checked or built. */
function at<T>(arr: { readonly [i: number]: T }, i: number): T {
  return arr[i] as T;
}

/** Minimal shape this module needs for an owned player -- just enough to
 * group by position and look up a projection. Build this from your
 * `Pick[]` + `Element[]` (`{ element: pick.element, position:
 * element.element_type }`). */
export interface OwnedPlayer {
  element: number;
  position: Position;
}

/** The standard captain-points doubling. Not part of `RULES` because it is
 * baseline behaviour independent of any chip; a Triple Captain chip (3x)
 * is a workflow-layer concern applied on top of `scoreLineup`, not this
 * module's. */
export const CAPTAIN_MULTIPLIER = 2;

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

interface Scored {
  element: number;
  xpts: number;
}

/** Prefix sum of `sorted` (already descending by xpts): `prefix[k]` = sum
 * of the top `k` values, `prefix[0] = 0`. */
function prefixSums(sorted: readonly Scored[]): number[] {
  const prefix = [0];
  for (let i = 0; i < sorted.length; i++) prefix.push(at(prefix, i) + at(sorted, i).xpts);
  return prefix;
}

/**
 * Chooses the best legal XI from 15 owned players, orders the bench, and
 * sets captain (highest projected xPts among starters) / vice (second
 * highest). Players absent from `projections` default to 0 xpts rather
 * than throwing -- a gap in projection coverage shouldn't crash lineup
 * selection, it should just make that player an unappealing pick.
 *
 * `owned` is expected to contain exactly `RULES.squadSize` players with
 * position counts matching `RULES.squadSelect` (i.e. a legal squad -- see
 * `isLegalSquad` in squad.ts). If no legal formation can be formed at all
 * (e.g. missing a goalkeeper entirely), this throws rather than silently
 * returning a partial/illegal lineup.
 */
export function bestLineup(
  owned: readonly OwnedPlayer[],
  projections: readonly Projection[],
): Pick[] {
  const xptsByElement = new Map(projections.map((p) => [p.element_id, p.xpts]));

  const byPosition: Record<Position, Scored[]> = {
    [Position.GK]: [],
    [Position.DEF]: [],
    [Position.MID]: [],
    [Position.FWD]: [],
  };
  for (const p of owned) {
    byPosition[p.position].push({ element: p.element, xpts: xptsByElement.get(p.element) ?? 0 });
  }
  for (const pos of POSITIONS) byPosition[pos].sort((a, b) => b.xpts - a.xpts);

  const prefixByPosition: Record<Position, number[]> = {
    [Position.GK]: prefixSums(byPosition[Position.GK]),
    [Position.DEF]: prefixSums(byPosition[Position.DEF]),
    [Position.MID]: prefixSums(byPosition[Position.MID]),
    [Position.FWD]: prefixSums(byPosition[Position.FWD]),
  };

  let bestFormation: Formation | null = null;
  let bestValue = -Infinity;
  for (const f of FORMATIONS) {
    if (
      f.gk > byPosition[Position.GK].length ||
      f.def > byPosition[Position.DEF].length ||
      f.mid > byPosition[Position.MID].length ||
      f.fwd > byPosition[Position.FWD].length
    ) {
      continue; // not enough owned players at this position for this formation
    }
    const value =
      at(prefixByPosition[Position.GK], f.gk) +
      at(prefixByPosition[Position.DEF], f.def) +
      at(prefixByPosition[Position.MID], f.mid) +
      at(prefixByPosition[Position.FWD], f.fwd);
    if (value > bestValue) {
      bestValue = value;
      bestFormation = f;
    }
  }

  if (bestFormation === null) {
    throw new Error('bestLineup: no legal formation fits the given owned players');
  }

  const starters: Scored[] = [
    ...byPosition[Position.GK].slice(0, bestFormation.gk),
    ...byPosition[Position.DEF].slice(0, bestFormation.def),
    ...byPosition[Position.MID].slice(0, bestFormation.mid),
    ...byPosition[Position.FWD].slice(0, bestFormation.fwd),
  ];

  const benchGk = byPosition[Position.GK].slice(bestFormation.gk);
  const benchOutfield = [
    ...byPosition[Position.DEF].slice(bestFormation.def),
    ...byPosition[Position.MID].slice(bestFormation.mid),
    ...byPosition[Position.FWD].slice(bestFormation.fwd),
  ].sort((a, b) => b.xpts - a.xpts);

  // Captain/vice come from the starting XI only: captaining a benched
  // player forfeits the double unless an autosub happens to bring them on,
  // which this projection-time solve has no way to know about.
  let captainIdx = 0;
  let viceIdx = starters.length > 1 ? 1 : 0;
  for (let i = 1; i < starters.length; i++) {
    if (at(starters, i).xpts > at(starters, captainIdx).xpts) {
      viceIdx = captainIdx;
      captainIdx = i;
    } else if (i !== captainIdx && at(starters, i).xpts > at(starters, viceIdx).xpts) {
      viceIdx = i;
    }
  }

  const picks: Pick[] = starters.map((s, idx) => ({
    element: s.element,
    position: idx + 1,
    is_captain: idx === captainIdx,
    is_vice_captain: idx === viceIdx && idx !== captainIdx,
  }));

  // Bench order: outfield subs in priority order (highest projected points
  // first) at 12-14, reserve goalkeeper always last at 15 -- an autosub
  // only ever reaches for the bench keeper when the starting keeper doesn't
  // play at all, never ahead of an outfield sub.
  let benchPos = RULES.squadPlay + 1;
  for (const s of benchOutfield) {
    picks.push({
      element: s.element,
      position: benchPos++,
      is_captain: false,
      is_vice_captain: false,
    });
  }
  for (const s of benchGk) {
    picks.push({
      element: s.element,
      position: benchPos++,
      is_captain: false,
      is_vice_captain: false,
    });
  }

  return picks;
}

/**
 * Total expected points for a lineup: the sum of starters' (`position` 1-11)
 * projected xpts, with the captain's contribution doubled
 * (`CAPTAIN_MULTIPLIER`). Bench players (12-15) never contribute -- that's
 * the whole point of a bench.
 */
export function scoreLineup(picks: readonly Pick[], projections: readonly Projection[]): number {
  const xptsByElement = new Map(projections.map((p) => [p.element_id, p.xpts]));
  let total = 0;
  for (const p of picks) {
    if (p.position > RULES.squadPlay) continue;
    const xpts = xptsByElement.get(p.element) ?? 0;
    total += p.is_captain ? xpts * CAPTAIN_MULTIPLIER : xpts;
  }
  return total;
}
