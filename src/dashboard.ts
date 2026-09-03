/**
 * Token-gated, server-rendered HTML status dashboard (`GET /`).
 *
 * Gating lives in src/adminAuth.ts, shared with the login-probe route:
 * `DASHBOARD_TOKEN` must both be configured AND match, and every failure is
 * a 404 rather than a 401 so an unconfigured or wrong-token request cannot
 * distinguish "no dashboard here" from "wrong token".
 *
 * Every interpolated value is routed through `escapeHtml` -- names, news
 * text and AI reasoning are free text from the live API/LLM and must never
 * be trusted as markup.
 */

import { isAuthorized, notFound } from './adminAuth';
import { checkSessionHealth, peekSession } from './api/session';
import {
  getAllElements,
  getCurrentAndNextEvent,
  getLatestSquadState,
  getNeuronsSpentToday,
  getProjectionsForEvent,
  getRecentActions,
  getProjectionStrategy,
  getRecentAiCalls,
  getRecentSessionBeats,
  getSessionOkState,
  getTeams,
  isDryRun,
  isEnabled,
  type ActionLogRow,
  type AiCallRow,
  type ElementRow,
} from './db';
import { createSessionStore } from './sessionStore';
import { failureStreak, SESSION_ALERT_OPEN_KEY } from './sessionHealth';
import { getConfig } from './db';
import { parseConfig, type Env } from './env';
import { POSITION_SHORT, type Pick } from './types';

/** How long the current cookie has been working, in whole days/hours. The
 * headline number issue #14 wants -- but a LOWER BOUND: `first_ok_at` is
 * stamped at the first healthy tick after this shipped, not at paste time,
 * so a cookie pasted weeks earlier reads as young. Only a cookie whose
 * `first_ok_at` was set from its own paste gives a true lifetime. */
function describeAge(firstOkAt: string | null): string {
  if (firstOkAt === null) return 'age unknown';
  const ms = Date.now() - new Date(firstOkAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'age unknown';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
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

/**
 * Handles `GET /`. Returns 404 for anything that isn't a correctly-tokened
 * dashboard request; never distinguishes "unconfigured" from "wrong token"
 * in its response.
 */
export async function handleDashboard(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return notFound();

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

/** `llm 12.34 vs det 15.00` -- the two scores the gate compared, or `-`
 * when the gate never ran (the attempt failed before it) or had no score to
 * compare (the transfer gate is a legality check). A verdict is only
 * judgeable next to the margin behind it. */
function gateScores(c: AiCallRow): string {
  if (c.llmScore === null && c.deterministicScore === null) return '-';
  const llm = c.llmScore === null ? '?' : c.llmScore.toFixed(2);
  const det = c.deterministicScore === null ? '?' : c.deterministicScore.toFixed(2);
  return `llm ${llm} vs det ${det}`;
}

function aiCallRow(c: AiCallRow): string {
  const verdict =
    c.gateVerdict === 'override'
      ? '<span class="tag gate">override</span>'
      : escapeHtml(c.gateVerdict ?? '');
  // `gate_verdict IS NULL` means the gate never ran -- the attempt failed
  // before it. Rendered as an em dash, never as "accept", so a never-gated
  // call stays distinguishable from an accepted one on sight.
  const detail = c.gateOverrideReason ?? c.validationOutcome ?? '';
  return (
    `<tr><td>${escapeHtml(c.ts)}</td><td>${escapeHtml(c.decisionKind)}</td>` +
    `<td>${escapeHtml(c.model)}</td>` +
    `<td>${c.schemaValid === null ? '?' : c.schemaValid ? 'valid' : 'invalid'}</td>` +
    `<td>${c.repaired ? 'yes' : 'no'}</td>` +
    `<td>${c.gateVerdict === null ? '&mdash;' : verdict}</td>` +
    `<td>${escapeHtml(gateScores(c))}</td>` +
    `<td>${escapeHtml(c.estNeuronsIn + c.estNeuronsOut)}</td>` +
    `<td><pre>${escapeHtml(detail)}</pre></td></tr>`
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
  // Which projection model is actually driving the numbers below. Two
  // strategies ship and either can be active, so a dashboard that doesn't
  // say which one produced the xPts column is unreadable.
  const strategy = await getProjectionStrategy(env.DB);

  // `peekSession`, not `getSession`: this renders on a GET, so it must not
  // 500 when FANTASY_SESSION_COOKIE is unset (getSession throws under
  // `manual`) and must not perform a login and write the session store on a
  // cache miss (getSession does, under `password`).
  const sessionStore = createSessionStore(env);
  const cookie = await peekSession(env, sessionStore);
  let sessionHealthy: boolean | null = null;
  let entry: number | null = null;
  if (cookie) {
    try {
      const health = await checkSessionHealth(env, cookie);
      sessionHealthy = health.healthy;
      // The live check is the only place `entry` is reliably available under
      // `SESSION_PROVIDER=manual`: nothing writes it to the session row, so
      // this is what stops the squad panel below from being permanently
      // blank.
      entry = health.entry ?? null;
    } catch {
      sessionHealthy = false;
    }
  }

  // Session observability (issue #14): how long the current cookie has been
  // working, how long it has been failing, and whether anyone was told.
  const [okState, beats, alertOpenRaw] = await Promise.all([
    getSessionOkState(env.DB),
    getRecentSessionBeats(env.DB, 24),
    getConfig(env.DB, SESSION_ALERT_OPEN_KEY),
  ]);
  const streak = failureStreak(beats);
  const alertOpen = alertOpenRaw === '1';
  const cookieAge = describeAge(okState?.firstOkAt ?? null);

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
  <span class="${streak > 0 ? 'bad' : ''}">
    Last ok: ${escapeHtml(okState?.lastOkAt ?? 'never')}${streak > 0 ? ` (${escapeHtml(streak)} failed beats since)` : ''}
  </span>
  <span>Cookie: ${escapeHtml(okState?.cookieFingerprint ?? '-')} (${escapeHtml(cookieAge)})</span>
  <span class="${alertOpen ? 'bad' : ''}">Alert: ${alertOpen ? 'OPEN' : 'none'}</span>
  <span>Projections: ${escapeHtml(strategy)}</span>
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
<table><thead><tr><th>Time</th><th>Kind</th><th>Model</th><th>Schema</th><th>Repaired</th><th>Gate</th><th>Scores</th><th>Neurons</th><th>Outcome</th></tr></thead>
<tbody>${recentAiCalls.map(aiCallRow).join('') || '<tr><td colspan="9">None yet.</td></tr>'}</tbody></table>
`;
}
