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
import { runScheduledTick, type CronPorts, type MinimalEvent } from './cron';
import type { Env } from './env';
import { FantasyApiClient } from './api/client';
import { getBootstrapStatic } from './api/endpoints';
import { checkSessionHealth, getSession as getFantasySession } from './api/session';
import { createSessionStore } from './sessionStore';
import {
  getAllEvents,
  isEnabled,
  logAction,
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
      return checkSessionHealth(env, cookie);
    },

    logAction: (input) => logAction(env.DB, input),

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
    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    // `runScheduledTick` never throws (see src/cron.ts) -- every failure it
    // encounters is logged and swallowed internally, so a straightforward
    // await is enough; nothing here needs its own top-level try/catch.
    const ports = buildCronPorts(env);
    await runScheduledTick(ports);
  },
} satisfies ExportedHandler<Env>;
