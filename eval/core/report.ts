import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunSuiteResult, Score, TrialRecord } from './types';

export interface MetricSummary {
  name: string;
  unit: Score['unit'];
  mean: number;
  min: number;
  max: number;
  n: number;
  nan: number;
  caveat?: string;
}

export interface TaskSummary {
  taskId: string;
  trialCount: number;
  metrics: MetricSummary[];
}

export interface Summary {
  runId: string;
  mode: 'replay' | 'live';
  models: string[];
  respondingModels: string[];
  trialCount: number;
  neuronsSpent: number;
  skipped: { caseId: string; repeat: number; reason: string }[];
  errorCount: number;
  overall: TaskSummary;
  tasks: TaskSummary[];
}

function summarizeGroup(taskId: string, trials: TrialRecord[]): TaskSummary {
  const byName = new Map<string, Score[]>();
  const caveats = new Map<string, string>();
  const units = new Map<string, Score['unit']>();

  for (const trial of trials) {
    for (const score of trial.scores) {
      let bucket = byName.get(score.name);
      if (!bucket) {
        bucket = [];
        byName.set(score.name, bucket);
      }
      bucket.push(score);
      units.set(score.name, score.unit);
      if (score.caveat && !caveats.has(score.name)) caveats.set(score.name, score.caveat);
    }
  }

  const metrics: MetricSummary[] = [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, scores]) => {
      const values = scores.map((s) => s.value);
      const finite = values.filter((v) => Number.isFinite(v));
      const nan = values.length - finite.length;
      const mean = finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN;
      const min = finite.length > 0 ? Math.min(...finite) : NaN;
      const max = finite.length > 0 ? Math.max(...finite) : NaN;
      return {
        name,
        unit: units.get(name)!,
        mean,
        min,
        max,
        n: values.length,
        nan,
        ...(caveats.has(name) ? { caveat: caveats.get(name) } : {}),
      };
    });

  return { taskId, trialCount: trials.length, metrics };
}

export function summarize(result: RunSuiteResult): Summary {
  const models = [...new Set(result.trials.map((t) => t.model))];
  const respondingModels = [
    ...new Set(result.trials.map((t) => t.respondingModel).filter((m): m is string => !!m)),
  ];
  const errorCount = result.trials.filter((t) => t.error).length;

  const byTask = new Map<string, TrialRecord[]>();
  for (const trial of result.trials) {
    let bucket = byTask.get(trial.taskId);
    if (!bucket) {
      bucket = [];
      byTask.set(trial.taskId, bucket);
    }
    bucket.push(trial);
  }

  const tasks = [...byTask.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([taskId, trials]) => summarizeGroup(taskId, trials));

  return {
    runId: result.runId,
    mode: result.mode,
    models,
    respondingModels,
    trialCount: result.trials.length,
    neuronsSpent: result.neuronsSpent,
    skipped: result.skipped,
    errorCount,
    overall: summarizeGroup('overall', result.trials),
    tasks,
  };
}

function fmtNum(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : 'NaN';
}

function headerLine(summary: Summary): string {
  const modelsPart =
    summary.respondingModels.length > 0 &&
    (summary.respondingModels.length !== summary.models.length ||
      summary.respondingModels.some((m) => !summary.models.includes(m)))
      ? `${summary.models.join(', ')} (responding: ${summary.respondingModels.join(', ')})`
      : summary.models.join(', ');

  // A replay run charges nothing; the figure is what the same calls would
  // have cost live, which is worth reporting but must not read as a spend.
  const cost =
    summary.mode === 'live'
      ? `neuronsSpent: ${summary.neuronsSpent.toFixed(1)}`
      : `neuronsWouldHaveCost: ${summary.neuronsSpent.toFixed(1)}`;

  return (
    `runId: ${summary.runId} | mode: ${summary.mode} | model(s): ${modelsPart || '(none)'} | ` +
    `trials: ${summary.trialCount} | ${cost}`
  );
}

function metricRows(metrics: MetricSummary[]): [string, string, string, string, string][] {
  return metrics.map((m) => [
    m.name,
    fmtNum(m.mean),
    fmtNum(m.min),
    fmtNum(m.max),
    m.nan > 0 ? `${m.n} (${m.nan} NaN)` : String(m.n),
  ]);
}

function markdownTable(title: string, task: TaskSummary): string {
  const lines = [`### ${title}`, ''];
  if (task.metrics.length === 0) {
    lines.push(`_no scores recorded (${task.trialCount} trial(s))_`, '');
    return lines.join('\n');
  }
  lines.push(
    '| metric | mean | min | max | n |',
    '| --- | --- | --- | --- | --- |',
    ...metricRows(task.metrics).map(
      ([name, mean, min, max, n]) => `| ${name} | ${mean} | ${min} | ${max} | ${n} |`,
    ),
    '',
  );
  const footnotes = task.metrics.filter((m) => m.caveat);
  for (const m of footnotes) {
    lines.push(`> **${m.name}**: ${m.caveat}`, '');
  }
  return lines.join('\n');
}

export function formatMarkdown(summary: Summary): string {
  const lines = [`# Eval report`, '', headerLine(summary), ''];

  if (summary.trialCount === 0) {
    lines.push(
      '**No trials were recorded.**',
      '',
      summary.skipped.length > 0
        ? `All ${summary.skipped.length} case/repeat(s) were skipped:\n\n${summary.skipped
            .map((s) => `- \`${s.caseId}\` (repeat ${s.repeat}): ${s.reason}`)
            .join('\n')}`
        : '_No cases were skipped either — the suite had nothing to run._',
      '',
    );
    return lines.join('\n');
  }

  if (summary.errorCount > 0) {
    lines.push(`**${summary.errorCount} trial(s) recorded an error.**`, '');
  }
  if (summary.skipped.length > 0) {
    lines.push(
      `**${summary.skipped.length} case/repeat(s) skipped** (not model failures):`,
      '',
      ...summary.skipped.map((s) => `- \`${s.caseId}\` (repeat ${s.repeat}): ${s.reason}`),
      '',
    );
  }

  lines.push(markdownTable('Overall', summary.overall));
  for (const task of summary.tasks) {
    lines.push(markdownTable(task.taskId, task));
  }

  return lines.join('\n').trimEnd() + '\n';
}

function padCols(rows: string[][], headers: string[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const renderRow = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? c.length))
      .join(' | ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('-|-');
  return [renderRow(headers), sep, ...rows.map(renderRow)].join('\n');
}

function consoleTable(title: string, task: TaskSummary): string {
  if (task.metrics.length === 0) {
    return `${title}\n(no scores recorded, ${task.trialCount} trial(s))`;
  }
  const headers = ['metric', 'mean', 'min', 'max', 'n'];
  const rows = metricRows(task.metrics);
  const table = padCols(rows, headers);
  const footnotes = task.metrics.filter((m) => m.caveat).map((m) => `  * ${m.name}: ${m.caveat}`);
  return [title, table, ...footnotes].join('\n');
}

export function formatConsoleTable(summary: Summary): string {
  const parts = [headerLine(summary)];

  if (summary.trialCount === 0) {
    parts.push('no trials were recorded');
    if (summary.skipped.length > 0) {
      parts.push(
        `all ${summary.skipped.length} case/repeat(s) skipped:`,
        ...summary.skipped.map((s) => `  - ${s.caseId} (repeat ${s.repeat}): ${s.reason}`),
      );
    }
    return parts.join('\n');
  }

  if (summary.errorCount > 0) parts.push(`${summary.errorCount} trial(s) recorded an error`);
  if (summary.skipped.length > 0) {
    parts.push(
      `${summary.skipped.length} case/repeat(s) skipped (not model failures):`,
      ...summary.skipped.map((s) => `  - ${s.caseId} (repeat ${s.repeat}): ${s.reason}`),
    );
  }

  parts.push('', consoleTable('overall', summary.overall));
  for (const task of summary.tasks) {
    parts.push('', consoleTable(task.taskId, task));
  }

  return parts.join('\n');
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value))
    return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
  return value;
}

export function writeReport(dir: string, summary: Summary): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, jsonReplacer, 2));
  writeFileSync(path.join(dir, 'report.md'), formatMarkdown(summary));
}
