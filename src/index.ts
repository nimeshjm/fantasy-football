/**
 * Worker entry point: the token-gated dashboard (`fetch`) and the hourly
 * cron tick (`scheduled`), plus the two `Workflow` class re-exports
 * `wrangler.jsonc`'s `workflows` binding config points at.
 *
 * All decision-making logic lives in `src/cron.ts` (the tick) and
 * `src/workflows/*` (the workflows themselves) -- this file only wires real
 * D1/API/Workflow-binding implementations into their injected interfaces.
 */

import { handleDashboard } from './dashboard';
import { handleLoginProbe } from './loginProbe';
import { notFound } from './adminAuth';
import { runScheduledTick, type CronPorts, type MinimalEvent } from './cron';
import type { Env } from './env';
import { FantasyApiClient } from './api/client';
import { getBootstrapStatic } from './api/endpoints';
import { checkSessionHealth, getSession as getFantasySession } from './api/session';
import { createSessionStore } from './sessionStore';
import { sendWebhookAlert } from './alert';
import {
  fingerprintCookie,
  nextSessionOkState,
  SESSION_ALERT_OPEN_KEY,
  SESSION_ALERT_THRESHOLD,
} from './sessionHealth';
import {
  getAllEvents,
  getConfig,
  getRecentSessionBeats,
  getSessionOkState,
  isEnabled,
  logAction,
  setConfig,
  setSessionOk,
  upsertElements,
  upsertEvents,
  upsertTeams,
} from './db';
import type { GameEvent } from './types';

export { IngestWorkflow, DecideCommitWorkflow } from './workflows';

function toMinimal(e: Pick<GameEvent, 'id' | 'deadline_time' | 'data_checked'>): MinimalEvent {
  return { id: e.id, deadline_time: e.deadline_time, data_checked: e.data_checked };
}

/** Wires real D1/Workflow-binding/live-API implementations into the narrow
 * `CronPorts` interface `runScheduledTick` depends on. Kept separate from
 * `runScheduledTick` itself so the tick's dispatch logic stays testable
 * without a Workers runtime (see test/cron.test.ts). */
function buildCronPorts(env: Env): CronPorts {
  const client = new FantasyApiClient(env.FANTASY_BASE_URL);
  const sessionStore = createSessionStore(env);

  return {
    isEnabled: () => isEnabled(env.DB),

    getPreviousEvents: async () => (await getAllEvents(env.DB)).map(toMinimal),

    // One large fetch+parse (bootstrap-static, ~1MB / ~1.7ms to JSON.parse
    // per the task brief's reference measurement) plus the guarded,
    // chunked upserts -- kept together as this handler's one CPU-bearing
    // pass over the payload, per the "ONE fetch + parse + upsert" budget.
    refreshBootstrap: async () => {
      const bootstrap = await getBootstrapStatic(client);
      const updatedAt = new Date().toISOString();
      await upsertEvents(env.DB, bootstrap.events);
      await upsertTeams(env.DB, bootstrap.teams);
      await upsertElements(env.DB, bootstrap.elements, updatedAt);
      return bootstrap.events.map(toMinimal);
    },

    checkSession: async () => {
      const cookie = await getFantasySession(env, sessionStore);
      const health = await checkSessionHealth(env, cookie);
      // The digest is computed HERE, where the cookie already is, so
      // src/cron.ts is never a place a session cookie can reach.
      return { ...health, cookieFingerprint: await fingerprintCookie(cookie) };
    },

    logAction: (input) => logAction(env.DB, input),

    // Read-modify-write, composed here rather than in src/db so the
    // decision stays a pure function (see src/sessionHealth.ts) and the SQL
    // stays a dumb three-column upsert. The cron is the only writer of these
    // columns, so the non-atomicity is not a race -- which is part of why the
    // login probe must never write the session row.
    recordSessionOk: async (input) => {
      const previous = await getSessionOkState(env.DB);
      await setSessionOk(env.DB, nextSessionOkState(previous, input));
    },

    getSessionAlertState: async () => {
      const [beats, alertOpenRaw, okState] = await Promise.all([
        getRecentSessionBeats(env.DB, SESSION_ALERT_THRESHOLD),
        getConfig(env.DB, SESSION_ALERT_OPEN_KEY),
        getSessionOkState(env.DB),
      ]);
      return { beats, alertOpen: alertOpenRaw === '1', okState };
    },

    setSessionAlertOpen: async (open) => {
      await setConfig(env.DB, SESSION_ALERT_OPEN_KEY, open ? '1' : '0');
    },

    sendAlert: (payload) => sendWebhookAlert(env, payload),

    createDecideWorkflow: async (id, params) => {
      await env.DECIDE.create({ id, params });
    },

    createIngestWorkflow: async (id, params) => {
      await env.INGEST.create({ id, params: { events: [params.eventId] } });
    },

    now: () => new Date(),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return handleDashboard(request, env);
    }
    // POST-only on purpose: this submits real credentials to the live site,
    // so a GET would let any prefetcher that sees the ?token= URL trigger a
    // login attempt. A GET to it therefore falls through to the 404 below.
    if (request.method === 'POST' && url.pathname === '/admin/login-probe') {
      return handleLoginProbe(request, env);
    }
    // Byte-identical to what the deploy-contract test asserts, and dependent
    // on no binding -- see test/workers/deployContract.workers.test.ts.
    return notFound();
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    // `runScheduledTick` never throws (see src/cron.ts) -- every failure it
    // encounters is logged and swallowed internally, so a straightforward
    // await is enough; nothing here needs its own top-level try/catch.
    const ports = buildCronPorts(env);
    await runScheduledTick(ports);
  },
} satisfies ExportedHandler<Env>;
