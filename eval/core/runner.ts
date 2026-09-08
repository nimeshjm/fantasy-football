import { mkdirSync, writeFileSync } from 'node:fs';

import type {
  AiCallLog,
  AiLike,
  AiShim,
  AttemptRecord,
  EvalCase,
  EvalTask,
  Recorder,
  RunSuiteOptions,
  RunSuiteResult,
  TaskOutcome,
  TrialRecord,
} from './types';

export class JsonlRecorder implements Recorder {
  private readonly rows: TrialRecord[] = [];

  constructor(private readonly dir: string) {}

  record(t: TrialRecord): void {
    this.rows.push(t);
  }

  trials(): TrialRecord[] {
    return this.rows;
  }

  flush(): void {
    mkdirSync(this.dir, { recursive: true });
    const body = this.rows.map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(`${this.dir}/trials.jsonl`, body.length > 0 ? `${body}\n` : '');
  }
}

function isAiShim(ai: AiLike): ai is AiShim {
  return 'calls' in ai && Array.isArray((ai as { calls?: unknown }).calls);
}

function extractModel(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== 'object') return undefined;
  const model = (envelope as Record<string, unknown>).model;
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

function lastWithUsage(attempts: AttemptRecord[]): AttemptRecord | undefined {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i];
    if (a && a.usage) return a;
  }
  return undefined;
}

/** A skipped attempt never reaches the provider, so `shim.calls` lines up 1:1
 * and in order with the attempts that did. Zipping those two gives an exact
 * attempt->envelope correlation rather than a positional guess. */
function attachRespondingModels(attempts: AttemptRecord[], calls: AiCallLog[]): void {
  let next = 0;
  for (const a of attempts) {
    if (a.outcome === 'skipped-prompt-too-large' || a.outcome === 'skipped-budget') continue;
    const call = calls[next++];
    if (call) a.respondingModel = extractModel(call.envelope);
  }
}

function buildTrial(
  opts: RunSuiteOptions,
  task: EvalTask,
  c: EvalCase,
  repeat: number,
  outcome: TaskOutcome,
  shim: AiShim | undefined,
  callsBefore: number,
): TrialRecord {
  const attempts = outcome.attempts;
  const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
  const withUsage = lastWithUsage(attempts);

  let estNeuronsIn = 0;
  let estNeuronsOut = 0;
  for (const a of attempts) {
    estNeuronsIn += a.estNeuronsIn;
    estNeuronsOut += a.estNeuronsOut;
  }

  if (shim) attachRespondingModels(attempts, shim.calls.slice(callsBefore));
  const respondingModel = [...attempts].reverse().find((a) => a.respondingModel)?.respondingModel;

  return {
    runId: opts.runId,
    ts: new Date().toISOString(),
    caseId: c.id,
    taskId: task.id,
    decisionKind: task.kind,
    repeat,
    mode: opts.mode,
    model: opts.model,
    respondingModel,
    source: outcome.source,
    attemptCount: attempts.length,
    providerOk: lastAttempt ? lastAttempt.outcome === 'ok' : undefined,
    providerReason: lastAttempt?.reason,
    repaired: outcome.source === 'llm-repaired',
    overrideReason: outcome.overrideReason,
    gateVerdict: outcome.gate ? (outcome.gate.accept ? 'accept' : 'override') : undefined,
    gateSource: outcome.gate?.source,
    gateOverrideReason: outcome.gate?.overrideReason,
    llmScore: outcome.gate?.llmScore,
    deterministicScore: outcome.gate?.deterministicScore,
    estNeuronsIn,
    estNeuronsOut,
    meteredPromptTokens: withUsage?.usage?.promptTokens,
    meteredCompletionTokens: withUsage?.usage?.completionTokens,
    meteredNeurons: withUsage?.usage?.neurons,
    cachedTokens: withUsage?.usage?.cachedTokens,
    scores: opts.graders.flatMap((g) => g.grade(c, outcome)),
    error: outcome.error,
  };
}

function buildErrorTrial(
  opts: RunSuiteOptions,
  task: EvalTask,
  c: EvalCase,
  repeat: number,
  error: string,
): TrialRecord {
  return {
    runId: opts.runId,
    ts: new Date().toISOString(),
    caseId: c.id,
    taskId: task.id,
    decisionKind: task.kind,
    repeat,
    mode: opts.mode,
    model: opts.model,
    source: 'deterministic-fallback',
    attemptCount: 0,
    repaired: false,
    estNeuronsIn: 0,
    estNeuronsOut: 0,
    scores: [],
    error,
  };
}

export async function runSuite(opts: RunSuiteOptions): Promise<RunSuiteResult> {
  const trials: TrialRecord[] = [];
  const skipped: RunSuiteResult['skipped'] = [];
  const repeats = opts.repeats ?? 1;
  const shim = isAiShim(opts.ai) ? opts.ai : undefined;

  for (const task of opts.tasks) {
    for (const c of task.cases()) {
      for (let repeat = 0; repeat < repeats; repeat++) {
        const needed = task.worstCaseNeurons(c);
        const left = await opts.budget.remaining();
        if (left < needed) {
          skipped.push({
            caseId: c.id,
            repeat,
            reason: `budget: ${left.toFixed(1)} Neurons left, trial can cost up to ${needed.toFixed(1)}`,
          });
          continue;
        }

        const callsBefore = shim ? shim.calls.length : 0;
        let outcome: TaskOutcome | undefined;
        let failure: string | undefined;
        try {
          outcome = await task.run(c, opts.ai, {
            model: opts.model,
            budget: opts.budget,
            squadMargin: opts.squadMargin,
            lineupAbsFloor: opts.lineupAbsFloor,
          });
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }

        const trial = outcome
          ? buildTrial(opts, task, c, repeat, outcome, shim, callsBefore)
          : buildErrorTrial(opts, task, c, repeat, failure ?? 'unknown error');

        trials.push(trial);
        opts.recorder.record(trial);
      }
    }
  }

  return {
    runId: opts.runId,
    mode: opts.mode,
    trials,
    neuronsSpent: opts.budget.spent(),
    skipped,
  };
}
