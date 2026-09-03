/**
 * Tests for src/cron.ts: the pure dispatch planner, and the impure
 * orchestrator's kill-switch/idempotency/logging behaviour driven through
 * fake `CronPorts`.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  detectDataCheckedFlips,
  planCronActions,
  planDeadlineAction,
  runScheduledTick,
  type CronPorts,
  type MinimalEvent,
} from '../src/cron';

function event(overrides: Partial<MinimalEvent> = {}): MinimalEvent {
  return { id: 5, deadline_time: '2026-09-10T18:00:00Z', data_checked: false, ...overrides };
}

describe('planDeadlineAction', () => {
  it('dispatches "decide" for 60-120 minutes before deadline', () => {
    const deadline = new Date('2026-09-10T18:00:00Z');
    const ev = event({ deadline_time: deadline.toISOString() });

    expect(planDeadlineAction(new Date(deadline.getTime() - 61 * 60_000), ev)).toBe('decide');
    expect(planDeadlineAction(new Date(deadline.getTime() - 90 * 60_000), ev)).toBe('decide');
    expect(planDeadlineAction(new Date(deadline.getTime() - 119 * 60_000), ev)).toBe('decide');
  });

  it('dispatches "xi-recheck" for 0-60 minutes before deadline', () => {
    const deadline = new Date('2026-09-10T18:00:00Z');
    const ev = event({ deadline_time: deadline.toISOString() });

    expect(planDeadlineAction(new Date(deadline.getTime() - 59 * 60_000), ev)).toBe('xi-recheck');
    expect(planDeadlineAction(new Date(deadline.getTime() - 1 * 60_000), ev)).toBe('xi-recheck');
    expect(planDeadlineAction(new Date(deadline.getTime()), ev)).toBe('xi-recheck');
  });

  it('dispatches "none" outside both windows, and once the deadline has passed', () => {
    const deadline = new Date('2026-09-10T18:00:00Z');
    const ev = event({ deadline_time: deadline.toISOString() });

    expect(planDeadlineAction(new Date(deadline.getTime() - 121 * 60_000), ev)).toBe('none');
    expect(planDeadlineAction(new Date(deadline.getTime() + 1), ev)).toBe('none');
  });

  it('dispatches "none" when there is no next event', () => {
    expect(planDeadlineAction(new Date(), null)).toBe('none');
  });

  it('every possible deadline time is caught by exactly one 60-minute-wide bucket per hourly tick', () => {
    // The correctness argument from the module doc, made concrete: for ANY
    // deadline minute-of-hour offset, an hourly tick sequence (spaced
    // exactly 60 minutes apart) must land in the "decide" bucket at least
    // once and the "xi-recheck" bucket at least once.
    for (let offsetMinutes = 0; offsetMinutes < 60; offsetMinutes += 7) {
      const deadline = new Date(Date.UTC(2026, 8, 10, 18, offsetMinutes, 0));
      const ev = event({ deadline_time: deadline.toISOString() });
      const ticks: Date[] = [];
      for (let h = -4; h <= 1; h++) {
        ticks.push(new Date(deadline.getTime() + h * 60 * 60_000));
      }
      const actions = ticks.map((t) => planDeadlineAction(t, ev));
      expect(actions).toContain('decide');
      expect(actions).toContain('xi-recheck');
    }
  });
});

describe('detectDataCheckedFlips', () => {
  it('flags an event whose data_checked flipped false -> true', () => {
    const previous = [event({ id: 1, data_checked: false }), event({ id: 2, data_checked: true })];
    const fresh = [event({ id: 1, data_checked: true }), event({ id: 2, data_checked: true })];
    expect(detectDataCheckedFlips(previous, fresh)).toEqual([1]);
  });

  it('does not re-flag an event that was already data_checked', () => {
    const previous = [event({ id: 1, data_checked: true })];
    const fresh = [event({ id: 1, data_checked: true })];
    expect(detectDataCheckedFlips(previous, fresh)).toEqual([]);
  });

  it('treats an event absent from the previous list as having flipped from false', () => {
    const fresh = [event({ id: 9, data_checked: true })];
    expect(detectDataCheckedFlips([], fresh)).toEqual([9]);
  });
});

describe('planCronActions', () => {
  it('combines the deadline action and the ingest flips into one plan', () => {
    const nextEvent = event({ id: 3, deadline_time: '2026-09-10T18:00:00Z' });
    const now = new Date('2026-09-10T16:30:00Z'); // 90 min before deadline -> decide
    const plan = planCronActions({
      now,
      nextEvent,
      previousEvents: [event({ id: 2, data_checked: false })],
      freshEvents: [event({ id: 2, data_checked: true })],
    });
    expect(plan.deadlineAction).toBe('decide');
    expect(plan.deadlineEventId).toBe(3);
    expect(plan.ingestEventIds).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// runScheduledTick
// ---------------------------------------------------------------------------

function makePorts(overrides: Partial<CronPorts> = {}): CronPorts & {
  logged: unknown[];
  decideCreated: { id: string; params: unknown }[];
  ingestCreated: { id: string; params: unknown }[];
} {
  const logged: unknown[] = [];
  const decideCreated: { id: string; params: unknown }[] = [];
  const ingestCreated: { id: string; params: unknown }[] = [];
  const base: CronPorts = {
    isEnabled: vi.fn().mockResolvedValue(true),
    getPreviousEvents: vi.fn().mockResolvedValue([]),
    refreshBootstrap: vi.fn().mockResolvedValue([]),
    checkSession: vi.fn().mockResolvedValue({ healthy: true, entry: 1 }),
    logAction: vi.fn(async (input: unknown) => {
      logged.push(input);
    }),
    createDecideWorkflow: vi.fn(async (id: string, params: unknown) => {
      decideCreated.push({ id, params });
    }),
    createIngestWorkflow: vi.fn(async (id: string, params: unknown) => {
      ingestCreated.push({ id, params });
    }),
    now: () => new Date('2026-09-10T16:30:00Z'),
  };
  return { ...base, ...overrides, logged, decideCreated, ingestCreated };
}

describe('runScheduledTick', () => {
  it('kill switch: does no writes at all when disabled', async () => {
    const ports = makePorts({ isEnabled: vi.fn().mockResolvedValue(false) });
    const result = await runScheduledTick(ports);

    expect(result.skipped).toBe('disabled');
    expect(ports.getPreviousEvents).not.toHaveBeenCalled();
    expect(ports.refreshBootstrap).not.toHaveBeenCalled();
    expect(ports.checkSession).not.toHaveBeenCalled();
    expect(ports.logAction).not.toHaveBeenCalled();
    expect(ports.createDecideWorkflow).not.toHaveBeenCalled();
    expect(ports.createIngestWorkflow).not.toHaveBeenCalled();
    expect(ports.logged).toEqual([]);
  });

  it('dispatches DECIDE for an event within the decide window', async () => {
    const nextEvent = event({ id: 7, deadline_time: '2026-09-10T18:00:00Z' }); // 90 min from `now`
    const ports = makePorts({
      refreshBootstrap: vi.fn().mockResolvedValue([nextEvent]),
    });
    const result = await runScheduledTick(ports);

    expect(result.deadlineAction).toBe('decide');
    expect(ports.decideCreated).toEqual([
      { id: 'decide-e7', params: { mode: 'full', eventId: 7 } },
    ]);
    expect(ports.ingestCreated).toEqual([]);
  });

  it('dispatches a lineup-only recommit for an event within the xi-recheck window', async () => {
    const nextEvent = event({ id: 7, deadline_time: '2026-09-10T17:00:00Z' }); // 30 min from `now`
    const ports = makePorts({
      refreshBootstrap: vi.fn().mockResolvedValue([nextEvent]),
    });
    const result = await runScheduledTick(ports);

    expect(result.deadlineAction).toBe('xi-recheck');
    expect(ports.decideCreated).toEqual([
      { id: 'xi-e7', params: { mode: 'lineup-only', eventId: 7 } },
    ]);
  });

  it('dispatches INGEST for every event whose data_checked just flipped', async () => {
    const ports = makePorts({
      getPreviousEvents: vi.fn().mockResolvedValue([event({ id: 4, data_checked: false })]),
      refreshBootstrap: vi.fn().mockResolvedValue([event({ id: 4, data_checked: true })]),
    });
    const result = await runScheduledTick(ports);

    expect(result.ingestDispatched).toEqual([4]);
    expect(ports.ingestCreated).toEqual([{ id: 'ingest-e4', params: { eventId: 4 } }]);
  });

  it('logs, but does not throw, when the workflow dispatch itself fails (e.g. duplicate id)', async () => {
    const nextEvent = event({ id: 7, deadline_time: '2026-09-10T18:00:00Z' });
    const ports = makePorts({
      refreshBootstrap: vi.fn().mockResolvedValue([nextEvent]),
      createDecideWorkflow: vi.fn().mockRejectedValue(new Error('instance already exists')),
    });
    await expect(runScheduledTick(ports)).resolves.toBeDefined();
    expect(ports.logged.length).toBeGreaterThan(0);
  });

  it('surfaces a dead session via logAction rather than swallowing it', async () => {
    const ports = makePorts({ checkSession: vi.fn().mockResolvedValue({ healthy: false }) });
    const result = await runScheduledTick(ports);

    expect(result.sessionHealthy).toBe(false);
    expect(ports.logged.some((l) => (l as { kind: string }).kind === 'session-health')).toBe(true);
  });

  it('logs a session-health heartbeat on every tick, not only on failure', async () => {
    // Regression guard. Failure-only logging made a healthy session
    // indistinguishable from the cron having stopped firing -- both produce an
    // empty actions_log -- so confirming the agent was alive required
    // cross-referencing elements.updated_at. The row is a heartbeat: its
    // absence must mean the tick did not run.
    const ports = makePorts(); // default checkSession resolves healthy
    const result = await runScheduledTick(ports);

    expect(result.sessionHealthy).toBe(true);
    const beats = ports.logged.filter((l) => (l as { kind: string }).kind === 'session-health');
    expect(beats).toHaveLength(1);
    expect((beats[0] as { ok: boolean }).ok).toBe(true);
    // The entry id is what makes a healthy beat actionable: it proves the
    // cookie resolved to a real account, not just that a request succeeded.
    expect((beats[0] as { response: { entry: number | null } }).response.entry).toBe(1);
  });
});
