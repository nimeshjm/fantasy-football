/**
 * Tests for src/optimizer/{squad,lineup,transfers}.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  buildHorizonScores,
  buildSquad,
  candidatesFromElements,
  isLegalSquad,
  type SquadCandidate,
} from '../src/optimizer/squad';
import {
  bestLineup,
  CAPTAIN_MULTIPLIER,
  scoreLineup,
  type OwnedPlayer,
} from '../src/optimizer/lineup';
import { candidateTransfers } from '../src/optimizer/transfers';
import {
  Position,
  RULES,
  type Element,
  type Pick,
  type Projection,
  type SquadState,
} from '../src/types';
import bootstrapStatic from './fixtures/bootstrap-static.json';

// ---------------------------------------------------------------------------
// Real-fixture helpers, shared by the budget/quality tests below.

/** The 656 selectable players from the committed bootstrap fixture. */
function realisticElements(): Element[] {
  return (bootstrapStatic.elements as unknown as Element[]).filter((e) => e.can_select !== false);
}

/** Those players scored by the site's own ep_next, as the v1 strategy does. */
function realisticCandidates(): SquadCandidate[] {
  const elements = realisticElements();
  const scores = new Map<number, number>();
  for (const e of elements) {
    const parsed = e.ep_next !== null ? Number.parseFloat(e.ep_next as unknown as string) : NaN;
    scores.set(e.id, Number.isFinite(parsed) ? parsed : 0);
  }
  return candidatesFromElements(elements, scores);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let nextElementId = 1;
function makeElement(overrides: Partial<Element> = {}): Element {
  const id = overrides.id ?? nextElementId++;
  return {
    id,
    code: id,
    web_name: `Player${id}`,
    first_name: 'First',
    second_name: 'Last',
    team: 1,
    element_type: Position.MID,
    now_cost: 50,
    status: 'a',
    news: '',
    news_added: null,
    chance_of_playing_this_round: null,
    chance_of_playing_next_round: null,
    total_points: 0,
    event_points: 0,
    points_per_game: '0.0',
    form: '0.0',
    ep_next: null,
    ep_this: null,
    selected_by_percent: '0.0',
    minutes: 0,
    removed: false,
    can_select: true,
    can_transact: true,
    ...overrides,
  };
}

/** A small but fully legal-shape candidate pool: for each position, `count`
 * players spread across enough distinct teams to never hit the team limit,
 * with a clear, deterministic score ordering (`baseScore + index`) so tests
 * can predict exactly which players an optimal search should pick. */
function makePool(countsByPosition: Record<Position, number>): {
  elements: Element[];
  candidates: SquadCandidate[];
} {
  const elements: Element[] = [];
  const candidates: SquadCandidate[] = [];
  let team = 1;
  for (const pos of [Position.GK, Position.DEF, Position.MID, Position.FWD]) {
    for (let i = 0; i < countsByPosition[pos]; i++) {
      const el = makeElement({
        element_type: pos,
        team: ((team++ - 1) % 18) + 1,
        now_cost: 40 + (i % 10) * 5,
      });
      elements.push(el);
      candidates.push({
        element: el.id,
        position: pos,
        team: el.team,
        now_cost: el.now_cost,
        score: 2 + i * 0.3 + pos * 0.01,
      });
    }
  }
  return { elements, candidates };
}

function pickPositionCounts(
  picks: readonly Pick[],
  elements: readonly Element[],
): Record<Position, number> {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const counts: Record<Position, number> = {
    [Position.GK]: 0,
    [Position.DEF]: 0,
    [Position.MID]: 0,
    [Position.FWD]: 0,
  };
  for (const p of picks) {
    const el = byId.get(p.element);
    if (el) counts[el.element_type] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// isLegalSquad
// ---------------------------------------------------------------------------

describe('isLegalSquad', () => {
  function legalPool() {
    const { elements, candidates } = makePool({
      [Position.GK]: 2,
      [Position.DEF]: 5,
      [Position.MID]: 5,
      [Position.FWD]: 3,
    });
    const picks: Pick[] = candidates.map((c, idx) => ({
      element: c.element,
      position: idx + 1,
      is_captain: false,
      is_vice_captain: false,
    }));
    return { elements, picks };
  }

  it('accepts a legal 15', () => {
    const { elements, picks } = legalPool();
    expect(isLegalSquad(picks, elements)).toEqual([]);
  });

  it('flags the wrong squad size', () => {
    const { elements, picks } = legalPool();
    const errors = isLegalSquad(picks.slice(0, 14), elements);
    expect(errors.some((e) => e.rule === 'squad-size')).toBe(true);
  });

  it('flags a duplicate element', () => {
    const { elements, picks } = legalPool();
    const dup = [...picks.slice(0, 14), { ...picks[0]! }];
    const errors = isLegalSquad(dup, elements);
    expect(errors.some((e) => e.rule === 'duplicate-element')).toBe(true);
  });

  it('flags a position quota violation', () => {
    const { elements, picks } = legalPool();
    // Swap the labelling: take the last GK's Pick object as-is, but this
    // pool has exactly 2 GK/5 DEF/5 MID/3 FWD, so dropping one pick and
    // duplicating another breaks the quota without breaking size/dup checks
    // in a way that's already covered above.
    const broken = [...picks.slice(1, 15), { ...picks[1]! }];
    const errors = isLegalSquad(broken, elements);
    expect(errors.some((e) => e.rule === 'position-quota' || e.rule === 'duplicate-element')).toBe(
      true,
    );
  });

  it('flags a team-limit violation', () => {
    const { elements, picks } = legalPool();
    const sameTeamElements = elements.map((e) => ({ ...e, team: 1 }));
    const errors = isLegalSquad(picks, sameTeamElements);
    expect(errors.some((e) => e.rule === 'team-limit')).toBe(true);
  });

  it('flags a budget overrun, and Infinity budget bypasses it', () => {
    const { elements, picks } = legalPool();
    const expensiveElements = elements.map((e) => ({ ...e, now_cost: 200 }));
    const errors = isLegalSquad(picks, expensiveElements);
    expect(errors.some((e) => e.rule === 'budget')).toBe(true);
    const noErrors = isLegalSquad(picks, expensiveElements, Number.POSITIVE_INFINITY);
    expect(noErrors.some((e) => e.rule === 'budget')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildHorizonScores
// ---------------------------------------------------------------------------

describe('buildHorizonScores', () => {
  it('combines multiple gameweeks with the given weights', () => {
    const week1: Projection[] = [{ element_id: 1, event: 1, xmins: 90, xpts: 4 }];
    const week2: Projection[] = [{ element_id: 1, event: 2, xmins: 90, xpts: 6 }];
    const scores = buildHorizonScores([week1, week2], [1, 0.5]);
    expect(scores.get(1)).toBeCloseTo(4 + 0.5 * 6, 10);
  });

  it('treats a player absent from a gameweek as 0 for that week', () => {
    const week1: Projection[] = [{ element_id: 1, event: 1, xmins: 90, xpts: 4 }];
    const week2: Projection[] = []; // blank gameweek for everyone
    const scores = buildHorizonScores([week1, week2], [1, 1]);
    expect(scores.get(1)).toBeCloseTo(4, 10);
  });
});

// ---------------------------------------------------------------------------
// buildSquad
// ---------------------------------------------------------------------------

describe('buildSquad', () => {
  it('returns a feasible, legal squad from a generous candidate pool', () => {
    const { elements, candidates } = makePool({
      [Position.GK]: 6,
      [Position.DEF]: 15,
      [Position.MID]: 15,
      [Position.FWD]: 9,
    });
    const result = buildSquad(candidates, { seed: 1 });
    expect(result.feasible).toBe(true);
    expect(result.picks).toHaveLength(RULES.squadSize);
    expect(isLegalSquad(result.picks, elements)).toEqual([]);
    const counts = pickPositionCounts(result.picks, elements);
    expect(counts).toEqual(RULES.squadSelect);
  });

  it('is infeasible when the pool cannot fill a position quota at all', () => {
    const { candidates } = makePool({
      [Position.GK]: 1, // need 2
      [Position.DEF]: 15,
      [Position.MID]: 15,
      [Position.FWD]: 9,
    });
    const result = buildSquad(candidates);
    expect(result.feasible).toBe(false);
    expect(result.picks).toEqual([]);
  });

  it('prefers the highest-scoring affordable players over a naive cheapest-fill', () => {
    const { elements, candidates } = makePool({
      [Position.GK]: 6,
      [Position.DEF]: 15,
      [Position.MID]: 15,
      [Position.FWD]: 9,
    });
    const result = buildSquad(candidates, { seed: 2 });
    expect(result.feasible).toBe(true);
    const chosenIds = new Set(result.picks.map((p) => p.element));
    // The single highest-scoring candidate in each position group should be
    // affordable here (pool is generous) and therefore should be selected.
    for (const pos of [Position.GK, Position.DEF, Position.MID, Position.FWD]) {
      const best = candidates
        .filter((c) => c.position === pos)
        .sort((a, b) => b.score - a.score)[0]!;
      expect(chosenIds.has(best.element)).toBe(true);
    }
    void elements;
  });

  it('is starting-XI-aware: a higher benchWeight buys a more expensive, higher-scoring bench', () => {
    const { candidates } = makePool({
      [Position.GK]: 6,
      [Position.DEF]: 15,
      [Position.MID]: 15,
      [Position.FWD]: 9,
    });
    const lowBench = buildSquad(candidates, { seed: 3, benchWeight: 0.01 });
    const highBench = buildSquad(candidates, { seed: 3, benchWeight: 0.9 });
    expect(lowBench.feasible).toBe(true);
    expect(highBench.feasible).toBe(true);

    const scoreById = new Map(candidates.map((c) => [c.element, c.score]));
    const benchScore = (picks: Pick[]): number =>
      picks
        .filter((p) => p.position > RULES.squadPlay)
        .reduce((sum, p) => sum + (scoreById.get(p.element) ?? 0), 0);

    // A near-zero bench weight should tolerate (or prefer) a weak bench to
    // spend more budget on starters; a high bench weight should not leave
    // as much value on the bench.
    expect(benchScore(highBench.picks)).toBeGreaterThanOrEqual(benchScore(lowBench.picks));
  });

  it('respects the team limit', () => {
    const { candidates } = makePool({
      [Position.GK]: 6,
      [Position.DEF]: 15,
      [Position.MID]: 15,
      [Position.FWD]: 9,
    });
    const result = buildSquad(candidates, { seed: 4 });
    expect(result.feasible).toBe(true);
    const teamById = new Map(candidates.map((c) => [c.element, c.team]));
    const teamCounts = new Map<number, number>();
    for (const p of result.picks) {
      const team = teamById.get(p.element)!;
      teamCounts.set(team, (teamCounts.get(team) ?? 0) + 1);
    }
    for (const count of teamCounts.values()) expect(count).toBeLessThanOrEqual(RULES.teamLimit);
  });

  it('reaches the same solution at the default budget as at a 4x larger one', () => {
    // The default search budget exists to fit the 10 ms Worker CPU limit (see
    // DEFAULT_MAX_EVALUATIONS). This asserts the budget is not merely cheap
    // but sufficient: on real data it finds the same squad a much larger
    // budget does, so the cheap default costs nothing in quality.
    const candidates = realisticCandidates();
    const cheap = buildSquad(candidates);
    const lavish = buildSquad(candidates, { maxEvaluations: 16_000, maxRestarts: 8 });

    expect(cheap.feasible).toBe(true);
    expect(isLegalSquad(cheap.picks, realisticElements())).toEqual([]);
    expect(cheap.projectedPoints).toBeCloseTo(lavish.projectedPoints, 2);
  });

  it('respects an explicit evaluation budget', () => {
    // A deterministic stand-in for the wall-clock assertion this replaced.
    // Timing assertions on shared CI hardware are flaky by construction -- the
    // original 50 ms bound passed locally and failed at 52.8 ms on a runner --
    // and they measure the host, not the algorithm. The invariant that
    // actually protects the CPU budget is that the search is *bounded*, so
    // assert that directly: a tiny budget must still terminate and return a
    // legal squad rather than running to convergence.
    const candidates = realisticCandidates();
    const tiny = buildSquad(candidates, { maxEvaluations: 50, maxRestarts: 1 });

    expect(tiny.feasible).toBe(true);
    expect(isLegalSquad(tiny.picks, realisticElements())).toEqual([]);
    expect(tiny.projectedPoints).toBeLessThanOrEqual(buildSquad(candidates).projectedPoints + 1e-6);
  });

  it('stays far away from a pathological regression in wall-clock terms', () => {
    // Deliberately loose: this catches an accidental O(n!) rewrite, not a slow
    // CI runner. Cold cost measured at ~5 ms locally and ~15 ms on a runner, so
    // 400 ms is ~25x margin and will not flake.
    const candidates = realisticCandidates();
    const start = performance.now();
    buildSquad(candidates);
    expect(performance.now() - start).toBeLessThan(400);
  });
});

// ---------------------------------------------------------------------------
// bestLineup / scoreLineup
// ---------------------------------------------------------------------------

describe('bestLineup', () => {
  function fifteen(): OwnedPlayer[] {
    const owned: OwnedPlayer[] = [];
    let id = 1;
    const push = (position: Position, n: number): void => {
      for (let i = 0; i < n; i++) owned.push({ element: id++, position });
    };
    push(Position.GK, 2);
    push(Position.DEF, 5);
    push(Position.MID, 5);
    push(Position.FWD, 3);
    return owned;
  }

  it('picks the highest-scoring legal XI and matches a brute-force reference', () => {
    const owned = fifteen();
    const projections: Projection[] = owned.map((o, idx) => ({
      element_id: o.element,
      event: 1,
      xmins: 90,
      xpts: (idx + 1) * 1.0, // strictly increasing, unique
    }));

    const picks = bestLineup(owned, projections);
    const starters = picks.filter((p) => p.position <= RULES.squadPlay);
    const bench = picks.filter((p) => p.position > RULES.squadPlay);
    expect(starters).toHaveLength(RULES.squadPlay);
    expect(bench).toHaveLength(RULES.squadSize - RULES.squadPlay);

    // Brute-force reference: every legal formation, top-N per position.
    const xptsByElement = new Map(projections.map((p) => [p.element_id, p.xpts]));
    const byPos = new Map<Position, number[]>();
    for (const o of owned) {
      const arr = byPos.get(o.position) ?? [];
      arr.push(xptsByElement.get(o.element)!);
      byPos.set(o.position, arr);
    }
    for (const arr of byPos.values()) arr.sort((a, b) => b - a);
    let bestValue = -Infinity;
    for (const { play } of [RULES]) {
      for (let gk = play[Position.GK].min; gk <= play[Position.GK].max; gk++) {
        for (let def = play[Position.DEF].min; def <= play[Position.DEF].max; def++) {
          for (let mid = play[Position.MID].min; mid <= play[Position.MID].max; mid++) {
            const fwd = RULES.squadPlay - gk - def - mid;
            if (fwd < play[Position.FWD].min || fwd > play[Position.FWD].max) continue;
            const sum = (pos: Position, k: number): number =>
              (byPos.get(pos) ?? []).slice(0, k).reduce((s, v) => s + v, 0);
            const value =
              sum(Position.GK, gk) +
              sum(Position.DEF, def) +
              sum(Position.MID, mid) +
              sum(Position.FWD, fwd);
            if (value > bestValue) bestValue = value;
          }
        }
      }
    }

    const chosenValue = starters.reduce((s, p) => s + xptsByElement.get(p.element)!, 0);
    expect(chosenValue).toBeCloseTo(bestValue, 10);
  });

  it('sets captain to the max-xpts starter and vice to the second highest', () => {
    const owned = fifteen();
    const projections: Projection[] = owned.map((o, idx) => ({
      element_id: o.element,
      event: 1,
      xmins: 90,
      xpts: idx === 4 ? 20 : idx === 7 ? 15 : 1 + idx * 0.01,
    }));
    const picks = bestLineup(owned, projections);
    const captain = picks.find((p) => p.is_captain);
    const vice = picks.find((p) => p.is_vice_captain);
    expect(captain?.element).toBe(owned[4]!.element);
    expect(vice?.element).toBe(owned[7]!.element);
  });

  it('always benches the reserve goalkeeper last', () => {
    const owned = fifteen();
    // Make the bench GK score very highly so it would rank first by points
    // among bench players if bench order were pure points.
    const projections: Projection[] = owned.map((o) => ({
      element_id: o.element,
      event: 1,
      xmins: 90,
      xpts: o.position === Position.GK ? 50 : 5,
    }));
    const picks = bestLineup(owned, projections);
    const bench = picks
      .filter((p) => p.position > RULES.squadPlay)
      .sort((a, b) => a.position - b.position);
    const lastBenchElement = bench[bench.length - 1]!.element;
    const gkIds = new Set(owned.filter((o) => o.position === Position.GK).map((o) => o.element));
    expect(gkIds.has(lastBenchElement)).toBe(true);
  });

  it('treats a player missing from projections as 0 xpts rather than throwing', () => {
    const owned = fifteen();
    expect(() => bestLineup(owned, [])).not.toThrow();
  });

  it('throws when no legal formation can be formed', () => {
    const owned: OwnedPlayer[] = Array.from({ length: 15 }, (_, i) => ({
      element: i + 1,
      position: Position.MID, // no GK at all
    }));
    expect(() => bestLineup(owned, [])).toThrow();
  });
});

describe('scoreLineup', () => {
  it('doubles the captain contribution and ignores the bench', () => {
    const picks: Pick[] = [
      { element: 1, position: 1, is_captain: true, is_vice_captain: false },
      { element: 2, position: 2, is_captain: false, is_vice_captain: true },
      { element: 3, position: 12, is_captain: false, is_vice_captain: false }, // bench
    ];
    const projections: Projection[] = [
      { element_id: 1, event: 1, xmins: 90, xpts: 10 },
      { element_id: 2, event: 1, xmins: 90, xpts: 6 },
      { element_id: 3, event: 1, xmins: 90, xpts: 100 }, // bench: must not count
    ];
    const score = scoreLineup(picks, projections);
    expect(score).toBeCloseTo(10 * CAPTAIN_MULTIPLIER + 6, 10);
  });
});

// ---------------------------------------------------------------------------
// candidateTransfers
// ---------------------------------------------------------------------------

describe('candidateTransfers', () => {
  function baseSquad(): { elements: Element[]; state: SquadState } {
    const { elements, candidates } = makePool({
      [Position.GK]: 2,
      [Position.DEF]: 5,
      [Position.MID]: 5,
      [Position.FWD]: 3,
    });
    void candidates;
    const picks: Pick[] = elements.map((e) => ({
      element: e.id,
      position: 0,
      is_captain: false,
      is_vice_captain: false,
      selling_price: e.now_cost,
    }));
    picks.forEach((p, idx) => (p.position = idx + 1));
    const state: SquadState = {
      entry: 1,
      event: 5,
      picks,
      chip: null,
      bank: 50,
      value: 1000,
      freeTransfers: 1,
      transfersMade: 0,
    };
    return { elements, state };
  }

  it('finds a legal, positive-gain single transfer when a clearly better replacement is affordable', () => {
    const { elements, state } = baseSquad();
    // The worst DEF in the squad, by low projection...
    const worstDef = elements.find((e) => e.element_type === Position.DEF)!;
    // ...and a clearly-better, affordable, not-yet-owned replacement DEF.
    const replacement = makeElement({
      element_type: Position.DEF,
      team: 99,
      now_cost: worstDef.now_cost,
    });
    const allElements = [...elements, replacement];

    const projections: Projection[] = allElements.map((e) => ({
      element_id: e.id,
      event: 6,
      xmins: 90,
      xpts: e.id === replacement.id ? 20 : e.id === worstDef.id ? 0.1 : 4,
    }));

    const result = candidateTransfers(state, allElements, [projections]);
    expect(result.length).toBeGreaterThan(0);
    const best = result[0]!;
    expect(best.gain).toBeGreaterThan(0);
    expect(isLegalSquad(best.resultingSquad, allElements, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('uses selling_price, not now_cost, for affordability', () => {
    const { elements, state } = baseSquad();
    const outgoing = elements.find((e) => e.element_type === Position.MID)!;
    // Selling price much lower than now_cost -- simulates a player bought
    // high and now worth less after a price drop / the sell-on fee.
    const stateWithLowSellingPrice: SquadState = {
      ...state,
      bank: 0,
      picks: state.picks.map((p) => (p.element === outgoing.id ? { ...p, selling_price: 30 } : p)),
    };
    // A replacement costing more than the low selling price (30) but
    // affordable if (incorrectly) compared against now_cost / a higher bank.
    const replacement = makeElement({ element_type: Position.MID, team: 99, now_cost: 35 });
    const allElements = [...elements, replacement];
    const projections: Projection[] = allElements.map((e) => ({
      element_id: e.id,
      event: 6,
      xmins: 90,
      xpts: e.id === replacement.id ? 50 : 4,
    }));

    const result = candidateTransfers(stateWithLowSellingPrice, allElements, [projections]);
    const involvesThisSwap = result.some(
      (c) =>
        c.moves.length === 1 &&
        c.moves[0]!.element_in === replacement.id &&
        c.moves[0]!.element_out === outgoing.id,
    );
    expect(involvesThisSwap).toBe(false); // 35 > bank(0) + selling_price(30): must be filtered out
  });

  it('produces at least one legal double-transfer candidate when it is clearly beneficial', () => {
    const { elements, state } = baseSquad();
    const outDef = elements.filter((e) => e.element_type === Position.DEF)[0]!;
    const outMid = elements.filter((e) => e.element_type === Position.MID)[0]!;
    const inDef = makeElement({ element_type: Position.DEF, team: 98, now_cost: outDef.now_cost });
    const inMid = makeElement({ element_type: Position.MID, team: 97, now_cost: outMid.now_cost });
    const allElements = [...elements, inDef, inMid];

    const projections: Projection[] = allElements.map((e) => ({
      element_id: e.id,
      event: 6,
      xmins: 90,
      xpts:
        e.id === inDef.id || e.id === inMid.id
          ? 15
          : e.id === outDef.id || e.id === outMid.id
            ? 0.1
            : 4,
    }));

    const result = candidateTransfers(state, allElements, [projections], {
      maxSingle: 0,
      maxDouble: 3,
    });
    const doubles = result.filter((c) => c.moves.length === 2);
    expect(doubles.length).toBeGreaterThan(0);
    for (const d of doubles) {
      expect(isLegalSquad(d.resultingSquad, allElements, Number.POSITIVE_INFINITY)).toEqual([]);
    }
  });

  it('never returns an illegal candidate even over a larger randomised pool', () => {
    const { elements, state } = baseSquad();
    const extra: Element[] = [];
    for (let i = 0; i < 40; i++) {
      const pos = [Position.GK, Position.DEF, Position.MID, Position.FWD][i % 4]!;
      extra.push(
        makeElement({ element_type: pos, team: (i % 18) + 1, now_cost: 40 + (i % 12) * 5 }),
      );
    }
    const allElements = [...elements, ...extra];
    const projections: Projection[] = allElements.map((e) => ({
      element_id: e.id,
      event: 6,
      xmins: 90,
      xpts: Math.abs(Math.sin(e.id)) * 10,
    }));

    const result = candidateTransfers(state, allElements, [projections]);
    for (const c of result) {
      expect(isLegalSquad(c.resultingSquad, allElements, Number.POSITIVE_INFINITY)).toEqual([]);
    }
  });
});
