/**
 * Token-gated, server-rendered HTML status dashboard (`GET /`).
 *
 * Gating: `DASHBOARD_TOKEN` must both be configured AND match. Returns 404
 * (never 401) whenever either check fails, so an unconfigured or
 * wrong-token request cannot distinguish "no dashboard here" from "wrong
 * token" -- per the task brief, this avoids advertising that a token-gated
 * endpoint exists at all. The token comparison itself is constant-time
 * (`timingSafeEqual`) so response timing cannot be used to brute-force it.
 *
 * Every interpolated value is routed through `escapeHtml` -- names, news
 * text and AI reasoning are free text from the live API/LLM and must never
 * be trusted as markup.
 */

import { checkSessionHealth } from './api/session';
import {
  getAllElements,
  getCurrentAndNextEvent,
  getLatestSquadState,
  getNeuronsSpentToday,
  getProjectionsForEvent,
  getRecentActions,
  getRecentAiCalls,
  getTeams,
  isDryRun,
  isEnabled,
  type ActionLogRow,
  type AiCallRow,
  type ElementRow,
} from './db';
import { createSessionStore } from './sessionStore';
import { parseConfig, type Env } from './env';
import { POSITION_SHORT, type Pick } from './types';

/** Constant-time-ish string comparison: the loop always runs the same
 * number of iterations regardless of where the strings first differ, so
 * response time doesn't leak how many leading characters matched. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length, 32);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    const x = i < aBytes.length ? aBytes[i]! : 0;
    const y = i < bBytes.length ? bBytes[i]! : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

function escapeHtml(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractToken(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) return fromQuery;
  const header = request.headers.get('x-dashboard-token');
  if (header) return header;
  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return null;
}

/**
 * A fresh 404 per call, deliberately a factory rather than a shared constant.
 *
 * Two reasons, either of which is sufficient. First, constructing a Response
 * with a body at module scope is a disallowed global-scope operation in
 * workerd and Cloudflare rejects the upload outright (error 10021) — a
 * module-level `new Response(...)` will not deploy. Second, a Response body
 * can only be consumed once, so handing the same instance to two different
 * requests would serve a used body to the second one.
 */
function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

/**
 * Handles `GET /`. Returns 404 for anything that isn't a correctly-tokened
 * dashboard request; never distinguishes "unconfigured" from "wrong token"
 * in its response.
 */
export async function handleDashboard(request: Request, env: Env): Promise<Response> {
  if (!env.DASHBOARD_TOKEN) return notFound();
  const token = extractToken(request);
  if (!token || !timingSafeEqual(token, env.DASHBOARD_TOKEN)) return notFound();

  const html = await renderDashboardHtml(env);
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function pickRow(pick: Pick, elementById: Map<number, ElementRow>): string {
  const el = elementById.get(pick.element);
  const name = el ? el.web_name : `#${pick.element}`;
  const pos = el ? POSITION_SHORT[el.element_type] : '?';
  const flags = [pick.is_captain ? 'C' : '', pick.is_vice_captain ? 'VC' : '']
    .filter(Boolean)
    .join('/');
  const status = el && el.status !== 'a' ? ` (${escapeHtml(el.status)})` : '';
  const news = el?.news ? ` — ${escapeHtml(el.news)}` : '';
  return (
    `<tr><td>${escapeHtml(pick.position)}</td><td>${escapeHtml(name)}${status}</td>` +
    `<td>${escapeHtml(pos)}</td><td>${escapeHtml(flags)}</td><td>${news}</td></tr>`
  );
}

function actionRow(a: ActionLogRow): string {
  const overrideNote =
    a.source === 'deterministic-gate' ? ' <span class="tag gate">gate override</span>' : '';
  return (
    `<tr><td>${escapeHtml(a.ts)}</td><td>${escapeHtml(a.kind)}</td>` +
    `<td>${escapeHtml(a.source)}${overrideNote}</td>` +
    `<td>${a.ok ? 'ok' : '<span class="tag err">failed</span>'}</td>` +
    `<td>${a.dryRun ? 'dry-run' : 'live'}</td>` +
    `<td><pre>${escapeHtml(safeJson(a.response ?? a.intent))}</pre></td></tr>`
  );
}

function aiCallRow(c: AiCallRow): string {
  return (
    `<tr><td>${escapeHtml(c.ts)}</td><td>${escapeHtml(c.decisionKind)}</td>` +
    `<td>${escapeHtml(c.model)}</td>` +
    `<td>${c.schemaValid === null ? '?' : c.schemaValid ? 'valid' : 'invalid'}</td>` +
    `<td>${c.repaired ? 'yes' : 'no'}</td>` +
    `<td>${escapeHtml(c.gateVerdict ?? '')}</td>` +
    `<td>${escapeHtml(c.estNeuronsIn + c.estNeuronsOut)}</td>` +
    `<td><pre>${escapeHtml(c.validationOutcome ?? '')}</pre></td></tr>`
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? '';
  } catch {
    return String(v);
  }
}

const STYLE = `
  body { font: 14px/1.4 system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: .25rem; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #eee; font-size: .85rem; vertical-align: top; }
  th { background: #f0f0f0; }
  .badges span { display: inline-block; margin-right: 1rem; padding: .2rem .5rem; border-radius: 4px; background: #eee; }
  .tag { padding: 0 .3rem; border-radius: 3px; font-size: .75rem; }
  .tag.gate { background: #fde68a; }
  .tag.err { background: #fecaca; }
  .ok { color: #15803d; } .bad { color: #b91c1c; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; max-width: 40rem; font-size: .75rem; }
`;

async function renderDashboardHtml(env: Env): Promise<string> {
  const config = parseConfig(env);
  const dryRunOverride = await isDryRun(env.DB);
  const enabled = await isEnabled(env.DB);
  const dryRun = config.dryRun || dryRunOverride;

  const sessionStore = createSessionStore(env);
  const session = await sessionStore.getSession();
  let sessionHealthy: boolean | null = null;
  if (session?.cookie) {
    try {
      const health = await checkSessionHealth(env, session.cookie);
      sessionHealthy = health.healthy;
    } catch {
      sessionHealthy = false;
    }
  }
  const entry = session?.entry ?? null;

  const [{ current, next }, elements, teams, recentActions, recentAiCalls] = await Promise.all([
    getCurrentAndNextEvent(env.DB),
    getAllElements(env.DB),
    getTeams(env.DB),
    getRecentActions(env.DB, 25),
    getRecentAiCalls(env.DB, 25),
  ]);
  const elementById = new Map(elements.map((e) => [e.id, e] as const));

  const latestSquad = entry ? await getLatestSquadState(env.DB, entry) : null;
  const projections = next ? await getProjectionsForEvent(env.DB, next.id) : [];
  const neuronsToday = await getNeuronsSpentToday(env.DB, new Date().toISOString().slice(0, 10));

  const squadRows = latestSquad
    ? latestSquad.picks.map((p) => pickRow(p, elementById)).join('')
    : '';

  const topProjections = [...projections]
    .sort((a, b) => b.xpts - a.xpts)
    .slice(0, 15)
    .map((p) => {
      const el = elementById.get(p.element_id);
      return (
        `<tr><td>${escapeHtml(el?.web_name ?? p.element_id)}</td>` +
        `<td>${el ? escapeHtml(POSITION_SHORT[el.element_type]) : '?'}</td>` +
        `<td>${el ? escapeHtml(teams.find((t) => t.id === el.team)?.short_name ?? '?') : '?'}</td>` +
        `<td>${p.xpts.toFixed(2)}</td></tr>`
      );
    })
    .join('');

  return `<!doctype html>
<title>Fantasy Agent Dashboard</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style>
<h1>Fantasy Liga Portugal Agent</h1>

<div class="badges">
  <span class="${enabled ? 'ok' : 'bad'}">Kill switch: ${enabled ? 'ENABLED' : 'DISABLED'}</span>
  <span class="${dryRun ? 'ok' : 'bad'}">Mode: ${dryRun ? 'DRY_RUN' : 'LIVE'}</span>
  <span class="${sessionHealthy === true ? 'ok' : sessionHealthy === false ? 'bad' : ''}">
    Session: ${sessionHealthy === null ? 'unknown' : sessionHealthy ? 'healthy' : 'UNHEALTHY'}
  </span>
  <span>Neurons today: ${escapeHtml(neuronsToday.toFixed(0))} / ${escapeHtml(config.neuronDailyCap)}</span>
  <span>Current GW: ${escapeHtml(current?.name ?? '-')}</span>
  <span>Next deadline: ${escapeHtml(next?.deadline_time ?? '-')}</span>
</div>

<h2>Current squad${latestSquad ? ` (event ${escapeHtml(latestSquad.event)})` : ''}</h2>
${
  latestSquad
    ? `<table><thead><tr><th>#</th><th>Player</th><th>Pos</th><th>Flags</th><th>Notes</th></tr></thead><tbody>${squadRows}</tbody></table>`
    : '<p>No squad on record yet.</p>'
}

<h2>Top projected players${next ? ` (GW${escapeHtml(next.id)})` : ''}</h2>
${
  topProjections
    ? `<table><thead><tr><th>Player</th><th>Pos</th><th>Club</th><th>xPts</th></tr></thead><tbody>${topProjections}</tbody></table>`
    : '<p>No projections computed yet.</p>'
}

<h2>Recent actions</h2>
<table><thead><tr><th>Time</th><th>Kind</th><th>Source</th><th>Status</th><th>Mode</th><th>Detail</th></tr></thead>
<tbody>${recentActions.map(actionRow).join('') || '<tr><td colspan="6">None yet.</td></tr>'}</tbody></table>

<h2>AI call log</h2>
<table><thead><tr><th>Time</th><th>Kind</th><th>Model</th><th>Schema</th><th>Repaired</th><th>Gate</th><th>Neurons</th><th>Outcome</th></tr></thead>
<tbody>${recentAiCalls.map(aiCallRow).join('') || '<tr><td colspan="8">None yet.</td></tr>'}</tbody></table>
`;
}
