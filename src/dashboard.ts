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
  DECISION_KINDS,
  getAiCallsForDecisions,
  getAllElements,
  getCurrentAndNextEvent,
  getDecisionById,
  getDecisionPage,
  getLatestSquadState,
  getNeuronsSpentToday,
  getProjectionsForEvent,
  getRecentActions,
  getProjectionStrategy,
  getRecentAiCalls,
  getRecentSessionBeats,
  getSessionOkState,
  getTeams,
  groupDecisions,
  isDryRun,
  isEnabled,
  type ActionLogRow,
  type AiCallRow,
  type DecisionWithAttempts,
  type ElementRow,
} from './db';
import { createSessionStore } from './sessionStore';
import { failureStreak, SESSION_ALERT_OPEN_KEY } from './sessionHealth';
import { getConfig } from './db';
import { parseConfig, type Env } from './env';
import { POSITION_SHORT, type Pick, type TransferMove } from './types';

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

  // Query-param form only -- isAuthorized/extractToken in adminAuth.ts also
  // accepts the header/bearer forms, but this only needs something to
  // forward onto the links this page emits.
  const token = new URL(request.url).searchParams.get('token');
  const html = await renderDashboardHtml(env, token);
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

function transferRow(t: TransferMove, elementById: Map<number, ElementRow>): string {
  const nameFor = (id: number): string => elementById.get(id)?.web_name ?? `#${id}`;
  return (
    `<tr><td>${escapeHtml(nameFor(t.element_in))}</td><td>${escapeHtml(nameFor(t.element_out))}</td>` +
    `<td>${escapeHtml(t.purchase_price)}</td><td>${escapeHtml(t.selling_price)}</td></tr>`
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

/** Neurons this row actually cost: the METERED figure
 * (`envelope.usage.neurons`, from `metered_neurons`) when the call succeeded
 * and Workers AI reported one, otherwise the pessimistic pre-call ESTIMATE
 * (`est_neurons_in + est_neurons_out`) it was charged instead -- a failed
 * call that actually ran (refusal, truncation, provider error) has no
 * metered usage to true up against, so `decide.ts`'s `callLlm` keeps
 * charging the estimate (issue #27). Labelled explicitly (`metered` / `est`)
 * rather than left as a bare number, so a reader can never mistake one for
 * the other -- before this fix every row showed the same estimate regardless
 * of outcome, and that estimate ran 4-6x the real cost (squad: 86.0 recorded
 * vs 21.4 metered).
 *
 * A `skipped-prompt-too-large`/`skipped-budget` row is a THIRD case, not a
 * degenerate "est": `callLlm` returns before ever calling the provider or
 * `budget.record`, so `est_neurons_in`/`est_neurons_out` there is the
 * reservation that was REFUSED, and nothing was actually spent. Rendering
 * that as `86.0 est` would misread as "this call cost ~86 Neurons" for a
 * call that cost zero -- detected via `validationOutcome`'s `skipped-*`
 * prefix (see `makeAuditSink` in decideCommit.ts), which is written for
 * exactly this pair of outcomes. */
function neuronsCell(c: AiCallRow): string {
  if (c.meteredNeurons !== null) return `${c.meteredNeurons.toFixed(1)} metered`;
  const est = (c.estNeuronsIn + c.estNeuronsOut).toFixed(1);
  if (c.validationOutcome?.startsWith('skipped-')) return `${est} reserved, not spent`;
  return `${est} est`;
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
    `<td>${escapeHtml(neuronsCell(c))}</td>` +
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

function attemptDetails(c: AiCallRow): string {
  const verdict =
    c.gateVerdict === null
      ? '&mdash;'
      : c.gateVerdict === 'override'
        ? '<span class="tag gate">override</span>'
        : escapeHtml(c.gateVerdict);
  const summary =
    `${escapeHtml(c.ts)} &mdash; ${escapeHtml(c.model)} &mdash; ` +
    `schema: ${c.schemaValid === null ? '?' : c.schemaValid ? 'valid' : 'invalid'} &mdash; ` +
    `repaired: ${c.repaired ? 'yes' : 'no'} &mdash; gate: ${verdict} &mdash; ` +
    `${escapeHtml(gateScores(c))} &mdash; ${escapeHtml(neuronsCell(c))}`;
  return (
    `<details class="attempt"><summary>${summary}</summary>` +
    `<details><summary>Prompt &amp; raw response</summary>` +
    `<pre>${escapeHtml(c.prompt)}</pre>` +
    `<pre>${escapeHtml(c.rawResponse ?? '')}</pre>` +
    `</details></details>`
  );
}

function decisionCard(
  d: DecisionWithAttempts,
  elementById: Map<number, ElementRow>,
  opts: { expanded: boolean },
): string {
  const a = d.action;
  const overrideNote =
    a.source === 'deterministic-gate' ? ' <span class="tag gate">gate override</span>' : '';
  const header =
    `<span>${escapeHtml(a.ts)}</span> ` +
    `<span class="tag">${escapeHtml(a.kind)}</span> ` +
    `<span>${escapeHtml(a.source)}${overrideNote}</span> ` +
    `<span>${a.ok ? '<span class="ok">ok</span>' : '<span class="tag err">failed</span>'}</span> ` +
    `<span>${a.dryRun ? 'dry-run' : 'live'}</span>`;

  let body = '';
  if (d.decision) {
    body += `<p>${escapeHtml(d.decision.reasoning)}</p>`;
    if (d.decision.overrideReason) {
      body += `<p><span class="tag gate">override reason</span> ${escapeHtml(d.decision.overrideReason)}</p>`;
    }
    if (d.decision.picks) {
      const rows = d.decision.picks.map((p) => pickRow(p, elementById)).join('');
      body +=
        '<table><thead><tr><th>#</th><th>Player</th><th>Pos</th><th>Flags</th><th>Notes</th></tr></thead>' +
        `<tbody>${rows}</tbody></table>`;
    }
    if (d.decision.transfers && d.decision.transfers.length > 0) {
      const rows = d.decision.transfers.map((t) => transferRow(t, elementById)).join('');
      body +=
        '<table><thead><tr><th>In</th><th>Out</th><th>Purchase</th><th>Selling</th></tr></thead>' +
        `<tbody>${rows}</tbody></table>`;
    }
  } else {
    body += `<pre>${escapeHtml(safeJson(a.intent))}</pre>`;
  }

  const attempts =
    d.attempts.length > 0
      ? d.attempts.map(attemptDetails).join('')
      : '<p>No attempts recorded.</p>';

  return (
    `<details class="decision-card"${opts.expanded ? ' open' : ''}>` +
    `<summary>${header}</summary>` +
    `<div class="decision-body">${body}<h4>Attempts</h4>${attempts}</div>` +
    `</details>`
  );
}

function orphanedSection(calls: AiCallRow[]): string {
  if (calls.length === 0) return '';
  return `<h2>Unattributed attempts</h2>${calls.map(attemptDetails).join('')}`;
}

/** Percent-encodes params via URLSearchParams, then escapes the resulting
 * href for HTML attribute context -- neither step alone is safe (a raw
 * token containing `&` would split into a second param; escaping alone
 * would leave the attribute open). `token` is appended last so every link
 * this page emits carries it forward, or the next click 404s. */
function pageLink(
  path: string,
  params: Record<string, string | undefined>,
  token: string | null,
): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.set(k, v);
  }
  if (token !== null) search.set('token', token);
  const qs = search.toString();
  return escapeHtml(qs ? `${path}?${qs}` : path);
}

function currentKindParam(kinds: readonly string[] | undefined): string | undefined {
  return kinds && kinds.length === 1 ? kinds[0] : undefined;
}

// Duplicates getDecisionPage's own clamp (src/db/decisions.ts) since that
// file isn't in scope here -- kept in sync by hand.
const DEFAULT_DECISIONS_LIMIT = 25;
const MAX_DECISIONS_LIMIT = 100;

function clampDecisionsLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_DECISIONS_LIMIT, 1), MAX_DECISIONS_LIMIT);
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
  .decision-card { border: 1px solid #ddd; border-radius: 6px; margin-top: 1rem; padding: .5rem .75rem; background: #fff; }
  .decision-card > summary { cursor: pointer; font-weight: 600; }
  .decision-card[open] { background: #fffef5; }
  .decision-body { margin-top: .5rem; }
  .decision-body h4 { font-size: .9rem; margin: .75rem 0 .25rem; }
  details.attempt { margin: .3rem 0 .3rem 1rem; }
  details.attempt summary, details.attempt details summary { cursor: pointer; font-size: .85rem; }
  details.attempt details { margin: .3rem 0 .3rem 1rem; }
`;

async function renderDashboardHtml(env: Env, token: string | null): Promise<string> {
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
<p><a href="${pageLink('/decisions', {}, token)}">Full decision log &rarr;</a></p>
<table><thead><tr><th>Time</th><th>Kind</th><th>Model</th><th>Schema</th><th>Repaired</th><th>Gate</th><th>Scores</th><th>Neurons</th><th>Outcome</th></tr></thead>
<tbody>${recentAiCalls.map(aiCallRow).join('') || '<tr><td colspan="9">None yet.</td></tr>'}</tbody></table>
`;
}

/**
 * `GET /decisions`: newest-first, keyset-paginated list of decision cards.
 * Routing (query-string parsing, 404s) is a later agent's job -- this just
 * renders the page for whatever `opts` it's given.
 */
export async function renderDecisionsPage(
  env: Env,
  opts: { token: string | null; kinds?: readonly string[]; before?: string; limit?: number },
): Promise<string> {
  const limit = clampDecisionsLimit(opts.limit);
  const [elements, page] = await Promise.all([
    getAllElements(env.DB),
    getDecisionPage(env.DB, { kinds: opts.kinds, before: opts.before, limit }),
  ]);
  const elementById = new Map(elements.map((e) => [e.id, e] as const));
  const aiCalls = await getAiCallsForDecisions(env.DB, page);
  const { decisions, orphaned } = groupDecisions(page, aiCalls);

  // groupDecisions re-sorts oldest-first; `page` itself is the newest-first
  // order this listing should render in.
  const cards = decisions
    .slice()
    .reverse()
    .map((d) => decisionCard(d, elementById, { expanded: false }))
    .join('');

  const kindParam = currentKindParam(opts.kinds);
  const hasMore = page.length === limit;
  const nextHref = hasMore
    ? pageLink('/decisions', { before: page[page.length - 1]!.ts, kind: kindParam }, opts.token)
    : null;

  const kindLinks = ['all', ...DECISION_KINDS]
    .map((k) => {
      const href = pageLink('/decisions', { kind: k === 'all' ? undefined : k }, opts.token);
      return `<a href="${href}">${escapeHtml(k)}</a>`;
    })
    .join(' | ');

  return `<!doctype html>
<title>Decision log</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style>
<h1>Decision log</h1>
<p><a href="${pageLink('/', {}, opts.token)}">&larr; Dashboard</a></p>
<p>${kindLinks}</p>

${cards || '<p>No decisions recorded.</p>'}

${orphanedSection(orphaned)}

${nextHref ? `<p><a href="${nextHref}">Next page &rarr;</a></p>` : ''}
`;
}

/**
 * `GET /decisions/:id` permalink view. Returns `null` when `id` names no
 * `actions_log` row, or names one that isn't a decision kind (e.g.
 * `session-health`) -- either way the caller turns it into a 404.
 */
export async function renderDecisionPage(
  env: Env,
  id: number,
  token: string | null,
): Promise<string | null> {
  const action = await getDecisionById(env.DB, id);
  if (action === null) return null;

  const [elements, aiCalls] = await Promise.all([
    getAllElements(env.DB),
    getAiCallsForDecisions(env.DB, [action]),
  ]);
  const elementById = new Map(elements.map((e) => [e.id, e] as const));
  const { decisions } = groupDecisions([action], aiCalls);
  if (decisions.length === 0) return null;
  const decision = decisions[0]!;

  return `<!doctype html>
<title>Decision #${escapeHtml(id)}</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style>
<h1>Decision #${escapeHtml(id)}</h1>
<p><a href="${pageLink('/decisions', {}, token)}">&larr; All decisions</a></p>

${decisionCard(decision, elementById, { expanded: true })}
`;
}
