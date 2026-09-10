import { describe, expect, it } from 'vitest';

import { groupDecisions } from '../src/db/decisions';
import type { ActionLogRow, AiCallRow } from '../src/db/logging';
import type { Decision } from '../src/types';

let nextActionId = 1;
let nextCallId = 1;

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    kind: 'squad',
    source: 'llm',
    reasoning: 'because',
    ...overrides,
  };
}

function action(ts: string, overrides: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id: nextActionId++,
    ts,
    kind: 'squad',
    intent: makeDecision(),
    response: null,
    dryRun: false,
    source: 'llm',
    ok: true,
    ...overrides,
  };
}

function call(ts: string, decisionKind: string, overrides: Partial<AiCallRow> = {}): AiCallRow {
  return {
    id: nextCallId++,
    ts,
    decisionKind,
    model: 'test-model',
    prompt: 'prompt',
    rawResponse: null,
    schemaValid: null,
    validationOutcome: null,
    repaired: false,
    gateVerdict: null,
    gateSource: null,
    gateOverrideReason: null,
    llmScore: null,
    deterministicScore: null,
    estNeuronsIn: 0,
    estNeuronsOut: 0,
    meteredPromptTokens: null,
    meteredCompletionTokens: null,
    meteredNeurons: null,
    cachedTokens: null,
    ...overrides,
  };
}

describe('groupDecisions', () => {
  it('correlates a single decision with its single attempt', () => {
    const a = action('2026-01-01T10:00:00Z', { kind: 'squad' });
    const c = call('2026-01-01T09:59:00Z', 'squad');

    const { decisions, orphaned } = groupDecisions([a], [c]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe(a);
    expect(decisions[0]!.attempts).toEqual([c]);
    expect(orphaned).toEqual([]);
  });

  it('orders multiple attempts (retry/repair) oldest first', () => {
    const a = action('2026-01-01T10:00:00Z', { kind: 'lineup' });
    const c1 = call('2026-01-01T09:58:00Z', 'lineup');
    const c2 = call('2026-01-01T09:59:00Z', 'lineup');
    const c3 = call('2026-01-01T09:59:30Z', 'lineup');

    // deliberately unsorted input
    const { decisions } = groupDecisions([a], [c3, c1, c2]);

    expect(decisions[0]!.attempts).toEqual([c1, c2, c3]);
  });

  it('does not cross-contaminate a lineup decision and a same-tick lineup-recheck', () => {
    const lineup = action('2026-01-01T10:00:00Z', { kind: 'lineup' });
    const recheck = action('2026-01-01T10:30:00Z', { kind: 'lineup-recheck' });

    const attemptForLineup = call('2026-01-01T09:59:00Z', 'lineup');
    const attemptForRecheck = call('2026-01-01T10:15:00Z', 'lineup');

    const { decisions, orphaned } = groupDecisions(
      [recheck, lineup],
      [attemptForRecheck, attemptForLineup],
    );

    const byId = new Map(decisions.map((d) => [d.action.id, d]));
    expect(byId.get(lineup.id)!.attempts).toEqual([attemptForLineup]);
    expect(byId.get(recheck.id)!.attempts).toEqual([attemptForRecheck]);
    expect(orphaned).toEqual([]);
  });

  it("keeps an attempt exactly at the earlier decision's ts with that earlier decision, not the next one", () => {
    const first = action('2026-01-01T10:00:00Z', { kind: 'lineup' });
    const second = action('2026-01-01T10:30:00Z', { kind: 'lineup-recheck' });

    const boundaryAttempt = call('2026-01-01T10:00:00Z', 'lineup');
    const firstOwnAttempt = call('2026-01-01T09:55:00Z', 'lineup');
    const secondOwnAttempt = call('2026-01-01T10:20:00Z', 'lineup');

    const { decisions } = groupDecisions(
      [second, first],
      [secondOwnAttempt, boundaryAttempt, firstOwnAttempt],
    );

    const byId = new Map(decisions.map((d) => [d.action.id, d]));
    expect(byId.get(first.id)!.attempts).toEqual([firstOwnAttempt, boundaryAttempt]);
    expect(byId.get(second.id)!.attempts).toEqual([secondOwnAttempt]);
  });

  it('puts an ai_calls row with no matching action into orphaned', () => {
    const a = action('2026-01-01T10:00:00Z', { kind: 'squad' });
    const attemptForA = call('2026-01-01T09:59:00Z', 'squad');
    const abortedAttempt = call('2026-01-01T11:00:00Z', 'squad');

    const { decisions, orphaned } = groupDecisions([a], [attemptForA, abortedAttempt]);

    expect(decisions[0]!.attempts).toEqual([attemptForA]);
    expect(orphaned).toEqual([abortedAttempt]);
  });

  it('gives a decision with zero attempts an empty array, not an error', () => {
    const a = action('2026-01-01T10:00:00Z', { kind: 'transfer' });

    const { decisions, orphaned } = groupDecisions([a], []);

    expect(decisions[0]!.attempts).toEqual([]);
    expect(orphaned).toEqual([]);
  });

  it('correlates correctly across interleaved mixed kinds', () => {
    const squad = action('2026-01-01T10:00:00Z', { kind: 'squad' });
    const lineup = action('2026-01-01T10:05:00Z', { kind: 'lineup' });
    const transfer = action('2026-01-01T10:10:00Z', { kind: 'transfer' });

    const squadAttempt = call('2026-01-01T09:58:00Z', 'squad');
    const lineupAttempt = call('2026-01-01T10:02:00Z', 'lineup');
    const transferAttempt = call('2026-01-01T10:07:00Z', 'transfer');

    const { decisions, orphaned } = groupDecisions(
      [lineup, transfer, squad],
      [transferAttempt, squadAttempt, lineupAttempt],
    );

    const byId = new Map(decisions.map((d) => [d.action.id, d]));
    expect(byId.get(squad.id)!.attempts).toEqual([squadAttempt]);
    expect(byId.get(lineup.id)!.attempts).toEqual([lineupAttempt]);
    expect(byId.get(transfer.id)!.attempts).toEqual([transferAttempt]);
    expect(orphaned).toEqual([]);
  });

  it('parses intent into a Decision, or null when it does not fit the shape', () => {
    const good = action('2026-01-01T10:00:00Z', {
      kind: 'squad',
      intent: makeDecision({ reasoning: 'good pick' }),
    });
    const bad = action('2026-01-01T10:01:00Z', { kind: 'squad', intent: { unrelated: true } });
    const heartbeatLike = action('2026-01-01T10:02:00Z', {
      kind: 'squad',
      intent: 'not even an object',
    });

    const { decisions } = groupDecisions([good, bad, heartbeatLike], []);

    const byId = new Map(decisions.map((d) => [d.action.id, d.decision]));
    expect(byId.get(good.id)?.reasoning).toBe('good pick');
    expect(byId.get(bad.id)).toBeNull();
    expect(byId.get(heartbeatLike.id)).toBeNull();
  });

  it('excludes non-decision actions_log kinds (e.g. session-health) entirely', () => {
    const heartbeat = action('2026-01-01T10:00:00Z', { kind: 'session-health' });
    const squad = action('2026-01-01T10:05:00Z', { kind: 'squad' });
    const squadAttempt = call('2026-01-01T09:59:00Z', 'squad');

    const { decisions } = groupDecisions([heartbeat, squad], [squadAttempt]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe(squad);
  });
});
