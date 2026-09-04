/**
 * The hourly cron tick's decision logic, split into:
 *
 *  - a PURE planner (`planCronActions`, `planDeadlineAction`,
 *    `detectDataCheckedFlips`) that takes plain data in and returns what to
 *    do, fully unit-testable without a Workers runtime;
 *  - `runScheduledTick`, the impure orchestrator, which takes a small
 *    `CronPorts` interface rather than `Env`/`D1Database` directly so it can
 *    be driven by lightweight fakes in tests too (see test/cron.test.ts).
 *
 * ## Deadline dispatch windows -- widened from the task brief's literal
 * `[T-2h, T-90m]` / `[T-25m, T-15m]`, and why
 *
 * The Worker only wakes up on the hourly cron (`0 * * * *`). A dispatch
 * window narrower than 60 minutes can land entirely between two ticks and
 * never fire at all -- e.g. a deadline at 19:20 makes `[T-25m, T-15m]` =
 * 18:55-19:05, which contains no `:00` tick, so `DECIDE` would silently
 * never be created for that gameweek. That is exactly the "missed deadline"
 * failure the rails in the task brief exist to prevent.
 *
 * Instead this uses two adjacent, minute-since-deadline BUCKETS, each
 * exactly 60 minutes wide:
 *
 *   - `[60, 120)` minutes before deadline -> full decide-commit (baseline,
 *     shortlist, LLM decision, gate, POST).
 *   - `[0, 60)` minutes before deadline -> lineup-only re-commit (re-check
 *     news, re-run the lineup decision, re-POST if it changed).
 *
 * Because ticks are exactly 60 minutes apart, ANY 60-minute-wide window is
 * guaranteed to contain exactly one tick, for any deadline time -- this is
 * a real guarantee, not a widened approximation. Each dispatch is also
 * idempotent (the Workflow instance id is derived from the event id and
 * action, and `Workflow.create` rejects a duplicate id), so if the Worker
 * happens to also fire on an adjacent tick nothing double-dispatches.
 */

import type { ActionLogInput, SessionBeat, SessionOkState } from './db';
import {
  failureStreak,
  planSessionAlert,
  SESSION_ALERT_THRESHOLD,
  type AlertDelivery,
  type SessionAlertPayload,
  type SessionAlertAction,
  type SessionFailureReason,
} from './sessionHealth';

export type DeadlineAction = 'decide' | 'xi-recheck' | 'none';

export interface MinimalEvent {
  id: number;
  deadline_time: string;
  data_checked: boolean;
}

/** See the module doc for why these are 60-minute buckets, not the task
 * brief's literal (narrower) windows. */
export function planDeadlineAction(now: Date, nextEvent: MinimalEvent | null): DeadlineAction {
  if (!nextEvent) return 'none';
  const minsToDeadline = (new Date(nextEvent.deadline_time).getTime() - now.getTime()) / 60_000;
  if (minsToDeadline >= 60 && minsToDeadline < 120) return 'decide';
  if (minsToDeadline >= 0 && minsToDeadline < 60) return 'xi-recheck';
  return 'none';
}

/** An event whose `data_checked` flag just flipped false -> true between the
 * previously-stored state and the freshly-fetched one. Bootstrap-static
 * flips this once final scores for a gameweek are locked in, which is this
 * project's trigger to run `IngestWorkflow` for that gameweek. */
export function detectDataCheckedFlips(
  previous: readonly MinimalEvent[],
  fresh: readonly MinimalEvent[],
): number[] {
  const previouslyChecked = new Map(previous.map((e) => [e.id, e.data_checked]));
  const flips: number[] = [];
  for (const e of fresh) {
    if (e.data_checked && !(previouslyChecked.get(e.id) ?? false)) flips.push(e.id);
  }
  return flips;
}

export interface CronPlan {
  deadlineAction: DeadlineAction;
  /** The event the deadline action applies to. `null` iff `deadlineAction === 'none'`. */
  deadlineEventId: number | null;
  ingestEventIds: number[];
}

export function planCronActions(params: {
  now: Date;
  nextEvent: MinimalEvent | null;
  previousEvents: readonly MinimalEvent[];
  freshEvents: readonly MinimalEvent[];
}): CronPlan {
  const deadlineAction = planDeadlineAction(params.now, params.nextEvent);
  return {
    deadlineAction,
    deadlineEventId: deadlineAction === 'none' ? null : (params.nextEvent?.id ?? null),
    ingestEventIds: detectDataCheckedFlips(params.previousEvents, params.freshEvents),
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Narrow port surface `runScheduledTick` needs, so it can be driven by
 * lightweight fakes in tests rather than a real D1Database/Workflow
 * binding. `src/index.ts` wires the real implementations. */
export interface CronPorts {
  isEnabled(): Promise<boolean>;
  getPreviousEvents(): Promise<MinimalEvent[]>;
  /** Fetches bootstrap-static and upserts events/teams/elements into D1 in
   * one go (ingest's "ONE fetch + parse + upsert" budget applies here too --
   * see src/index.ts). Returns the freshly-fetched events for flip
   * detection. */
  refreshBootstrap(): Promise<MinimalEvent[]>;
  /** Fetches `fixtures/?event={eventId}` for the gameweek being decided next
   * and upserts it into D1, returning how many fixtures were stored.
   *
   * The decide path reads fixtures from D1, never from the API
   * (`decideCommit.ts`'s `project` step), and `IngestWorkflow` only ever
   * writes fixtures for FINISHED gameweeks -- so without this the upcoming
   * gameweek's fixtures are structurally absent at decision time, every
   * projection comes back `xpts: 0`, and the deterministic gate compares 0
   * against 0 and accepts unconditionally. See issue #24.
   *
   * Deliberately on the hourly tick rather than inside the `project` step:
   * the decision then depends only on D1 and gets ~24 chances a day to have
   * succeeded, instead of one live fetch on the critical path at T-60m. */
  refreshUpcomingFixtures(eventId: number): Promise<number>;
  /** Resolves the cookie and asks `me/` whether it still authenticates.
   * Returns the cookie's FINGERPRINT, never the cookie -- src/cron.ts must
   * not be a place a session cookie can reach. */
  checkSession(): Promise<{ healthy: boolean; entry?: number; cookieFingerprint?: string }>;
  logAction(input: ActionLogInput): Promise<void>;
  /** Records a healthy heartbeat against the `session` row (`last_ok_at`,
   * and `first_ok_at` when the cookie is new). */
  recordSessionOk(input: { at: string; fingerprint?: string }): Promise<void>;
  /** The recent heartbeats, the alert latch and the `session` row's ok
   * columns, read together so the read-after-write ordering the alert
   * planner depends on lives at exactly one call site. */
  getSessionAlertState(): Promise<{
    beats: SessionBeat[];
    alertOpen: boolean;
    okState: SessionOkState | null;
  }>;
  setSessionAlertOpen(open: boolean): Promise<void>;
  /** Never throws: failure is a returned `{delivered: false}`. */
  sendAlert(payload: SessionAlertPayload): Promise<AlertDelivery>;
  createDecideWorkflow(
    id: string,
    params: { mode: 'full' | 'lineup-only'; eventId: number },
  ): Promise<void>;
  createIngestWorkflow(id: string, params: { eventId: number }): Promise<void>;
  now(): Date;
}

export interface CronTickResult {
  skipped: 'disabled' | false;
  deadlineAction: DeadlineAction;
  ingestDispatched: number[];
  sessionHealthy: boolean | null;
  /** What the tick did about the session alert. `null` when the alert block
   * itself failed (it is logged and swallowed -- see `runSessionCheck`). */
  alertAction: SessionAlertAction | null;
  /** Fixtures stored for the next gameweek, `null` when there was no next
   * event to fetch for or the fetch failed. */
  upcomingFixtures: number | null;
}

/**
 * Runs one hourly tick. Never throws -- a missed deadline is worse than a
 * mediocre team, so every failure here is logged and swallowed rather than
 * propagated past this function.
 */
export async function runScheduledTick(ports: CronPorts): Promise<CronTickResult> {
  try {
    const enabled = await ports.isEnabled();
    if (!enabled) {
      // Kill switch: no writes at all, including logging.
      return {
        skipped: 'disabled',
        deadlineAction: 'none',
        ingestDispatched: [],
        sessionHealthy: null,
        alertAction: null,
        upcomingFixtures: null,
      };
    }

    const now = ports.now();

    // BEFORE refreshBootstrap, deliberately. The heartbeat used to run after
    // it, which meant a thrown bootstrap fetch went to the outer catch and
    // the tick wrote NO session-health row at all -- so the loudest failure
    // mode (the agent fully dead) produced zero failing beats and, once
    // alerting existed, zero alerts. The check has no dependency on
    // bootstrap, so hoisting it makes "every enabled tick writes exactly one
    // beat" unconditionally true, which is the premise the streak counter
    // needs.
    const { sessionHealthy, alertAction } = await runSessionCheck(ports, now);

    const previousEvents = await ports.getPreviousEvents();
    const freshEvents = await ports.refreshBootstrap();

    const nextEvent = findNextEvent(freshEvents, now);
    const plan = planCronActions({ now, nextEvent, previousEvents, freshEvents });

    // Its own try/catch, and BEFORE the deadline dispatch: a fixtures fetch
    // that fails must never cost us the decide/lineup workflow, which can
    // still run on whatever an earlier tick already stored.
    let upcomingFixtures: number | null = null;
    if (nextEvent !== null) {
      try {
        upcomingFixtures = await ports.refreshUpcomingFixtures(nextEvent.id);
      } catch (err) {
        // Logged, not swallowed silently -- a run of these is what precedes
        // an all-zero projection set.
        await ports.logAction({
          ts: now.toISOString(),
          kind: 'fixtures-refresh-error',
          intent: { event: nextEvent.id },
          response: { error: err instanceof Error ? err.message : String(err) },
          dryRun: false,
          source: 'cron',
          ok: false,
        });
      }
    }

    if (plan.deadlineAction !== 'none' && plan.deadlineEventId !== null) {
      const mode = plan.deadlineAction === 'decide' ? 'full' : 'lineup-only';
      const id =
        plan.deadlineAction === 'decide'
          ? `decide-e${plan.deadlineEventId}`
          : `xi-e${plan.deadlineEventId}`;
      await tryCreate(ports, 'decide', id, () =>
        ports.createDecideWorkflow(id, { mode, eventId: plan.deadlineEventId as number }),
      );
    }

    for (const eventId of plan.ingestEventIds) {
      const id = `ingest-e${eventId}`;
      await tryCreate(ports, 'ingest', id, () => ports.createIngestWorkflow(id, { eventId }));
    }

    return {
      skipped: false,
      deadlineAction: plan.deadlineAction,
      ingestDispatched: plan.ingestEventIds,
      sessionHealthy,
      alertAction,
      upcomingFixtures,
    };
  } catch (err) {
    // Belt-and-suspenders: nothing above should throw uncaught, but the
    // cron handler must never propagate an exception regardless.
    try {
      await ports.logAction({
        ts: new Date().toISOString(),
        kind: 'cron-tick-error',
        intent: {},
        response: { error: err instanceof Error ? err.message : String(err) },
        dryRun: false,
        source: 'cron',
        ok: false,
      });
    } catch {
      // Logging itself failed -- nothing more can be done without risking
      // an uncaught throw from the scheduled handler.
    }
    return {
      skipped: false,
      deadlineAction: 'none',
      ingestDispatched: [],
      sessionHealthy: null,
      alertAction: null,
      upcomingFixtures: null,
    };
  }
}

/**
 * The session half of a tick: one heartbeat row, the `session` row's ok
 * columns, and at most one outward alert.
 *
 * Every step after the heartbeat gets its OWN try/catch, and that structure
 * is load-bearing twice over:
 *
 *  - Sharing the heartbeat's try would let a D1 hiccup on a HEALTHY tick
 *    fall into the failure path and write a second `session-health` row with
 *    `ok: false` -- corrupting the very streak the alert reads.
 *  - Letting any of it throw would abort the tick before the DECIDE
 *    dispatch. A missed deadline is worse than a stale news feed, so
 *    observability must never be able to cost a gameweek.
 */
async function runSessionCheck(
  ports: CronPorts,
  now: Date,
): Promise<{ sessionHealthy: boolean | null; alertAction: SessionAlertAction | null }> {
  const ts = now.toISOString();
  let sessionHealthy: boolean | null = null;
  let fingerprint: string | undefined;
  let reason: SessionFailureReason = 'unauthenticated';
  let detail: string | undefined;

  // Logged on EVERY tick, healthy or not, deliberately.
  //
  // This used to log only failures, which made a healthy session
  // indistinguishable from the cron having stopped firing: both look like an
  // empty table. Diagnosing "is it working?" meant cross-referencing
  // elements.updated_at to prove a tick had run at all. Logging both outcomes
  // makes this row a heartbeat -- absence now means the tick itself did not
  // happen, which is a different and much more useful signal. Costs 24
  // rows/day against a 100k/day budget.
  //
  // `fingerprint` rides along in the response because `session.first_ok_at`
  // is overwritten on a re-paste: without it, the previous cookie's observed
  // lifetime is lost forever. actions_log is never pruned, so (ts,
  // fingerprint, ok) per beat makes lifetime-per-cookie a permanent query.
  try {
    const health = await ports.checkSession();
    sessionHealthy = health.healthy;
    fingerprint = health.cookieFingerprint;
    await ports.logAction({
      ts,
      kind: 'session-health',
      intent: { check: 'session' },
      response: {
        healthy: health.healthy,
        entry: health.entry ?? null,
        fingerprint: health.cookieFingerprint ?? null,
      },
      dryRun: false,
      source: 'cron',
      ok: health.healthy,
    });
  } catch (err) {
    // A failed health check is itself a dead-session signal -- surface it,
    // never swallow it silently.
    sessionHealthy = false;
    reason = 'error';
    detail = err instanceof Error ? err.message : String(err);
    await ports.logAction({
      ts,
      kind: 'session-health',
      intent: { check: 'session' },
      response: { error: detail },
      dryRun: false,
      source: 'cron',
      ok: false,
    });
  }

  if (sessionHealthy) {
    try {
      await ports.recordSessionOk({ at: ts, fingerprint });
    } catch {
      // The heartbeat row already recorded the truth; the denormalised
      // `session` columns are a convenience for the dashboard and the
      // lifetime measurement, never the source of truth.
    }
  }

  try {
    return { sessionHealthy, alertAction: await runAlert(ports, now, reason, detail) };
  } catch {
    return { sessionHealthy, alertAction: null };
  }
}

/** Decides and performs at most one alert action. Reads the beats AFTER the
 * heartbeat above has been written, so `beats[0]` is this tick. */
async function runAlert(
  ports: CronPorts,
  now: Date,
  reason: SessionFailureReason,
  detail: string | undefined,
): Promise<SessionAlertAction> {
  const { beats, alertOpen, okState } = await ports.getSessionAlertState();
  const action = planSessionAlert({
    now,
    beats,
    threshold: SESSION_ALERT_THRESHOLD,
    alertOpen,
  });

  if (action === 'clear') {
    await ports.setSessionAlertOpen(false);
    return action;
  }
  if (action !== 'send') return action;

  const failures = beats.slice(0, failureStreak(beats));
  const payload: SessionAlertPayload = {
    streak: failures.length,
    threshold: SESSION_ALERT_THRESHOLD,
    reason,
    detail,
    firstFailureAt: failures[failures.length - 1]?.ts ?? now.toISOString(),
    lastFailureAt: failures[0]?.ts ?? now.toISOString(),
    // Prefer the denormalised session columns; fall back to the heartbeat
    // archive, which survives even when the session row was never written.
    lastOkAt: okState?.lastOkAt ?? beats.find((b) => b.ok)?.ts ?? null,
    firstOkAt: okState?.firstOkAt ?? null,
    cookieFingerprint:
      okState?.cookieFingerprint ??
      failures.find((b) => b.fingerprint !== null)?.fingerprint ??
      null,
    worker: 'fantasy-football-agent',
  };

  const delivery = await ports.sendAlert(payload);
  // Latch ONLY on delivery. Setting it regardless would mean an unset or
  // broken webhook silences the alerting this exists to add; leaving it
  // closed makes the next tick retry, and leaves a failed `session-alert`
  // row on the dashboard every hour until someone fixes the URL.
  if (delivery.delivered) {
    await ports.setSessionAlertOpen(true);
  }
  await ports.logAction({
    ts: now.toISOString(),
    kind: 'session-alert',
    intent: { streak: payload.streak, threshold: payload.threshold, reason: payload.reason },
    response: { delivered: delivery.delivered, detail: delivery.detail ?? null },
    dryRun: false,
    source: 'cron',
    ok: delivery.delivered,
  });
  return action;
}

/** The relevant "next" event for deadline dispatch: the earliest event whose
 * deadline has not yet passed. Deriving this from the freshly-fetched event
 * list (rather than trusting `is_next`, which briefly lags right at a
 * deadline boundary) keeps dispatch correct even in that edge case. */
function findNextEvent(events: readonly MinimalEvent[], now: Date): MinimalEvent | null {
  let best: MinimalEvent | null = null;
  for (const e of events) {
    if (new Date(e.deadline_time).getTime() <= now.getTime()) continue;
    if (
      best === null ||
      new Date(e.deadline_time).getTime() < new Date(best.deadline_time).getTime()
    ) {
      best = e;
    }
  }
  return best;
}

/** `Workflow.create` rejects a duplicate instance id -- that rejection IS
 * this system's at-most-once latch for a given (event, action) pair, not an
 * error condition. Any failure here (duplicate id, or a genuine dispatch
 * error) is logged and swallowed, never thrown. */
async function tryCreate(
  ports: CronPorts,
  kind: string,
  id: string,
  create: () => Promise<void>,
): Promise<void> {
  try {
    await create();
  } catch (err) {
    await ports.logAction({
      ts: new Date().toISOString(),
      kind: `cron-dispatch-${kind}`,
      intent: { id },
      response: { error: err instanceof Error ? err.message : String(err) },
      dryRun: false,
      source: 'cron',
      ok: false,
    });
  }
}
