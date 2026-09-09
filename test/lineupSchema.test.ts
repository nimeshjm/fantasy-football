/**
 * Guarantees the restructured lineup answer (buildLineupSchema/
 * parseLineupResult, see the doc comments in src/ai/schemas.ts) is supposed
 * to buy: an out-of-XI captain/vice is not expressible, captain and vice
 * can't collide, a goalkeeper can't reach flex, every RULES.play minimum is
 * met by construction, and the derived bench is exactly the owned
 * complement of the XI.
 */
import { describe, expect, it } from 'vitest';

import { parseLineupResult, type LineupOwned } from '../src/ai/schemas';
import { validateLineup, type OwnedPlayer } from '../src/ai/validate';
import { Position, RULES, type Pick } from '../src/types';

// A 2/5/5/3 owned squad (matches RULES.squadSelect), distinct xpts per
// player so bench ordering is unambiguous.
const OWNED: LineupOwned[] = [
  { element: 1, position: Position.GK, xpts: 3.0 },
  { element: 2, position: Position.GK, xpts: 3.5 }, // reserve keeper
  { element: 11, position: Position.DEF, xpts: 4.1 },
  { element: 12, position: Position.DEF, xpts: 4.2 },
  { element: 13, position: Position.DEF, xpts: 4.3 },
  { element: 14, position: Position.DEF, xpts: 4.4 },
  { element: 15, position: Position.DEF, xpts: 4.5 },
  { element: 21, position: Position.MID, xpts: 5.1 },
  { element: 22, position: Position.MID, xpts: 5.2 },
  { element: 23, position: Position.MID, xpts: 5.3 },
  { element: 24, position: Position.MID, xpts: 5.4 },
  { element: 25, position: Position.MID, xpts: 5.5 },
  { element: 31, position: Position.FWD, xpts: 6.1 },
  { element: 32, position: Position.FWD, xpts: 6.2 },
  { element: 33, position: Position.FWD, xpts: 6.3 },
];
const OWNED_PLAYERS: OwnedPlayer[] = OWNED.map((o) => ({
  element: o.element,
  position: o.position,
}));

const idsAt = (position: Position): number[] =>
  OWNED.filter((o) => o.position === position).map((o) => o.element);

/** A schema-shaped answer using each position's `RULES.play` minimum, with
 * `flex` the given 4 ids (must be outfield, distinct from the rest). */
function answer(flex: number[], captain: number, vice: number) {
  const gk = idsAt(Position.GK);
  const def = idsAt(Position.DEF);
  const mid = idsAt(Position.MID);
  const fwd = idsAt(Position.FWD);
  return {
    gk: gk.slice(0, RULES.play[Position.GK].min),
    def: def.slice(0, RULES.play[Position.DEF].min),
    mid: mid.slice(0, RULES.play[Position.MID].min),
    fwd: fwd.slice(0, RULES.play[Position.FWD].min),
    flex,
    captain,
    vice_captain: vice,
    reason: 'ok',
  };
}

// Four legal flex choices, spread across the extra outfield pool left after
// each position's minimum is filled (DEF 14/15, MID 23/24/25, FWD 32/33),
// so DEF/MID/FWD each hit their RULES.play maximum in at least one case.
const SPREAD_FLEX_CHOICES: number[][] = [
  [14, 23, 24, 32], // DEF 4, MID 4, FWD 2 - middle of the road
  [14, 15, 23, 32], // DEF 5 (max), MID 3, FWD 2
  [23, 24, 25, 32], // DEF 3, MID 5 (max), FWD 2
  [14, 23, 32, 33], // DEF 4, MID 3, FWD 3 (max)
];

function picksFrom(parsed: {
  starters: number[];
  bench: number[];
  captain: number;
  vice_captain: number;
}): Pick[] {
  return [
    ...parsed.starters.map((element, i) => ({
      element,
      position: i + 1,
      is_captain: element === parsed.captain,
      is_vice_captain: element === parsed.vice_captain,
    })),
    ...parsed.bench.map((element, i) => ({
      element,
      position: RULES.squadPlay + 1 + i,
      is_captain: element === parsed.captain,
      is_vice_captain: element === parsed.vice_captain,
    })),
  ];
}

describe('captain/vice_captain indices', () => {
  it('rejects an index below 0 or at/above the XI size', () => {
    const tooLow = parseLineupResult(JSON.stringify(answer(SPREAD_FLEX_CHOICES[0]!, -1, 1)), OWNED);
    expect(tooLow.ok).toBe(false);

    const tooHigh = parseLineupResult(
      JSON.stringify(answer(SPREAD_FLEX_CHOICES[0]!, RULES.squadPlay, 1)),
      OWNED,
    );
    expect(tooHigh.ok).toBe(false);
  });

  it('every in-range index (0-10) resolves to a player who IS in starters', () => {
    for (let index = 0; index < RULES.squadPlay; index++) {
      const vice = (index + 1) % RULES.squadPlay;
      const result = parseLineupResult(
        JSON.stringify(answer(SPREAD_FLEX_CHOICES[0]!, index, vice)),
        OWNED,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.starters).toContain(result.value.captain);
      expect(result.value.starters).toContain(result.value.vice_captain);
    }
  });

  it('rejects captain === vice_captain', () => {
    const result = parseLineupResult(JSON.stringify(answer(SPREAD_FLEX_CHOICES[0]!, 0, 0)), OWNED);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('vice_captain');
  });
});

describe('flex is outfield-only', () => {
  it('rejects a goalkeeper id in flex - the only thing holding the XI to one GK', () => {
    // Swap the reserve keeper (id 2) into flex in place of a legal DEF id.
    const result = parseLineupResult(JSON.stringify(answer([2, 23, 24, 32], 0, 1)), OWNED);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('2');
    expect(result.error).toMatch(/goalkeeper/i);
  });
});

describe('RULES.play is never violated by a schema-shaped answer', () => {
  // Minima can't be under-filled: `answer()` slices exactly RULES.play[p].min
  // into each required, fixed-length array, so there is no way to construct
  // a schema-valid answer with fewer - this is a structural property of
  // buildLineupSchema, not something a spread of valid answers can probe.
  // What a spread of valid answers CAN probe is the maxima, since `flex`
  // lets different valid answers push a position anywhere up to its
  // maximum - the four choices below are picked to do exactly that for
  // DEF/MID/FWD in turn.
  it('a spread of valid answers, each pushing a different position to its maximum, reports no formation error', () => {
    for (const flex of SPREAD_FLEX_CHOICES) {
      const result = parseLineupResult(JSON.stringify(answer(flex, 0, 1)), OWNED);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');

      const errors = validateLineup(picksFrom(result.value), OWNED_PLAYERS);
      expect(errors.filter((e) => e.rule === 'formation')).toEqual([]);
    }
  });
});

describe('the derived bench', () => {
  it('is exactly the owned players the XI did not take, outfield by descending xpts, reserve GK last', () => {
    const result = parseLineupResult(JSON.stringify(answer(SPREAD_FLEX_CHOICES[0]!, 0, 1)), OWNED);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const starting = new Set(result.value.starters);
    const left = OWNED.filter((o) => !starting.has(o.element));
    expect(left).toHaveLength(RULES.squadSize - RULES.squadPlay);

    const expectedBench = [
      ...left
        .filter((o) => o.position !== Position.GK)
        .sort((a, b) => b.xpts - a.xpts)
        .map((o) => o.element),
      ...left.filter((o) => o.position === Position.GK).map((o) => o.element),
    ];
    expect(result.value.bench).toEqual(expectedBench);
    expect(new Set(result.value.bench)).toEqual(new Set(left.map((o) => o.element)));
  });
});
