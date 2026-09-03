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

import type { ActionLogInput } from './db';

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
  checkSession(): Promise<{ healthy: boolean; entry?: number }>;
  logAction(input: ActionLogInput): Promise<void>;
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
      };
    }

    const previousEvents = await ports.getPreviousEvents();
    const freshEvents = await ports.refreshBootstrap();

    let sessionHealthy: boolean | null = null;
    try {
      const health = await ports.checkSession();
      sessionHealthy = health.healthy;
      // Logged on EVERY tick, healthy or not, deliberately.
      //
      // This used to log only failures, which made a healthy session
      // indistinguishable from the cron having stopped firing: both look like
      // an empty table. Diagnosing "is it working?" meant cross-referencing
      // elements.updated_at to prove a tick had run at all. Logging both
      // outcomes makes this row a heartbeat -- absence now means the tick
      // itself did not happen, which is a different and much more useful
      // signal. Costs 24 rows/day against a 100k/day budget.
      await ports.logAction({
        ts: new Date().toISOString(),
        kind: 'session-health',
        intent: { check: 'session' },
        response: { healthy: health.healthy, entry: health.entry ?? null },
        dryRun: false,
        source: 'cron',
        ok: health.healthy,
      });
    } catch (err) {
      // A failed health check is itself a dead-session signal -- surface it,
      // never swallow it silently.
      sessionHealthy = false;
      await ports.logAction({
        ts: new Date().toISOString(),
        kind: 'session-health',
        intent: { check: 'session' },
        response: { error: err instanceof Error ? err.message : String(err) },
        dryRun: false,
        source: 'cron',
        ok: false,
      });
    }

    const now = ports.now();
    const nextEvent = findNextEvent(freshEvents, now);
    const plan = planCronActions({ now, nextEvent, previousEvents, freshEvents });

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
    return { skipped: false, deadlineAction: 'none', ingestDispatched: [], sessionHealthy: null };
  }
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
