import { toBool, toBit, type ActionLogInput, type AiCallInput } from './types';

/** One row read back from `actions_log`. `intent`/`response` are stored as
 * JSON TEXT (see `logAction`) and parsed back here -- never hand the raw
 * column value to a caller. */
export interface ActionLogRow {
  id: number;
  ts: string;
  kind: string;
  intent: unknown;
  response: unknown;
  dryRun: boolean;
  source: string;
  ok: boolean;
}

/** One row read back from `ai_calls`. */
export interface AiCallRow {
  id: number;
  ts: string;
  decisionKind: string;
  model: string;
  prompt: string;
  rawResponse: string | null;
  schemaValid: boolean | null;
  validationOutcome: string | null;
  repaired: boolean;
  gateVerdict: string | null;
  estNeuronsIn: number;
  estNeuronsOut: number;
}

/** Logs one action (a committed decision, or an attempted one under
 * dry-run). One bound-param insert -- called at most a few times per
 * invocation, never in bulk. */
export async function logAction(db: D1Database, input: ActionLogInput): Promise<void> {
  await db
    .prepare(
      'INSERT INTO actions_log (ts, kind, intent, response, dry_run, source, ok) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      input.ts,
      input.kind,
      JSON.stringify(input.intent),
      input.response === undefined ? null : JSON.stringify(input.response),
      toBit(input.dryRun),
      input.source,
      toBit(input.ok),
    )
    .run();
}

/** Logs one call to the LLM (prompt, raw response, and how it was judged).
 * One bound-param insert per call. */
export async function logAiCall(db: D1Database, input: AiCallInput): Promise<void> {
  await db
    .prepare(
      'INSERT INTO ai_calls ' +
        '(ts, decision_kind, model, prompt, raw_response, schema_valid, validation_outcome, repaired, gate_verdict, est_neurons_in, est_neurons_out) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      input.ts,
      input.decisionKind,
      input.model,
      input.prompt,
      input.rawResponse ?? null,
      input.schemaValid === undefined ? null : toBit(input.schemaValid),
      input.validationOutcome ?? null,
      toBit(input.repaired),
      input.gateVerdict ?? null,
      input.estNeuronsIn,
      input.estNeuronsOut,
    )
    .run();
}

/** Neurons spent so far today (UTC date string, e.g. "2026-09-02").
 * Returns 0 if no calls have been logged for that day yet. */
export async function getNeuronsSpentToday(db: D1Database, utcDay: string): Promise<number> {
  const row = await db
    .prepare('SELECT neurons_spent FROM ai_budget WHERE day = ?')
    .bind(utcDay)
    .first<{
      neurons_spent: number;
    }>();
  return row?.neurons_spent ?? 0;
}

/**
 * Atomically adds `neurons` to today's spend, in one statement (read-then-
 * write would race across concurrent invocations and cost an extra query).
 */
export async function addNeuronsSpent(
  db: D1Database,
  utcDay: string,
  neurons: number,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO ai_budget (day, neurons_spent) VALUES (?, ?) ' +
        'ON CONFLICT(day) DO UPDATE SET neurons_spent = neurons_spent + excluded.neurons_spent',
    )
    .bind(utcDay, neurons)
    .run();
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
    return json; // shouldn't happen -- logAction always stringifies -- but never throw on read
  }
}

/**
 * The most recent `limit` entries from `actions_log`, newest first. Added
 * for the dashboard (`src/dashboard.ts`), which needs to show planned/last
 * actions and gate overrides -- `idx_actions_log_ts` serves this without a
 * full table scan.
 */
export async function getRecentActions(db: D1Database, limit = 20): Promise<ActionLogRow[]> {
  const { results } = await db
    .prepare(
      'SELECT id, ts, kind, intent, response, dry_run, source, ok FROM actions_log ORDER BY ts DESC LIMIT ?',
    )
    .bind(limit)
    .all<RawActionLogRow>();
  return results.map((r) => ({
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    intent: safeParse(r.intent),
    response: safeParse(r.response),
    dryRun: toBool(r.dry_run),
    source: r.source,
    ok: toBool(r.ok),
  }));
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
  est_neurons_in: number;
  est_neurons_out: number;
}

/**
 * The most recent `limit` entries from `ai_calls`, newest first. Added for
 * the dashboard's "AI call log with reasoning" -- `idx_ai_calls_ts` serves
 * this without a full table scan.
 */
export async function getRecentAiCalls(db: D1Database, limit = 20): Promise<AiCallRow[]> {
  const { results } = await db
    .prepare(
      'SELECT id, ts, decision_kind, model, prompt, raw_response, schema_valid, validation_outcome, ' +
        'repaired, gate_verdict, est_neurons_in, est_neurons_out FROM ai_calls ORDER BY ts DESC LIMIT ?',
    )
    .bind(limit)
    .all<RawAiCallRow>();
  return results.map((r) => ({
    id: r.id,
    ts: r.ts,
    decisionKind: r.decision_kind,
    model: r.model,
    prompt: r.prompt,
    rawResponse: r.raw_response,
    schemaValid: r.schema_valid === null ? null : toBool(r.schema_valid),
    validationOutcome: r.validation_outcome,
    repaired: toBool(r.repaired),
    gateVerdict: r.gate_verdict,
    estNeuronsIn: r.est_neurons_in,
    estNeuronsOut: r.est_neurons_out,
  }));
}
