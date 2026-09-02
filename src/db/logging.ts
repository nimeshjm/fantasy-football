import { toBit, type ActionLogInput, type AiCallInput } from './types';

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
