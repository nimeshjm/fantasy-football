/**
 * Tests for the gate audit trail (issue #12): `gate_verdict` (and its two
 * scores/override reason) was written as `undefined` on every `ai_calls`
 * row, because `gateAndReturnSquad`/`gateAndReturnLineup`/the transfer
 * gate in `decideTransfer` never called `LlmAuditSink.recordGate`, and
 * `makeAuditSink` never implemented it. Production had 9 rows and 0
 * non-null `gate_verdict`s -- the gate could fire with no record that it
 * had, or why.
 *
 * A test that only drives the deterministic-FALLBACK path proves nothing
 * here: the gate only runs after a schema-valid, rules-LEGAL LLM answer.
 * So every test below makes `StubProvider` return a legal answer and
 * exercises `decideSquad`/`decideLineup` directly (per the task brief),
 * with a `DeterministicBaseline` fake fully under the test's control --
 * scoring is keyed off which of two known-legal picks it was asked to
 * score, not off any real optimizer -- so the override/accept outcome is
 * deterministic and not a coincidence of the synthetic universe's numbers.
 */
import { describe, expect, it } from 'vitest';

import { Position, type Element, type Pick } from '../src/types';
import {
  decideLineup,
  decideSquad,
  type DeterministicBaseline,
  type LlmAuditSink,
  type NeuronBudget,
} from '../src/ai/decide';
import { StubProvider } from '../src/ai/provider';
import type { ShortlistEntry } from '../src/ai/prompts';
import { makeAuditSink } from '../src/workflows/decideCommit';
import type { AiCallGateUpdate, AiCallInput } from '../src/db';

// ---------------------------------------------------------------------------
// Shared synthetic universe helpers
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
    team: id, // every element on its own "club" -- club-limit-of-3 is never a factor here
    element_type: Position.MID,
    now_cost: 45,
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
    minutes: 900,
    removed: false,
    can_select: true,
    can_transact: true,
    ...overrides,
  };
}

const unusedBudget: NeuronBudget = { remaining: () => 1_000_000, record: () => {} };

/** A capturing `LlmAuditSink`: every `record`/`recordGate` call, in order. */
function makeCapturingAudit(): LlmAuditSink & {
  records: Parameters<LlmAuditSink['record']>[0][];
  gates: Parameters<NonNullable<LlmAuditSink['recordGate']>>[0][];
} {
  const records: Parameters<LlmAuditSink['record']>[0][] = [];
  const gates: Parameters<NonNullable<LlmAuditSink['recordGate']>>[0][] = [];
  return {
    records,
    gates,
    record: async (e) => {
      records.push(e);
    },
    recordGate: async (e) => {
      gates.push(e);
    },
  };
}

function idsKey(picks: Pick[]): string {
  return [...picks.map((p) => p.element)].sort((a, b) => a - b).join(',');
}

// ---------------------------------------------------------------------------
// Squad gate
// ---------------------------------------------------------------------------

/** Builds two disjoint, individually-legal 15-man squads (A and B) plus the
 * combined element pool/shortlist a `decideSquad` call needs. Squad A is
 * what the "LLM" answers with; squad B stands in for whatever the
 * `DeterministicBaseline` fake calls the optimum -- which of the two scores
 * higher is entirely up to the score function each test supplies. */
function buildLegalFifteen(): Element[] {
  const counts = { [Position.GK]: 2, [Position.DEF]: 5, [Position.MID]: 5, [Position.FWD]: 3 };
  const fifteen: Element[] = [];
  for (const pos of [Position.GK, Position.DEF, Position.MID, Position.FWD] as const) {
    for (let i = 0; i < counts[pos]; i++) {
      fifteen.push(makeElement({ element_type: pos, now_cost: 40 + i * 5 }));
    }
  }
  return fifteen;
}

function makeSquadPair(): {
  elements: Element[];
  shortlist: ShortlistEntry[];
  a: Pick[];
  b: Pick[];
} {
  const squadA = buildLegalFifteen();
  const squadB = buildLegalFifteen();
  const elements = [...squadA, ...squadB];
  const shortlist: ShortlistEntry[] = elements.map((element) => ({
    element,
    clubShortName: '?',
    xpts: 5,
  }));
  const toPicks = (subset: Element[]): Pick[] =>
    subset.map((e, i) => ({
      element: e.id,
      position: i + 1,
      is_captain: false,
      is_vice_captain: false,
    }));
  return { elements, shortlist, a: toPicks(squadA), b: toPicks(squadB) };
}

function squadBaselineScoring(a: Pick[], b: Pick[], scoreA: number, scoreB: number) {
  const keyA = idsKey(a);
  const keyB = idsKey(b);
  return (picks: Pick[]): number => {
    const key = idsKey(picks);
    if (key === keyA) return scoreA;
    if (key === keyB) return scoreB;
    throw new Error('scoreSquad called with unrecognised picks');
  };
}

describe('squad gate audit trail', () => {
  it('records an OVERRIDE verdict, both scores, and a non-empty override reason when the LLM squad is well below the optimum', async () => {
    const { elements, shortlist, a: llmSquad, b: optimalSquad } = makeSquadPair();
    const scoreSquad = squadBaselineScoring(llmSquad, optimalSquad, 50, 100);
    const baseline: DeterministicBaseline = {
      scoreSquad,
      scoreLineup: () => 0,
      optimalSquad: () => optimalSquad,
      optimalLineup: () => [],
      fallbackSquad: () => optimalSquad,
      fallbackLineup: () => [],
      fallbackTransfer: () => [],
    };
    const provider = new StubProvider({
      ok: true,
      text: JSON.stringify({ picks: llmSquad.map((p) => p.element), reason: 'llm pick' }),
    });
    const audit = makeCapturingAudit();

    const decision = await decideSquad({
      audit,
      shortlist,
      elements,
      provider,
      budget: unusedBudget,
      baseline,
    });

    // The decision itself ships the deterministic optimum...
    expect(decision.source).toBe('deterministic-gate');
    expect(decision.overrideReason).toBeTruthy();
    expect(idsKey(decision.picks!)).toBe(idsKey(optimalSquad));

    // ...and the override is now provable from the audit trail alone,
    // which is the entire point of this issue.
    expect(audit.gates).toHaveLength(1);
    const gate = audit.gates[0]!;
    expect(gate.decisionKind).toBe('squad');
    expect(gate.accept).toBe(false);
    expect(gate.source).toBe('deterministic-gate');
    expect(gate.overrideReason).toBeTruthy();
    expect(typeof gate.llmScore).toBe('number');
    expect(typeof gate.deterministicScore).toBe('number');
    expect(gate.llmScore).toBe(50);
    expect(gate.deterministicScore).toBe(100);
  });

  it('records an ACCEPT verdict with both scores when the LLM squad clears the margin (a gate that only logs overrides has the bug this fixes)', async () => {
    const { elements, shortlist, a: llmSquad, b: optimalSquad } = makeSquadPair();
    // 95 vs 100 is a 5% gap -- inside the default 10% squadMargin.
    const scoreSquad = squadBaselineScoring(llmSquad, optimalSquad, 95, 100);
    const baseline: DeterministicBaseline = {
      scoreSquad,
      scoreLineup: () => 0,
      optimalSquad: () => optimalSquad,
      optimalLineup: () => [],
      fallbackSquad: () => optimalSquad,
      fallbackLineup: () => [],
      fallbackTransfer: () => [],
    };
    const provider = new StubProvider({
      ok: true,
      text: JSON.stringify({ picks: llmSquad.map((p) => p.element), reason: 'llm pick' }),
    });
    const audit = makeCapturingAudit();

    const decision = await decideSquad({
      audit,
      shortlist,
      elements,
      provider,
      budget: unusedBudget,
      baseline,
    });

    expect(decision.source).toBe('llm');
    expect(decision.overrideReason).toBeUndefined();

    expect(audit.gates).toHaveLength(1);
    const gate = audit.gates[0]!;
    expect(gate.accept).toBe(true);
    expect(gate.source).toBe('llm');
    expect(gate.llmScore).toBe(95);
    expect(gate.deterministicScore).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Lineup gate
// ---------------------------------------------------------------------------

/** One owned 15 (2 GK/5 DEF/5 MID/3 FWD), split into a legal starting XI
 * (1 GK/4 DEF/4 MID/2 FWD, per `RULES.play`'s min/max) and bench. */
function makeOwnedFifteen(): {
  elements: Element[];
  owned: ShortlistEntry[];
  starters: Element[];
  bench: Element[];
} {
  const byPos = {
    [Position.GK]: [] as Element[],
    [Position.DEF]: [] as Element[],
    [Position.MID]: [] as Element[],
    [Position.FWD]: [] as Element[],
  };
  const counts = { [Position.GK]: 2, [Position.DEF]: 5, [Position.MID]: 5, [Position.FWD]: 3 };
  for (const pos of [Position.GK, Position.DEF, Position.MID, Position.FWD] as const) {
    for (let i = 0; i < counts[pos]; i++) {
      byPos[pos].push(makeElement({ element_type: pos }));
    }
  }
  const elements = [
    ...byPos[Position.GK],
    ...byPos[Position.DEF],
    ...byPos[Position.MID],
    ...byPos[Position.FWD],
  ];
  const starters = [
    ...byPos[Position.GK].slice(0, 1),
    ...byPos[Position.DEF].slice(0, 4),
    ...byPos[Position.MID].slice(0, 4),
    ...byPos[Position.FWD].slice(0, 2),
  ];
  const bench = [
    ...byPos[Position.GK].slice(1),
    ...byPos[Position.DEF].slice(4),
    ...byPos[Position.MID].slice(4),
    ...byPos[Position.FWD].slice(2),
  ];
  const owned: ShortlistEntry[] = elements.map((element) => ({
    element,
    clubShortName: '?',
    xpts: 5,
  }));
  return { elements, owned, starters, bench };
}

function lineupPayload(starters: Element[], bench: Element[], captain: Element, vice: Element) {
  return {
    starters: starters.map((e) => e.id),
    bench: bench.map((e) => e.id),
    captain: captain.id,
    vice_captain: vice.id,
    reason: 'llm lineup',
  };
}

describe('lineup gate audit trail', () => {
  it('records an OVERRIDE verdict, both scores, and a non-empty override reason when the LLM lineup is well below the optimum', async () => {
    const { elements, owned, starters, bench } = makeOwnedFifteen();
    const llmCaptain = starters[0]!;
    const llmVice = starters[1]!;
    const optimalCaptain = starters[2]!;

    const scoreLineup = (picks: Pick[]): number => {
      const captainId = picks.find((p) => p.is_captain)?.element;
      if (captainId === llmCaptain.id) return 50;
      if (captainId === optimalCaptain.id) return 100;
      throw new Error('scoreLineup called with an unrecognised captain');
    };
    // The gate never re-validates `optimalLineup()`'s shape, only scores it
    // -- so this only needs to carry the captain flag the fake keys off of.
    const optimalPicks: Pick[] = starters.map((e, i) => ({
      element: e.id,
      position: i + 1,
      is_captain: e.id === optimalCaptain.id,
      is_vice_captain: false,
    }));
    const baseline: DeterministicBaseline = {
      scoreSquad: () => 0,
      scoreLineup,
      optimalSquad: () => [],
      optimalLineup: () => optimalPicks,
      fallbackSquad: () => [],
      fallbackLineup: () => optimalPicks,
      fallbackTransfer: () => [],
    };
    const provider = new StubProvider({
      ok: true,
      text: JSON.stringify(lineupPayload(starters, bench, llmCaptain, llmVice)),
    });
    const audit = makeCapturingAudit();

    const decision = await decideLineup({
      audit,
      owned,
      elements,
      provider,
      budget: unusedBudget,
      baseline,
    });

    expect(decision.source).toBe('deterministic-gate');
    expect(decision.overrideReason).toBeTruthy();
    expect(decision.picks).toEqual(optimalPicks);

    expect(audit.gates).toHaveLength(1);
    const gate = audit.gates[0]!;
    expect(gate.decisionKind).toBe('lineup');
    expect(gate.accept).toBe(false);
    expect(gate.source).toBe('deterministic-gate');
    expect(gate.overrideReason).toBeTruthy();
    expect(gate.llmScore).toBe(50);
    expect(gate.deterministicScore).toBe(100);
  });

  it('records an ACCEPT verdict with both scores when the LLM lineup clears the absolute floor', async () => {
    const { elements, owned, starters, bench } = makeOwnedFifteen();
    const llmCaptain = starters[0]!;
    const llmVice = starters[1]!;
    const optimalCaptain = starters[2]!;

    // 96 vs 100 is a 4-point gap -- inside the default 8-point lineupAbsFloor.
    const scoreLineup = (picks: Pick[]): number => {
      const captainId = picks.find((p) => p.is_captain)?.element;
      if (captainId === llmCaptain.id) return 96;
      if (captainId === optimalCaptain.id) return 100;
      throw new Error('scoreLineup called with an unrecognised captain');
    };
    const optimalPicks: Pick[] = starters.map((e, i) => ({
      element: e.id,
      position: i + 1,
      is_captain: e.id === optimalCaptain.id,
      is_vice_captain: false,
    }));
    const baseline: DeterministicBaseline = {
      scoreSquad: () => 0,
      scoreLineup,
      optimalSquad: () => [],
      optimalLineup: () => optimalPicks,
      fallbackSquad: () => [],
      fallbackLineup: () => optimalPicks,
      fallbackTransfer: () => [],
    };
    const provider = new StubProvider({
      ok: true,
      text: JSON.stringify(lineupPayload(starters, bench, llmCaptain, llmVice)),
    });
    const audit = makeCapturingAudit();

    const decision = await decideLineup({
      audit,
      owned,
      elements,
      provider,
      budget: unusedBudget,
      baseline,
    });

    expect(decision.source).toBe('llm');
    expect(decision.overrideReason).toBeUndefined();

    expect(audit.gates).toHaveLength(1);
    const gate = audit.gates[0]!;
    expect(gate.accept).toBe(true);
    expect(gate.source).toBe('llm');
    expect(gate.llmScore).toBe(96);
    expect(gate.deterministicScore).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// makeAuditSink: row-id tracking and the standalone-row fallback
// ---------------------------------------------------------------------------

function makeFakeDb() {
  const inserted: AiCallInput[] = [];
  const updated: { id: number; gate: AiCallGateUpdate }[] = [];
  let nextId = 1;
  return {
    inserted,
    updated,
    logAiCall: async (input: AiCallInput): Promise<number> => {
      inserted.push(input);
      return nextId++;
    },
    updateAiCallGate: async (id: number, gate: AiCallGateUpdate): Promise<void> => {
      updated.push({ id, gate });
    },
  };
}

describe('squad gate, end to end through the real makeAuditSink (not a capturing fake)', () => {
  it('a suboptimal-but-legal LLM squad lands a gateVerdict of "override" with a reason and both scores on the actual ai_calls row', async () => {
    // Same fixture as the "squad gate audit trail" override test above, but
    // wired through `makeAuditSink` + a fake D1 port instead of a capturing
    // `LlmAuditSink` -- this is the piece that proves the two halves of the
    // fix (decide.ts calling `recordGate`, and `makeAuditSink` implementing
    // it) actually compose, not just that each works in isolation.
    const { elements, shortlist, a: llmSquad, b: optimalSquad } = makeSquadPair();
    const scoreSquad = squadBaselineScoring(llmSquad, optimalSquad, 50, 100);
    const baseline: DeterministicBaseline = {
      scoreSquad,
      scoreLineup: () => 0,
      optimalSquad: () => optimalSquad,
      optimalLineup: () => [],
      fallbackSquad: () => optimalSquad,
      fallbackLineup: () => [],
      fallbackTransfer: () => [],
    };
    const provider = new StubProvider({
      ok: true,
      text: JSON.stringify({ picks: llmSquad.map((p) => p.element), reason: 'llm pick' }),
    });
    const db = makeFakeDb();
    const sink = makeAuditSink({ ...db, modelName: 'test-model' });

    const decision = await decideSquad({
      audit: sink,
      shortlist,
      elements,
      provider,
      budget: unusedBudget,
      baseline,
    });

    expect(decision.source).toBe('deterministic-gate');
    // The call itself landed a row, and the gate stamped a verdict onto
    // THAT row rather than inserting a second one.
    expect(db.inserted).toHaveLength(1);
    expect(db.updated).toHaveLength(1);
    expect(db.updated[0]!.id).toBe(1);
    const { gate } = db.updated[0]!;
    expect(gate.gateVerdict).toBe('override');
    expect(gate.gateOverrideReason).toBeTruthy();
    expect(typeof gate.llmScore).toBe('number');
    expect(typeof gate.deterministicScore).toBe('number');
    expect(gate.llmScore).toBe(50);
    expect(gate.deterministicScore).toBe(100);
  });
});

describe('makeAuditSink (decideCommit.ts)', () => {
  it('stamps the gate verdict onto the row id returned by the most recent record() for that decisionKind', async () => {
    const db = makeFakeDb();
    const sink = makeAuditSink({ ...db, modelName: 'test-model' });

    await sink.record({
      decisionKind: 'squad',
      attempt: 0,
      outcome: 'ok',
      estNeuronsIn: 10,
      estNeuronsOut: 5,
      rawResponse: '{}',
    });
    expect(db.inserted).toHaveLength(1);

    await sink.recordGate!({
      decisionKind: 'squad',
      attempt: 0,
      accept: false,
      source: 'deterministic-gate',
      overrideReason: 'below margin',
      llmScore: 10,
      deterministicScore: 20,
    });

    expect(db.updated).toHaveLength(1);
    expect(db.updated[0]).toEqual({
      id: 1,
      gate: {
        gateVerdict: 'override',
        gateSource: 'deterministic-gate',
        gateOverrideReason: 'below margin',
        llmScore: 10,
        deterministicScore: 20,
      },
    });
    // No standalone fallback row was needed -- the normal path stamped the
    // existing row.
    expect(db.inserted).toHaveLength(1);
  });

  it('tracks row ids independently per decisionKind', async () => {
    const db = makeFakeDb();
    const sink = makeAuditSink({ ...db, modelName: 'test-model' });

    await sink.record({
      decisionKind: 'squad',
      attempt: 0,
      outcome: 'ok',
      estNeuronsIn: 1,
      estNeuronsOut: 1,
    });
    await sink.record({
      decisionKind: 'lineup',
      attempt: 0,
      outcome: 'ok',
      estNeuronsIn: 1,
      estNeuronsOut: 1,
    });

    await sink.recordGate!({
      decisionKind: 'squad',
      attempt: 0,
      accept: true,
      source: 'llm',
      llmScore: 1,
      deterministicScore: 1,
    });
    await sink.recordGate!({
      decisionKind: 'lineup',
      attempt: 0,
      accept: true,
      source: 'llm',
      llmScore: 2,
      deterministicScore: 2,
    });

    expect(db.updated).toEqual([
      {
        id: 1,
        gate: {
          gateVerdict: 'accept',
          gateSource: 'llm',
          gateOverrideReason: undefined,
          llmScore: 1,
          deterministicScore: 1,
        },
      },
      {
        id: 2,
        gate: {
          gateVerdict: 'accept',
          gateSource: 'llm',
          gateOverrideReason: undefined,
          llmScore: 2,
          deterministicScore: 2,
        },
      },
    ]);
  });

  it('falls back to inserting a standalone gate-only row when no id was remembered for that decisionKind', async () => {
    const db = makeFakeDb();
    const sink = makeAuditSink({ ...db, modelName: 'test-model' });

    // No record() call precedes this -- the invariant violation the
    // fallback exists to guard against.
    await sink.recordGate!({
      decisionKind: 'transfer',
      attempt: 0,
      accept: false,
      source: 'deterministic-gate',
      overrideReason: 'no matching candidate',
    });

    expect(db.updated).toEqual([]);
    expect(db.inserted).toHaveLength(1);
    const row = db.inserted[0]!;
    expect(row.gateVerdict).toBe('override');
    expect(row.gateSource).toBe('deterministic-gate');
    expect(row.gateOverrideReason).toBe('no matching candidate');
    expect(row.prompt).toMatch(/gate-only/i);
  });
});
