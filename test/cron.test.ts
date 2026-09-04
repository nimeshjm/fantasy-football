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
import {
  planSessionAlert,
  SESSION_ALERT_THRESHOLD,
  SESSION_BEAT_FRESH_WINDOW_MS,
} from '../src/sessionHealth';
import type { SessionBeat } from '../src/db';

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

const NOW = new Date('2026-09-10T16:30:00Z');

function beat(overrides: Partial<SessionBeat> = {}): SessionBeat {
  return {
    ts: NOW.toISOString(),
    ok: false,
    entry: null,
    fingerprint: 'abc123abc123',
    error: null,
    ...overrides,
  };
}

/** `n` failed beats an hour apart ending at `NOW` -- what a genuinely dead
 * cookie looks like in `actions_log`, newest first. */
function failedBeats(n: number): SessionBeat[] {
  return Array.from({ length: n }, (_, i) =>
    beat({ ts: new Date(NOW.getTime() - i * 3_600_000).toISOString() }),
  );
}

function makePorts(overrides: Partial<CronPorts> = {}): CronPorts & {
  logged: unknown[];
  decideCreated: { id: string; params: unknown }[];
  ingestCreated: { id: string; params: unknown }[];
  sessionOks: { at: string; fingerprint?: string }[];
  alertsSent: unknown[];
  alertOpenWrites: boolean[];
} {
  const logged: unknown[] = [];
  const decideCreated: { id: string; params: unknown }[] = [];
  const ingestCreated: { id: string; params: unknown }[] = [];
  const sessionOks: { at: string; fingerprint?: string }[] = [];
  const alertsSent: unknown[] = [];
  const alertOpenWrites: boolean[] = [];
  const base: CronPorts = {
    isEnabled: vi.fn().mockResolvedValue(true),
    getPreviousEvents: vi.fn().mockResolvedValue([]),
    refreshBootstrap: vi.fn().mockResolvedValue([]),
    refreshUpcomingFixtures: vi.fn().mockResolvedValue(9),
    checkSession: vi
      .fn()
      .mockResolvedValue({ healthy: true, entry: 1, cookieFingerprint: 'abc123abc123' }),
    logAction: vi.fn(async (input: unknown) => {
      logged.push(input);
    }),
    recordSessionOk: vi.fn(async (input: { at: string; fingerprint?: string }) => {
      sessionOks.push(input);
    }),
    getSessionAlertState: vi.fn().mockResolvedValue({ beats: [], alertOpen: false, okState: null }),
    setSessionAlertOpen: vi.fn(async (open: boolean) => {
      alertOpenWrites.push(open);
    }),
    sendAlert: vi.fn(async (payload: unknown) => {
      alertsSent.push(payload);
      return { delivered: true };
    }),
    createDecideWorkflow: vi.fn(async (id: string, params: unknown) => {
      decideCreated.push({ id, params });
    }),
    createIngestWorkflow: vi.fn(async (id: string, params: unknown) => {
      ingestCreated.push({ id, params });
    }),
    now: () => NOW,
  };
  return {
    ...base,
    ...overrides,
    logged,
    decideCreated,
    ingestCreated,
    sessionOks,
    alertsSent,
    alertOpenWrites,
  };
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
    // The kill switch is absolute: it also silences the session alert, which
    // is a real hole -- a disabled agent says nothing about a dead cookie.
    // Documented in the README rather than papered over here, because "no
    // writes at all" is the contract this test exists to pin.
    expect(ports.recordSessionOk).not.toHaveBeenCalled();
    expect(ports.getSessionAlertState).not.toHaveBeenCalled();
    expect(ports.setSessionAlertOpen).not.toHaveBeenCalled();
    expect(ports.sendAlert).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Session alerting
// ---------------------------------------------------------------------------

describe('planSessionAlert', () => {
  const threshold = SESSION_ALERT_THRESHOLD;

  it('stays quiet below the threshold', () => {
    expect(planSessionAlert({ now: NOW, beats: failedBeats(2), threshold, alertOpen: false })).toBe(
      'none',
    );
  });

  it('sends on exactly the threshold', () => {
    expect(
      planSessionAlert({ now: NOW, beats: failedBeats(threshold), threshold, alertOpen: false }),
    ).toBe('send');
  });

  it('does not re-send while an alert is already open', () => {
    // The storm guard. Ticks are hourly and a dead cookie stays dead until
    // someone re-pastes it, so without this the webhook fires 24 times a day
    // and the feature is worse than the dashboard it replaces.
    expect(
      planSessionAlert({ now: NOW, beats: failedBeats(threshold), threshold, alertOpen: true }),
    ).toBe('none');
  });

  it('stands the alert down once a beat is healthy again', () => {
    const beats = [beat({ ok: true }), ...failedBeats(threshold)];

    expect(planSessionAlert({ now: NOW, beats, threshold, alertOpen: true })).toBe('clear');
  });

  it('does nothing on recovery when no alert was open', () => {
    expect(
      planSessionAlert({ now: NOW, beats: [beat({ ok: true })], threshold, alertOpen: false }),
    ).toBe('none');
  });

  it('does not alert on a single failure just because the log is short', () => {
    // The boundary bug: on a fresh deploy the tick writes one beat, and
    // "every beat in the list is a failure" would be trivially true.
    expect(planSessionAlert({ now: NOW, beats: failedBeats(1), threshold, alertOpen: false })).toBe(
      'none',
    );
  });

  it('does not count stale failures toward the streak', () => {
    // The kill-switch hole. `isEnabled === false` returns before any write,
    // so no beat is logged at all -- a week disabled leaves old failures
    // sitting at the top of the table. One fresh failure plus two
    // month-old ones is not a three-hour outage and must not page.
    const stale = new Date(NOW.getTime() - 30 * 24 * 3_600_000).toISOString();
    const beats = [beat(), beat({ ts: stale }), beat({ ts: stale })];

    expect(planSessionAlert({ now: NOW, beats, threshold, alertOpen: false })).toBe('none');
  });

  it('counts failures right up to the edge of the freshness window', () => {
    // Guards the window from being so tight that a couple of genuinely
    // missed cron ticks mask a real outage.
    const beats = failedBeats(threshold).map((b, i) =>
      i === threshold - 1
        ? beat({ ts: new Date(NOW.getTime() - (SESSION_BEAT_FRESH_WINDOW_MS - 1)).toISOString() })
        : b,
    );

    expect(planSessionAlert({ now: NOW, beats, threshold, alertOpen: false })).toBe('send');
  });

  it('does nothing when there are no beats at all', () => {
    expect(planSessionAlert({ now: NOW, beats: [], threshold, alertOpen: false })).toBe('none');
  });
});

describe('runScheduledTick session observability', () => {
  it('writes the cookie fingerprint onto every heartbeat', async () => {
    // `session.first_ok_at` is overwritten on a re-paste, so without the
    // fingerprint on the beat the previous cookie's observed lifetime is
    // lost forever. actions_log is never pruned; this makes
    // lifetime-per-cookie a permanent query.
    const ports = makePorts();
    await runScheduledTick(ports);

    const heartbeat = ports.logged.find((l) => (l as { kind: string }).kind === 'session-health');
    expect((heartbeat as { response: { fingerprint: string } }).response.fingerprint).toBe(
      'abc123abc123',
    );
  });

  it('records a healthy heartbeat against the session row, using the injected clock', async () => {
    const ports = makePorts();
    await runScheduledTick(ports);

    expect(ports.sessionOks).toEqual([{ at: NOW.toISOString(), fingerprint: 'abc123abc123' }]);
  });

  it('does not record a session ok when the session is unhealthy', async () => {
    const ports = makePorts({ checkSession: vi.fn().mockResolvedValue({ healthy: false }) });
    await runScheduledTick(ports);

    expect(ports.recordSessionOk).not.toHaveBeenCalled();
  });

  it('writes exactly one heartbeat even when refreshBootstrap throws', async () => {
    // Regression guard. The heartbeat used to run AFTER refreshBootstrap, so
    // a thrown bootstrap fetch went to the outer catch and the tick wrote no
    // session-health row at all -- meaning the loudest failure mode (the
    // agent fully dead) produced zero failing beats and zero alerts.
    const ports = makePorts({
      refreshBootstrap: vi.fn().mockRejectedValue(new Error('bootstrap-static 503')),
    });
    await runScheduledTick(ports);

    const beats = ports.logged.filter((l) => (l as { kind: string }).kind === 'session-health');
    expect(beats).toHaveLength(1);
  });

  it('does not write a second failing heartbeat when recordSessionOk throws', async () => {
    // recordSessionOk gets its own try/catch precisely so a D1 hiccup on a
    // HEALTHY tick cannot fall into the failure path and corrupt the streak
    // the alert reads.
    const ports = makePorts({
      recordSessionOk: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
    });
    const result = await runScheduledTick(ports);

    const beats = ports.logged.filter((l) => (l as { kind: string }).kind === 'session-health');
    expect(beats).toHaveLength(1);
    expect((beats[0] as { ok: boolean }).ok).toBe(true);
    expect(result.sessionHealthy).toBe(true);
  });

  it('still dispatches DECIDE when the whole alert block fails', async () => {
    // A missed deadline is worse than a stale news feed: observability must
    // never be able to cost a gameweek.
    const nextEvent = event({ id: 7, deadline_time: '2026-09-10T18:00:00Z' });
    const ports = makePorts({
      refreshBootstrap: vi.fn().mockResolvedValue([nextEvent]),
      getSessionAlertState: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
    });
    const result = await runScheduledTick(ports);

    expect(result.alertAction).toBeNull();
    expect(ports.decideCreated).toEqual([
      { id: 'decide-e7', params: { mode: 'full', eventId: 7 } },
    ]);
  });

  it('sends one alert and latches it once the streak reaches the threshold', async () => {
    const ports = makePorts({
      checkSession: vi.fn().mockResolvedValue({ healthy: false }),
      getSessionAlertState: vi.fn().mockResolvedValue({
        beats: failedBeats(SESSION_ALERT_THRESHOLD),
        alertOpen: false,
        okState: {
          lastOkAt: '2026-09-10T13:00:00.000Z',
          firstOkAt: '2026-09-01T13:00:00.000Z',
          cookieFingerprint: 'abc123abc123',
        },
      }),
    });
    const result = await runScheduledTick(ports);

    expect(result.alertAction).toBe('send');
    expect(ports.alertsSent).toHaveLength(1);
    expect(ports.alertsSent[0]).toMatchObject({
      streak: SESSION_ALERT_THRESHOLD,
      lastOkAt: '2026-09-10T13:00:00.000Z',
      firstOkAt: '2026-09-01T13:00:00.000Z',
      cookieFingerprint: 'abc123abc123',
    });
    expect(ports.alertOpenWrites).toEqual([true]);
    const audit = ports.logged.find((l) => (l as { kind: string }).kind === 'session-alert');
    expect((audit as { ok: boolean }).ok).toBe(true);
  });

  it('reports why the session failed, so an alert distinguishes a dead cookie from a dead site', async () => {
    const ports = makePorts({
      checkSession: vi.fn().mockRejectedValue(new Error('403 Forbidden')),
      getSessionAlertState: vi.fn().mockResolvedValue({
        beats: failedBeats(SESSION_ALERT_THRESHOLD),
        alertOpen: false,
        okState: null,
      }),
    });
    await runScheduledTick(ports);

    expect(ports.alertsSent[0]).toMatchObject({ reason: 'error', detail: '403 Forbidden' });
  });

  it('does NOT latch the alert when delivery failed, so the next tick retries', async () => {
    // Latching regardless would mean an unset or broken webhook silences the
    // very alerting this exists to add.
    const ports = makePorts({
      checkSession: vi.fn().mockResolvedValue({ healthy: false }),
      getSessionAlertState: vi.fn().mockResolvedValue({
        beats: failedBeats(SESSION_ALERT_THRESHOLD),
        alertOpen: false,
        okState: null,
      }),
      sendAlert: vi.fn().mockResolvedValue({ delivered: false, detail: 'webhook returned 500' }),
    });
    await runScheduledTick(ports);

    expect(ports.alertOpenWrites).toEqual([]);
    const audit = ports.logged.find((l) => (l as { kind: string }).kind === 'session-alert');
    expect((audit as { ok: boolean }).ok).toBe(false);
  });

  it('stands the alert down on recovery so the next incident can fire', async () => {
    const ports = makePorts({
      getSessionAlertState: vi
        .fn()
        .mockResolvedValue({ beats: [beat({ ok: true })], alertOpen: true, okState: null }),
    });
    const result = await runScheduledTick(ports);

    expect(result.alertAction).toBe('clear');
    expect(ports.alertOpenWrites).toEqual([false]);
    expect(ports.sendAlert).not.toHaveBeenCalled();
  });

  it('does not break the tick when sendAlert itself throws', async () => {
    // sendWebhookAlert is contracted never to throw, but the tick must not
    // depend on that contract being kept.
    const ports = makePorts({
      checkSession: vi.fn().mockResolvedValue({ healthy: false }),
      getSessionAlertState: vi.fn().mockResolvedValue({
        beats: failedBeats(SESSION_ALERT_THRESHOLD),
        alertOpen: false,
        okState: null,
      }),
      sendAlert: vi.fn().mockRejectedValue(new Error('unexpected')),
    });

    const result = await runScheduledTick(ports);

    expect(result.alertAction).toBeNull();
    expect(result.sessionHealthy).toBe(false);
  });
});
