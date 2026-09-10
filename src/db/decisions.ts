import type { Decision, DecisionKind } from '../types';
import { toBool, type GateVerdict } from './types';
import type { ActionLogRow, AiCallRow } from './logging';

/** `actions_log.kind` values that represent an actual LLM decision -- every
 * other kind (`session-health`, `entry-create`, ...) is infra bookkeeping. */
export const DECISION_KINDS = ['squad', 'lineup', 'lineup-recheck', 'transfer'] as const;
export type DecisionActionKind = (typeof DECISION_KINDS)[number];

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;

/** `lineup-recheck` logs its attempts under `ai_calls.decision_kind =
 * 'lineup'` (it just calls `decideLineup()` internally), so it maps onto
 * the same mapped kind as a plain `lineup` decision. */
function mapActionKind(kind: string): DecisionKind | null {
  switch (kind) {
    case 'squad':
      return 'squad';
    case 'lineup':
    case 'lineup-recheck':
      return 'lineup';
    case 'transfer':
      return 'transfer';
    default:
      return null;
  }
}

function parseDecision(intent: unknown): Decision | null {
  if (typeof intent !== 'object' || intent === null || Array.isArray(intent)) return null;
  const d = intent as Record<string, unknown>;
  if (
    typeof d.kind !== 'string' ||
    typeof d.source !== 'string' ||
    typeof d.reasoning !== 'string'
  ) {
    return null;
  }
  return intent as Decision;
}

export interface DecisionWithAttempts {
  action: ActionLogRow;
  decision: Decision | null;
  attempts: AiCallRow[];
}

function byTsIdAsc(a: { ts: string; id: number }, b: { ts: string; id: number }): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id - b.id;
}

/**
 * Correlates `actions_log` rows of decision kind with the `ai_calls` rows
 * that produced them. No shared id exists between the two tables, so the
 * rule is purely temporal: an attempt belongs to the next decision of its
 * mapped kind to be logged after it (`ts <= decision.ts`), unless an
 * earlier decision of that same mapped kind already claimed it (`ts` at or
 * before that earlier decision). This is what keeps a same-tick `lineup`
 * then `lineup-recheck` pair (both `decision_kind = 'lineup'`) from having
 * their attempts merged.
 */
export function groupDecisions(
  actions: ActionLogRow[],
  aiCalls: AiCallRow[],
): { decisions: DecisionWithAttempts[]; orphaned: AiCallRow[] } {
  const sortedActions = actions.filter((a) => mapActionKind(a.kind) !== null).sort(byTsIdAsc);
  const sortedCalls = aiCalls.slice().sort(byTsIdAsc);

  const lastTsByKind = new Map<DecisionKind, string>();
  const claimed = new Set<AiCallRow>();
  const decisions: DecisionWithAttempts[] = [];

  for (const action of sortedActions) {
    const mapped = mapActionKind(action.kind)!;
    const prevTs = lastTsByKind.get(mapped) ?? null;
    const attempts = sortedCalls.filter(
      (c) => c.decisionKind === mapped && c.ts <= action.ts && (prevTs === null || c.ts > prevTs),
    );
    for (const attempt of attempts) claimed.add(attempt);
    decisions.push({ action, decision: parseDecision(action.intent), attempts });
    lastTsByKind.set(mapped, action.ts);
  }

  const orphaned = sortedCalls.filter((c) => !claimed.has(c));
  return { decisions, orphaned };
}

interface RawActionLogRow {
  id: number;
  ts: string;
  kind: string;
  intent: string;
  response: string | null;
  dry_run: number;
  source: string;
  ok: number;
}

function safeParse(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function toActionLogRow(r: RawActionLogRow): ActionLogRow {
  return {
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    intent: safeParse(r.intent),
    response: safeParse(r.response),
    dryRun: toBool(r.dry_run),
    source: r.source,
    ok: toBool(r.ok),
  };
}

interface RawAiCallRow {
  id: number;
  ts: string;
  decision_kind: string;
  model: string;
  prompt: string;
  raw_response: string | null;
  schema_valid: number | null;
  validation_outcome: string | null;
  repaired: number;
  gate_verdict: string | null;
  gate_source: string | null;
  gate_override_reason: string | null;
  llm_score: number | null;
  deterministic_score: number | null;
  est_neurons_in: number;
  est_neurons_out: number;
  metered_prompt_tokens: number | null;
  metered_completion_tokens: number | null;
  metered_neurons: number | null;
  cached_tokens: number | null;
}

function toAiCallRow(r: RawAiCallRow): AiCallRow {
  return {
    id: r.id,
    ts: r.ts,
    decisionKind: r.decision_kind,
    model: r.model,
    prompt: r.prompt,
    rawResponse: r.raw_response,
    schemaValid: r.schema_valid === null ? null : toBool(r.schema_valid),
    validationOutcome: r.validation_outcome,
    repaired: toBool(r.repaired),
    gateVerdict: r.gate_verdict === null ? null : (r.gate_verdict as GateVerdict),
    gateSource: r.gate_source,
    gateOverrideReason: r.gate_override_reason,
    llmScore: r.llm_score,
    deterministicScore: r.deterministic_score,
    estNeuronsIn: r.est_neurons_in,
    estNeuronsOut: r.est_neurons_out,
    meteredPromptTokens: r.metered_prompt_tokens,
    meteredCompletionTokens: r.metered_completion_tokens,
    meteredNeurons: r.metered_neurons,
    cachedTokens: r.cached_tokens,
  };
}

const ACTION_LOG_COLUMNS = 'id, ts, kind, intent, response, dry_run, source, ok';

/**
 * A newest-first, keyset-paginated page of decision rows (`kind` restricted
 * to `DECISION_KINDS` by default). `before` is an ISO `ts` cursor: rows
 * strictly older than it. `idx_actions_log_ts` serves the ordering; the
 * `kind IN (...)` filter runs over that same walk.
 */
export async function getDecisionPage(
  db: D1Database,
  opts: { kinds?: readonly string[]; before?: string; limit?: number } = {},
): Promise<ActionLogRow[]> {
  const kinds = opts.kinds ?? DECISION_KINDS;
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);

  const clauses = [`kind IN (${kinds.map(() => '?').join(', ')})`];
  const params: unknown[] = [...kinds];
  if (opts.before !== undefined) {
    clauses.push('ts < ?');
    params.push(opts.before);
  }
  params.push(limit);

  const { results } = await db
    .prepare(
      `SELECT ${ACTION_LOG_COLUMNS} FROM actions_log WHERE ${clauses.join(' AND ')} ` +
        'ORDER BY ts DESC, id DESC LIMIT ?',
    )
    .bind(...params)
    .all<RawActionLogRow>();
  return results.map(toActionLogRow);
}

export async function getDecisionById(db: D1Database, id: number): Promise<ActionLogRow | null> {
  const row = await db
    .prepare(`SELECT ${ACTION_LOG_COLUMNS} FROM actions_log WHERE id = ?`)
    .bind(id)
    .first<RawActionLogRow>();
  return row === null ? null : toActionLogRow(row);
}

const AI_CALLS_PER_ACTION_BUDGET = 5;
const AI_CALLS_MIN_LIMIT = 50;
const AI_CALLS_MAX_LIMIT = 500;

/**
 * The `ai_calls` rows relevant to a fetched page of decisions, in one query
 * per distinct mapped kind present -- so a caller can feed both arrays into
 * `groupDecisions` without an N+1 query per decision. Capped generously
 * (`ai_calls` sees a handful of rows per hour) rather than windowed
 * precisely: exact pagination isn't worth building for this volume.
 */
export async function getAiCallsForDecisions(
  db: D1Database,
  actions: ActionLogRow[],
): Promise<AiCallRow[]> {
  const mappedKinds = new Set<DecisionKind>();
  let newestTs: string | null = null;
  for (const action of actions) {
    const mapped = mapActionKind(action.kind);
    if (mapped === null) continue;
    mappedKinds.add(mapped);
    if (newestTs === null || action.ts > newestTs) newestTs = action.ts;
  }
  if (mappedKinds.size === 0 || newestTs === null) return [];

  const kinds = [...mappedKinds];
  const limit = Math.min(
    Math.max(actions.length * AI_CALLS_PER_ACTION_BUDGET, AI_CALLS_MIN_LIMIT),
    AI_CALLS_MAX_LIMIT,
  );
  const { results } = await db
    .prepare(
      `SELECT id, ts, decision_kind, model, prompt, raw_response, schema_valid, validation_outcome, ` +
        'repaired, gate_verdict, gate_source, gate_override_reason, llm_score, deterministic_score, ' +
        'est_neurons_in, est_neurons_out, metered_prompt_tokens, metered_completion_tokens, ' +
        `metered_neurons, cached_tokens FROM ai_calls WHERE decision_kind IN (${kinds.map(() => '?').join(', ')}) ` +
        'AND ts <= ? ORDER BY ts DESC, id DESC LIMIT ?',
    )
    .bind(...kinds, newestTs, limit)
    .all<RawAiCallRow>();
  return results.map(toAiCallRow);
}
