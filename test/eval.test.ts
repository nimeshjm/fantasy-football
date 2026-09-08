/**
 * The eval suite's entry point, in three lanes.
 *
 * - `harness` always runs, needs no cassettes and no network: it drives every
 *   case with a dead provider and checks the whole pipeline still produces a
 *   legal, graded, recorded trial. This is the CI guard.
 * - `replay` runs only once cassettes exist, and re-grades recorded answers.
 * - `live` runs only under EVAL_LIVE=1 and spends real Neurons.
 *
 * Prompt regressions are NOT caught here — see test/evalPrompts.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLegalSquad } from '../src/optimizer/squad';
import { CappedBudget, UnlimitedBudget } from '../eval/core/budget';
import { JsonlRecorder, runSuite } from '../eval/core/runner';
import {
  ReplayAi,
  listCassetteKeys,
  writeCassette,
  writeErrorCassette,
} from '../eval/core/replayAi';
import { restAiFromEnv } from '../eval/core/restAi';
import { formatConsoleTable, summarize, writeReport } from '../eval/core/report';
import { fantasyTasks } from '../eval/suites/fantasy/tasks';
import { fantasyGraders } from '../eval/suites/fantasy/graders';
import { datasetNotes } from '../eval/suites/fantasy/dataset';
import type { AiCallLog, AiShim, EvalTask } from '../eval/core/types';

const CASSETTE_DIR = path.join(import.meta.dirname, '../eval/cassettes');
const RUNS_DIR = path.join(import.meta.dirname, '../eval/runs');
const MODEL = process.env.LLM_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** The honest headroom: the free plan allows 10,000 Neurons/day and the
 * production agent reserves 8,000 of them via NEURON_DAILY_CAP, tracking its
 * own spend in D1 where this run is invisible to it. */
// A full 13-case run charges ~2074. At 2000 the last case (transfer-gw4)
// was skipped for budget in two consecutive live runs, and a live skip fails
// silently: it leaves the previous cassette in place, so the replay lane
// still passes.
const DEFAULT_MAX_NEURONS = 2600;

const tasks = fantasyTasks();

/** Narrows the live lane to one task so a targeted run (say, repeated squad
 * samples to size the run-to-run variance) does not pay for the other two.
 * Live only: the replay lane is free and always grades everything. */
export function selectTasks(taskId: string | undefined): EvalTask[] {
  if (taskId === undefined) return tasks;
  const picked = tasks.filter((t) => t.id === taskId);
  if (picked.length === 0) {
    throw new Error(
      `EVAL_TASK=${taskId} matches no task; have ${tasks.map((t) => t.id).join(', ')}`,
    );
  }
  return picked;
}

function worstCaseOf(selected: EvalTask[]): number {
  let total = 0;
  for (const t of selected) for (const c of t.cases()) total += t.worstCaseNeurons(c);
  return total;
}

function countCases(selected: EvalTask[]): number {
  return selected.reduce((n, t) => n + t.cases().length, 0);
}

function suiteWorstCase(): number {
  return worstCaseOf(tasks);
}

function caseCount(): number {
  return countCases(tasks);
}

/** Stands in for a provider that cannot be reached at all, which is the only
 * way to exercise every case without spending a Neuron. */
class DeadAi implements AiShim {
  readonly mode = 'replay' as const;
  readonly calls: AiCallLog[] = [];

  async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ model, input, error: 'dead provider' });
    throw new Error('dead provider');
  }
}

describe('eval harness', () => {
  it('reports the pre-flight budget for a live run', () => {
    const worst = suiteWorstCase();
    expect(caseCount()).toBeGreaterThan(0);
    expect(selectTasks(undefined)).toHaveLength(3);
    expect(selectTasks('fantasy/squad').map((t) => t.id)).toEqual(['fantasy/squad']);
    expect(countCases(selectTasks('fantasy/squad'))).toBe(3);
    expect(() => selectTasks('squad')).toThrow(/matches no task/);
    expect(worst).toBeGreaterThan(0);
    // Every single call must fit the default cap, or the gate would refuse
    // trials that in practice cost a fraction of their ceiling.
    for (const t of tasks) {
      for (const c of t.cases()) {
        expect(t.attemptCeilingNeurons(c)).toBeLessThan(DEFAULT_MAX_NEURONS);
        expect(t.attemptCeilingNeurons(c)).toBeLessThan(t.worstCaseNeurons(c));
      }
    }
  });

  it('produces a legal, graded, recorded trial for every case even with no provider', async () => {
    const recorder = new JsonlRecorder(mkdtempSync(path.join(tmpdir(), 'eval-run-')));
    const result = await runSuite({
      runId: 'harness',
      mode: 'replay',
      model: MODEL,
      tasks,
      graders: fantasyGraders,
      ai: new DeadAi(),
      budget: new UnlimitedBudget(),
      recorder,
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.trials).toHaveLength(caseCount());

    for (const trial of result.trials) {
      expect(trial.error).toBeUndefined();
      expect(trial.source).toBe('deterministic-fallback');
      expect(trial.scores.length).toBeGreaterThan(0);
      expect(trial.model).toBe(MODEL);
    }

    // A dead provider must still ship a legal answer -- that is the property
    // the deterministic fallback exists for.
    for (const task of tasks) {
      for (const c of task.cases()) {
        const outcome = await task.run(c, new DeadAi(), {
          model: MODEL,
          budget: new UnlimitedBudget(),
        });
        expect(outcome.source).toBe('deterministic-fallback');
        if (outcome.picks && c.input.kind !== 'transfer') {
          expect(isLegalSquad(outcome.picks, c.input.elements)).toEqual([]);
        }
      }
    }

    recorder.flush();
  });

  it('records a skip rather than a fallback trial when the budget cannot cover a call', async () => {
    const recorder = new JsonlRecorder(mkdtempSync(path.join(tmpdir(), 'eval-run-')));
    const result = await runSuite({
      runId: 'broke',
      mode: 'replay',
      model: MODEL,
      tasks,
      graders: fantasyGraders,
      ai: new DeadAi(),
      budget: new CappedBudget(0),
      recorder,
    });

    expect(result.trials).toHaveLength(0);
    expect(result.skipped).toHaveLength(caseCount());
    for (const s of result.skipped) expect(s.reason).toMatch(/budget/);
  });

  it('summarises without collapsing the axes into one score', async () => {
    const recorder = new JsonlRecorder(mkdtempSync(path.join(tmpdir(), 'eval-run-')));
    const result = await runSuite({
      runId: 'summary',
      mode: 'replay',
      model: MODEL,
      tasks,
      graders: fantasyGraders,
      ai: new DeadAi(),
      budget: new UnlimitedBudget(),
      recorder,
    });
    const summary = summarize(result);
    expect(summary.tasks.length).toBe(tasks.length);
    const names = summary.overall.metrics.map((m) => m.name);
    expect(names).not.toContain('score');
    expect(names).not.toContain('total');
    // The regret axis must never be reported without its caveat.
    const regret = summary.overall.metrics.find((m) => m.name === 'regret_points');
    expect(regret?.caveat).toBeTruthy();
    expect(formatConsoleTable(summary)).toContain('regret_points');
  });

  it('surfaces any dataset omissions rather than hiding them', () => {
    expect(Array.isArray(datasetNotes())).toBe(true);
  });
});

const cassetteKeys = listCassetteKeys(CASSETTE_DIR);

describe.skipIf(cassetteKeys.length === 0)('eval replay lane', () => {
  it('re-grades every recorded answer', async () => {
    const recorder = new JsonlRecorder(path.join(RUNS_DIR, 'replay'));
    const result = await runSuite({
      runId: 'replay',
      mode: 'replay',
      model: MODEL,
      tasks,
      graders: fantasyGraders,
      ai: new ReplayAi(CASSETTE_DIR),
      budget: new UnlimitedBudget(),
      recorder,
    });
    const summary = summarize(result);
    recorder.flush();
    writeReport(path.join(RUNS_DIR, 'replay'), summary);
    console.log(formatConsoleTable(summary));
    expect(result.trials.length).toBe(caseCount());

    // A cassette miss surfaces as a provider error, not a thrown test:
    // decide.ts catches every provider throw and retries. So without these
    // two assertions the lane passes green on missing recordings and quietly
    // grades the degraded answer -- deleting a cassette used to leave it
    // passing.
    expect(result.skipped).toEqual([]);
    const providerErrors = result.trials.filter((t) =>
      t.scores.some((s) => s.name === 'provider_error_rate' && s.value > 0),
    );
    expect(providerErrors.map((t) => t.caseId)).toEqual([]);
  });
});

const live = process.env.EVAL_LIVE === '1';

describe.skipIf(!live)('eval live lane', () => {
  it('runs the suite against Workers AI and records cassettes', async () => {
    const cap = Number(process.env.EVAL_MAX_NEURONS ?? DEFAULT_MAX_NEURONS);
    const selected = selectTasks(process.env.EVAL_TASK);
    const repeats = Number(process.env.EVAL_REPEATS ?? 1);
    const worst = worstCaseOf(selected) * repeats;
    console.log(
      `live run: ${selected.map((t) => t.id).join(', ')} | ` +
        `${countCases(selected)} cases x ${repeats} = ${countCases(selected) * repeats} trials | ` +
        `worst case ${worst.toFixed(0)} Neurons, cap ${cap}`,
    );

    const ai = restAiFromEnv();
    const budget = new CappedBudget(cap);
    const runDir = path.join(RUNS_DIR, `live-${Date.now()}`);
    const recorder = new JsonlRecorder(runDir);

    const result = await runSuite({
      runId: path.basename(runDir),
      mode: 'live',
      model: MODEL,
      tasks: selected,
      graders: fantasyGraders,
      ai,
      budget,
      recorder,
      repeats,
    });

    for (const call of ai.calls) {
      if (call.error !== undefined)
        writeErrorCassette(CASSETTE_DIR, call.model, call.input, call.error);
      else writeCassette(CASSETTE_DIR, call.model, call.input, call.envelope);
    }

    const summary = summarize(result);
    recorder.flush();
    writeReport(runDir, summary);
    console.log(formatConsoleTable(summary));
    console.log(`spent ${result.neuronsSpent.toFixed(1)} Neurons of ${cap}`);

    // A budget skip leaves the previous cassette in place, so the replay lane
    // keeps passing and the shortfall goes unnoticed - two live runs silently
    // dropped transfer-gw4 that way. Fail here instead, after the cassettes
    // are written, so the fix is to raise the cap and re-run the remainder.
    expect(result.skipped).toEqual([]);
    expect(result.trials.length).toBe(countCases(selected) * repeats);
    expect(result.neuronsSpent).toBeLessThanOrEqual(cap + 300);
  }, 600_000);
});
