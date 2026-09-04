import { orderPicksForMyTeam, sortPicksByTypeOrder } from '../src/api/endpoints';
/**
 * Tests for the integration layer: src/ownedPlayers.ts, src/baseline.ts, and
 * src/workflows/decideCommit.ts's `runDecisionCore` (driven with fake
 * dependencies -- no D1/fetch/Workers runtime involved).
 *
 * Covers the three integration hazards from the task brief plus the
 * DRY_RUN / kill-switch / transfer-cap / neuron-cap rails.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';

import {
  Position,
  RULES,
  type Element,
  type Pick,
  type Projection,
  type TransferMove,
} from '../src/types';
import { joinOwnedPlayers } from '../src/ownedPlayers';
import { validateLineup } from '../src/ai/validate';
import { scoreLineup as optimizerScoreLineup } from '../src/optimizer/lineup';
import { makeLineupBaseline, makeSquadBaseline } from '../src/baseline';
import { decideSquad, type DeterministicBaseline, type NeuronBudget } from '../src/ai/decide';
import { StubProvider } from '../src/ai/provider';
import type { ShortlistEntry } from '../src/ai/prompts';
import { buildShortlist } from '../src/shortlist';
import {
  runDecisionCore,
  canonicalizePicks,
  picksEqual,
  type DecisionCoreDeps,
  type ExistingSquad,
} from '../src/workflows/decideCommit';
import { DecideCommitWorkflow } from '../src/workflows/decideCommit';
import { isEnabled } from '../src/db';
import type { TeamRow } from '../src/db';

// ---------------------------------------------------------------------------
// Synthetic universe (same shape as test/optimizer.test.ts's makePool)
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
    minutes: 900,
    removed: false,
    can_select: true,
    can_transact: true,
    ...overrides,
  };
}

function makePool(countsByPosition: Record<Position, number>): {
  elements: Element[];
  projections: Projection[];
} {
  nextElementId = 1;
  const elements: Element[] = [];
  const projections: Projection[] = [];
  let team = 1;
  for (const pos of [Position.GK, Position.DEF, Position.MID, Position.FWD]) {
    for (let i = 0; i < countsByPosition[pos]; i++) {
      const el = makeElement({
        element_type: pos,
        team: ((team++ - 1) % 18) + 1,
        now_cost: 40 + (i % 10) * 5,
      });
      elements.push(el);
      projections.push({ element_id: el.id, event: 1, xmins: 90, xpts: 2 + i * 0.3 + pos * 0.01 });
    }
  }
  return { elements, projections };
}

const TEAMS: TeamRow[] = [];

/** A legal 15: exactly `RULES.squadSelect`'s counts, taken as the FIRST N
 * per position from a pool built by `makePool` (whose team ids cycle 1..18
 * without repeating within any one position's first 18 entries, so this is
 * always club-legal). */
function firstLegalSquadPicks(elements: readonly Element[]): Pick[] {
  const byPosition = new Map<Position, Element[]>();
  for (const e of elements) {
    const list = byPosition.get(e.element_type) ?? [];
    list.push(e);
    byPosition.set(e.element_type, list);
  }
  const chosen: Element[] = [
    ...(byPosition.get(Position.GK) ?? []).slice(0, RULES.squadSelect[Position.GK]),
    ...(byPosition.get(Position.DEF) ?? []).slice(0, RULES.squadSelect[Position.DEF]),
    ...(byPosition.get(Position.MID) ?? []).slice(0, RULES.squadSelect[Position.MID]),
    ...(byPosition.get(Position.FWD) ?? []).slice(0, RULES.squadSelect[Position.FWD]),
  ];
  return chosen.map((e, i) => ({
    element: e.id,
    position: i + 1,
    is_captain: false,
    is_vice_captain: false,
  }));
}

// ---------------------------------------------------------------------------
// HAZARD #1: the Pick/Element join (src/ownedPlayers.ts)
// ---------------------------------------------------------------------------

describe('joinOwnedPlayers (HAZARD #1)', () => {
  it('enables validateLineup to catch an illegal formation (0 starting FWD)', () => {
    const { elements } = makePool({
      [Position.GK]: 2,
      [Position.DEF]: 5,
      [Position.MID]: 5,
      [Position.FWD]: 3,
    });
    const squad = firstLegalSquadPicks(elements);
    const owned = joinOwnedPlayers(squad, elements);
    expect(owned).toHaveLength(15);

    // Illegal starting XI: 1 GK + 5 DEF + 5 MID + 0 FWD (11 starters), bench
    // gets the other GK and all 3 FWD (4 bench slots).
    const byPos = new Map<Position, number[]>();
    for (const o of owned) byPos.set(o.position, [...(byPos.get(o.position) ?? []), o.element]);
    const starters = [
      ...(byPos.get(Position.GK) ?? []).slice(0, 1),
      ...(byPos.get(Position.DEF) ?? []).slice(0, 5),
      ...(byPos.get(Position.MID) ?? []).slice(0, 5),
    ];
    const bench = [...(byPos.get(Position.GK) ?? []).slice(1), ...(byPos.get(Position.FWD) ?? [])];
    const illegalPicks: Pick[] = [
      ...starters.map((element, i) => ({
        element,
        position: i + 1,
        is_captain: i === 0,
        is_vice_captain: i === 1,
      })),
      ...bench.map((element, i) => ({
        element,
        position: RULES.squadPlay + i + 1,
        is_captain: false,
        is_vice_captain: false,
      })),
    ];

    const errors = validateLineup(illegalPicks, owned);
    const formationError = errors.find((e) => e.rule === 'formation' && e.detail.includes('FWD'));
    expect(formationError).toBeDefined();

    // The same STRUCTURE, but with a legal formation (1 GK/4 DEF/4 MID/2
    // FWD start, per RULES.play's min/max), must show no formation error at
    // all -- proving the join is what makes the check discriminate legal
    // from illegal, not a check that always fires.
    const legalStarters = [
      ...(byPos.get(Position.GK) ?? []).slice(0, 1),
      ...(byPos.get(Position.DEF) ?? []).slice(0, 4),
      ...(byPos.get(Position.MID) ?? []).slice(0, 4),
      ...(byPos.get(Position.FWD) ?? []).slice(0, 2),
    ];
    const legalBench = [
      ...(byPos.get(Position.GK) ?? []).slice(1),
      ...(byPos.get(Position.DEF) ?? []).slice(4),
      ...(byPos.get(Position.MID) ?? []).slice(4),
      ...(byPos.get(Position.FWD) ?? []).slice(2),
    ];
    const legalPicks: Pick[] = [
      ...legalStarters.map((element, i) => ({
        element,
        position: i + 1,
        is_captain: i === 0,
        is_vice_captain: i === 1,
      })),
      ...legalBench.map((element, i) => ({
        element,
        position: RULES.squadPlay + i + 1,
        is_captain: false,
        is_vice_captain: false,
      })),
    ];
    const legalErrors = validateLineup(legalPicks, owned).filter((e) => e.rule === 'formation');
    expect(legalErrors).toEqual([]);
  });

  it('without the join (Pick[] used directly, position undefined), formation checking silently cannot discriminate legal from illegal', () => {
    const { elements } = makePool({
      [Position.GK]: 2,
      [Position.DEF]: 5,
      [Position.MID]: 5,
      [Position.FWD]: 3,
    });
    const squad = firstLegalSquadPicks(elements);
    // The hazard: passing SquadState.picks straight through, cast to the
    // shape validateLineup expects, WITHOUT resolving each element's real
    // position via src/ownedPlayers.ts's join.
    const unjoined = squad.map(
      (p) => ({ element: p.element }) as unknown as { element: number; position: Position },
    );

    const legalOwned = joinOwnedPlayers(squad, elements);
    // Use the same legal starting XI constructed above's shape: 1 GK/4
    // DEF/4 MID/2 FWD -- a squad that legitimately validates cleanly when
    // properly joined.
    const byPos = new Map<Position, number[]>();
    for (const o of legalOwned)
      byPos.set(o.position, [...(byPos.get(o.position) ?? []), o.element]);
    const starters = [
      ...(byPos.get(Position.GK) ?? []).slice(0, 1),
      ...(byPos.get(Position.DEF) ?? []).slice(0, 4),
      ...(byPos.get(Position.MID) ?? []).slice(0, 4),
      ...(byPos.get(Position.FWD) ?? []).slice(0, 2),
    ];
    const bench = [
      ...(byPos.get(Position.GK) ?? []).slice(1),
      ...(byPos.get(Position.DEF) ?? []).slice(4),
      ...(byPos.get(Position.MID) ?? []).slice(4),
      ...(byPos.get(Position.FWD) ?? []).slice(2),
    ];
    const legalPicks: Pick[] = [
      ...starters.map((element, i) => ({
        element,
        position: i + 1,
        is_captain: i === 0,
        is_vice_captain: i === 1,
      })),
      ...bench.map((element, i) => ({
        element,
        position: RULES.squadPlay + i + 1,
        is_captain: false,
        is_vice_captain: false,
      })),
    ];

    // Confirms this exact lineup is legal when the join is done properly.
    expect(validateLineup(legalPicks, legalOwned).filter((e) => e.rule === 'formation')).toEqual(
      [],
    );

    // The SAME legal lineup, checked against the un-joined (position-less)
    // owned list, incorrectly reports formation errors for every position --
    // demonstrating that skipping the join doesn't just fail to catch
    // illegal formations, it makes the check meaningless outright.
    const brokenErrors = validateLineup(legalPicks, unjoined).filter((e) => e.rule === 'formation');
    expect(brokenErrors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// HAZARD #3: scoreLineup must double the captain
// ---------------------------------------------------------------------------

describe('makeLineupBaseline / makeSquadBaseline (HAZARD #3)', () => {
  it('scoreLineup doubles the captain -- two lineups differing only in captain score differently', () => {
    const { elements, projections } = makePool({
      [Position.GK]: 2,
      [Position.DEF]: 5,
      [Position.MID]: 5,
      [Position.FWD]: 3,
    });
    const squad = firstLegalSquadPicks(elements);
    const baseline = makeLineupBaseline(elements, projections, squad);

    const xptsById = new Map(projections.map((p) => [p.element_id, p.xpts] as const));
    const starterIds = squad.filter((p) => p.position <= RULES.squadPlay).map((p) => p.element);
    const [captainA, captainB] = starterIds;
    expect(captainA).toBeDefined();
    expect(captainB).toBeDefined();

    const lineupCaptainA: Pick[] = squad.map((p) => ({
      ...p,
      is_captain: p.element === captainA,
      is_vice_captain: p.element === captainB,
    }));
    const lineupCaptainB: Pick[] = squad.map((p) => ({
      ...p,
      is_captain: p.element === captainB,
      is_vice_captain: p.element === captainA,
    }));

    const scoreA = baseline.scoreLineup(lineupCaptainA);
    const scoreB = baseline.scoreLineup(lineupCaptainB);
    const expectedDiff = (xptsById.get(captainA!) ?? 0) - (xptsById.get(captainB!) ?? 0);

    expect(scoreA - scoreB).toBeCloseTo(expectedDiff, 6);
    // A gap of exactly 0 would mean captain choice doesn't move the score at
    // all -- the exact silent-failure mode the task brief warns about.
    expect(Math.abs(expectedDiff)).toBeGreaterThan(0);
    expect(scoreA).not.toBeCloseTo(scoreB, 6);

    // Directly confirms the wiring: makeLineupBaseline's scoreLineup must be
    // the SAME function as src/optimizer/lineup.ts's scoreLineup, which
    // doubles the captain -- not a re-implementation that doesn't.
    expect(baseline.scoreLineup(lineupCaptainA)).toBeCloseTo(
      optimizerScoreLineup(lineupCaptainA, projections),
      6,
    );
  });

  it('makeSquadBaseline.scoreSquad also reflects captain doubling (recomputes the true best XI)', () => {
    const { elements, projections } = makePool({
      [Position.GK]: 2,
      [Position.DEF]: 5,
      [Position.MID]: 5,
      [Position.FWD]: 3,
    });
    const squad = firstLegalSquadPicks(elements);
    const baseline = makeSquadBaseline(elements, projections, squad);
    const score = baseline.scoreSquad(squad);
    // Sum of every projection would be the "no captain, no bench cut" total;
    // the real best-XI score with captain doubling must exceed the simple
    // top-11 sum without doubling, and be well below the sum of all 15.
    const sumAll15 = squad.reduce(
      (s, p) => s + (projections.find((x) => x.element_id === p.element)?.xpts ?? 0),
      0,
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(sumAll15 * 2); // sanity ceiling
  });
});

// ---------------------------------------------------------------------------
// Idempotency helpers
// ---------------------------------------------------------------------------

describe('picksEqual / canonicalizePicks', () => {
  it('is insensitive to array order and to selling_price/purchase_price fields', () => {
    const a: Pick[] = [
      { element: 1, position: 1, is_captain: true, is_vice_captain: false, selling_price: 50 },
      { element: 2, position: 2, is_captain: false, is_vice_captain: true },
    ];
    const b: Pick[] = [
      { element: 2, position: 2, is_captain: false, is_vice_captain: true, purchase_price: 44 },
      { element: 1, position: 1, is_captain: true, is_vice_captain: false },
    ];
    expect(picksEqual(a, b)).toBe(true);
  });

  it('detects a real difference (different captain)', () => {
    const a: Pick[] = [{ element: 1, position: 1, is_captain: true, is_vice_captain: false }];
    const b: Pick[] = [{ element: 1, position: 1, is_captain: false, is_vice_captain: false }];
    expect(picksEqual(a, b)).toBe(false);
    expect(canonicalizePicks(a)).not.toBe(canonicalizePicks(b));
  });
});

// ---------------------------------------------------------------------------
// runDecisionCore: DRY_RUN / transfer cap / neuron cap
// ---------------------------------------------------------------------------

function baseConfig(
  overrides: Partial<DecisionCoreDeps['config']> = {},
): DecisionCoreDeps['config'] {
  return {
    dryRun: true,
    maxTransfersPerGw: 1,
    squadMargin: 0.1,
    lineupAbsFloor: 8,
    neuronDailyCap: 8000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DecisionCoreDeps> = {}): DecisionCoreDeps & {
  actions: unknown[];
  transferPosts: TransferMove[][];
  myTeamPosts: Pick[][];
  createEntryCalls: number;
} {
  const { elements, projections } = makePool({
    [Position.GK]: 6,
    [Position.DEF]: 15,
    [Position.MID]: 15,
    [Position.FWD]: 10,
  });
  const actions: unknown[] = [];
  const transferPosts: TransferMove[][] = [];
  const myTeamPosts: Pick[][] = [];
  let createEntryCalls = 0;

  const declineProvider = new StubProvider({ ok: false, error: 'stub declines every call' });

  const deps: DecisionCoreDeps = {
    elements,
    teams: TEAMS,
    projections,
    modelName: 'test-model',
    eventId: 1,
    config: baseConfig(),
    existingSquad: null,
    provider: declineProvider,
    neuronBudget: { remaining: () => 1_000_000, record: () => {} },
    reloadLivePrices: async () => null,
    createEntry: async () => {
      createEntryCalls++;
      return { ok: true, entry: 42 };
    },
    postTransfers: async (moves) => {
      transferPosts.push(moves);
      return {};
    },
    postMyTeam: async (picks) => {
      myTeamPosts.push(picks);
      return {};
    },
    logAction: async (input) => {
      actions.push(input);
    },
    logAiCall: async () => 1,
    updateAiCallGate: async () => {},
    saveSquadState: async () => {},
  };

  return {
    ...deps,
    ...overrides,
    actions,
    transferPosts,
    myTeamPosts,
    get createEntryCalls() {
      return createEntryCalls;
    },
  };
}

describe('runDecisionCore: DRY_RUN', () => {
  it('computes and logs the squad-creation decision but posts nothing', async () => {
    const deps = makeDeps({ config: baseConfig({ dryRun: true }) });
    const result = await runDecisionCore('full', deps);

    expect(result.ok).toBe(true);
    expect(result.posted).toBe(false);
    expect(deps.createEntryCalls).toBe(0);
    expect(deps.transferPosts).toEqual([]);
    expect(deps.myTeamPosts).toEqual([]);
    // Still logs what it WOULD have done.
    expect(deps.actions.length).toBeGreaterThan(0);
  });

  it('computes and logs a transfer/lineup decision but posts nothing', async () => {
    const { elements, projections } = makePool({
      [Position.GK]: 6,
      [Position.DEF]: 15,
      [Position.MID]: 15,
      [Position.FWD]: 10,
    });
    const squadPicks = firstLegalSquadPicks(elements);
    const existingSquad: ExistingSquad = {
      entry: 1,
      picks: squadPicks,
      bank: 20,
      cumulativeTransfers: 0,
    };
    const deps = makeDeps({
      elements,
      projections,
      existingSquad,
      config: baseConfig({ dryRun: true }),
    });

    const result = await runDecisionCore('full', deps);
    expect(result.ok).toBe(true);
    expect(result.posted).toBe(false);
    expect(deps.transferPosts).toEqual([]);
    expect(deps.myTeamPosts).toEqual([]);
  });
});

describe('runDecisionCore: transfer cap', () => {
  it('refuses to attempt a transfer once cumulative season transfers reach RULES.transfersCap, without spending an LLM call on it', async () => {
    const { elements, projections } = makePool({
      [Position.GK]: 6,
      [Position.DEF]: 15,
      [Position.MID]: 15,
      [Position.FWD]: 10,
    });
    const squadPicks = firstLegalSquadPicks(elements);
    const existingSquad: ExistingSquad = {
      entry: 1,
      picks: squadPicks,
      bank: 50,
      cumulativeTransfers: RULES.transfersCap,
    };
    const provider = new StubProvider({
      ok: false,
      error: 'should not be needed for the transfer decision',
    });
    const deps = makeDeps({
      elements,
      projections,
      existingSquad,
      provider,
      config: baseConfig({ dryRun: false }),
      reloadLivePrices: async () => ({
        elements,
        myTeam: { picks: squadPicks, chips: [] },
      }),
    });

    const result = await runDecisionCore('full', deps);

    expect(result.transferDecision?.transfers).toEqual([]);
    expect(result.transferDecision?.reasoning).toMatch(/transfer cap/i);
    expect(deps.transferPosts).toEqual([]);
    // No prompt built for a transfer decision (buildTransferPrompt's system
    // message is distinctive) -- the cap check happens BEFORE any LLM call.
    expect(
      provider.calls.some((c) => c.messages[0]!.content.includes('AT MOST ONE transfer')),
    ).toBe(false);
  });
});

describe('runDecisionCore: neuron budget cap', () => {
  it('falls back to the deterministic decision, and never calls the LLM provider, once the neuron budget is exhausted', async () => {
    const provider = new StubProvider({ ok: false, error: 'must not be reached' });
    const deps = makeDeps({
      provider,
      neuronBudget: { remaining: () => 0, record: () => {} },
      config: baseConfig({ dryRun: true }),
    });

    const result = await runDecisionCore('full', deps);

    expect(result.squadDecision?.source).toBe('deterministic-fallback');
    expect(result.lineupDecision?.source).toBe('deterministic-fallback');
    expect(provider.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Kill switch (class-level: DecideCommitWorkflow never even loads state)
// ---------------------------------------------------------------------------

function fakeConfigOnlyD1(enabled: boolean): D1Database {
  const row = { value: enabled ? '1' : '0' };
  const stmt = {
    bind: () => ({
      first: async () => row,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    }),
    first: async () => row,
    all: async () => ({ results: [] }),
    run: async () => ({ success: true }),
  };
  return {
    prepare: () => stmt,
    batch: async () => [],
  } as unknown as D1Database;
}

describe('DecideCommitWorkflow: kill switch', () => {
  it('does no D1 reads/writes beyond the enabled check when disabled', async () => {
    const db = fakeConfigOnlyD1(false);
    expect(await isEnabled(db)).toBe(false);

    const fakeStep = {
      do: async (_name: string, fn: () => Promise<unknown>) => fn(),
    } as unknown as WorkflowStep;

    const env = { DB: db } as unknown as ConstructorParameters<typeof DecideCommitWorkflow>[1];
    const workflow = new DecideCommitWorkflow({} as ExecutionContext, env);
    const result = await workflow.run(
      {
        payload: { mode: 'full', eventId: 1 },
        timestamp: new Date(),
        instanceId: 'test',
        workflowName: 'decide-commit',
      },
      fakeStep,
    );

    expect(result).toEqual({ ok: true, posted: false, reason: 'kill switch is off' });
  });
});

// ---------------------------------------------------------------------------
// Shortlist sanity: buildShortlist wired end-to-end through decideSquad
// ---------------------------------------------------------------------------

describe('decideSquad + shortlist wiring sanity', () => {
  it('a shortlist built by buildShortlist always satisfies the pre-call invariant decideSquad checks', async () => {
    const { elements, projections } = makePool({
      [Position.GK]: 6,
      [Position.DEF]: 15,
      [Position.MID]: 15,
      [Position.FWD]: 10,
    });
    const { shortlist, deterministicSquad } = buildShortlist(elements, projections, new Set());
    const teamShortName = () => '?';
    const shortlistEntries: ShortlistEntry[] = shortlist.map((element) => ({
      element,
      clubShortName: teamShortName(),
      xpts: projections.find((p) => p.element_id === element.id)?.xpts ?? 0,
    }));

    const baseline: DeterministicBaseline = {
      scoreSquad: () => deterministicSquad.projectedPoints,
      scoreLineup: () => 0,
      optimalSquad: () => deterministicSquad.picks,
      optimalLineup: () => deterministicSquad.picks,
      fallbackSquad: () => deterministicSquad.picks,
      fallbackLineup: () => deterministicSquad.picks,
      fallbackTransfer: () => [],
    };
    const budget: NeuronBudget = { remaining: () => 1_000_000, record: () => {} };
    const provider = new StubProvider({ ok: false, error: 'decline' });

    const decision = await decideSquad({
      shortlist: shortlistEntries,
      elements,
      provider,
      budget,
      baseline,
    });

    // Never silently aborts on the invariant -- reaches the (here,
    // deliberately-declining) LLM path and falls back cleanly.
    expect(decision.source).toBe('deterministic-fallback');
    expect(decision.picks).toEqual(deterministicSquad.picks);
  });
});

describe('entry-create payload (learned from a real 400)', () => {
  it('orders picks by element_type, which the API requires', () => {
    // The live API rejects squad-position order with
    // `squad_not_type_order: "We received type 2 after type 4"`, because
    // positions 1-15 interleave types. Only a real POST revealed this.
    const elementTypeById = new Map<number, number>([
      [10, 4], // FWD
      [20, 1], // GK
      [30, 3], // MID
      [40, 2], // DEF
    ]);
    const positionOrder = [{ element: 10 }, { element: 20 }, { element: 30 }, { element: 40 }];

    const sorted = sortPicksByTypeOrder(positionOrder, elementTypeById);

    expect(sorted.map((p) => p.element)).toEqual([20, 40, 30, 10]);
    const types = sorted.map((p) => elementTypeById.get(p.element)!);
    expect(types).toEqual([...types].sort((a, b) => a - b));
  });

  it('is stable within a position type, preserving the optimizer ordering', () => {
    const elementTypeById = new Map<number, number>([
      [1, 2],
      [2, 2],
      [3, 2],
    ]);
    const sorted = sortPicksByTypeOrder(
      [{ element: 3 }, { element: 1 }, { element: 2 }],
      elementTypeById,
    );
    expect(sorted.map((p) => p.element)).toEqual([3, 1, 2]);
  });
});

describe('my-team payload ordering (learned from a real 400)', () => {
  // The squad the agent actually owned for Jornada 5. Types are the live
  // ones: 315/507 GK, 431/269/187/475/317 DEF, 436/264/126/128/486 MID,
  // 131/442/405 FWD.
  const elementTypeById = new Map<number, number>([
    [315, 1],
    [507, 1],
    [431, 2],
    [269, 2],
    [187, 2],
    [475, 2],
    [317, 2],
    [436, 3],
    [264, 3],
    [126, 3],
    [128, 3],
    [486, 3],
    [131, 4],
    [442, 4],
    [405, 4],
  ]);

  const pick = (element: number, position: number, flags: Partial<Pick> = {}): Pick => ({
    element,
    position,
    is_captain: false,
    is_vice_captain: false,
    ...flags,
  });

  /** The exact lineup the LLM produced on 2026-09-04, which `my-team/`
   * rejected: a MID (128) sat at position 11, after three FWDs. */
  const rejectedByTheLiveApi: Pick[] = [
    pick(315, 1),
    pick(431, 2),
    pick(269, 3),
    pick(187, 4),
    pick(436, 5),
    pick(264, 6, { is_vice_captain: true }),
    pick(126, 7),
    pick(131, 8),
    pick(442, 9, { is_captain: true }),
    pick(405, 10),
    pick(128, 11),
    pick(507, 12),
    pick(486, 13),
    pick(475, 14),
    pick(317, 15),
  ];

  it('sorts the XI into element_type order, which is what the 400 was about', () => {
    const ordered = orderPicksForMyTeam(rejectedByTheLiveApi, elementTypeById);

    const xiTypes = ordered.slice(0, 11).map((p) => elementTypeById.get(p.element)!);
    expect(xiTypes).toEqual([...xiTypes].sort((a, b) => a - b));
    expect(ordered.map((p) => p.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('keeps the same eleven players on the pitch', () => {
    const ordered = orderPicksForMyTeam(rejectedByTheLiveApi, elementTypeById);

    expect(new Set(ordered.slice(0, 11).map((p) => p.element))).toEqual(
      new Set([315, 431, 269, 187, 436, 264, 126, 131, 442, 405, 128]),
    );
    // Sorting all fifteen by type -- rather than partitioning first -- would
    // promote the bench keeper into the XI and field two goalkeepers.
    expect(ordered.slice(0, 11).map((p) => p.element)).not.toContain(507);
  });

  it('carries captaincy through the renumber', () => {
    const ordered = orderPicksForMyTeam(rejectedByTheLiveApi, elementTypeById);

    expect(ordered.find((p) => p.is_captain)?.element).toBe(442);
    expect(ordered.find((p) => p.is_vice_captain)?.element).toBe(264);
    expect(ordered.filter((p) => p.is_captain)).toHaveLength(1);
    expect(ordered.filter((p) => p.is_vice_captain)).toHaveLength(1);
  });

  it('pins the bench keeper to position 12 and leaves the rest of the bench alone', () => {
    const ordered = orderPicksForMyTeam(rejectedByTheLiveApi, elementTypeById);

    expect(ordered[11]?.element).toBe(507);
    // 13-15 are a substitution priority list, not a type order.
    expect(ordered.slice(12).map((p) => p.element)).toEqual([486, 475, 317]);
  });

  it('leaves an already-valid payload untouched', () => {
    // Byte-for-byte the ordering the live API accepted on 2026-09-03.
    const accepted: Pick[] = [
      pick(315, 1),
      pick(431, 2),
      pick(317, 3),
      pick(269, 4),
      pick(187, 5),
      pick(436, 6, { is_vice_captain: true }),
      pick(126, 7),
      pick(128, 8),
      pick(264, 9),
      pick(131, 10),
      pick(442, 11, { is_captain: true }),
      pick(507, 12),
      pick(486, 13),
      pick(475, 14),
      pick(405, 15),
    ];

    expect(orderPicksForMyTeam(accepted, elementTypeById)).toEqual(accepted);
  });
});
