import { RULES, type Pick, type TransferMove } from '../../../../src/types';
import {
  parseLineupResult,
  parseSquadResult,
  parseTransferResult,
} from '../../../../src/ai/schemas';
import type {
  AttemptRecord,
  CaseInput,
  EvalCase,
  Grader,
  Score,
  TaskOutcome,
} from '../../../core/types';

const REGRET_CAVEAT =
  "Regret measures agreement with this repo's own projection model, not football skill " +
  '— a model that copies the optimizer scores zero regret and adds nothing, which is why ' +
  '`differentiation` is reported beside it.';

const REALIZED_CAVEAT =
  'Three gameweeks is not enough to separate models, and the input state carries two ' +
  'documented leaks (`status`/`chance_of_playing_next_round` and `now_cost` via ' +
  '`priceFactor` — see test/backtest.test.ts) plus no autosub simulation, since this ' +
  "game's bench-autosub semantics aren't established anywhere in this repo. This metric " +
  'is descriptive only and must never be used as a pass/fail threshold.';

function xiElementIds(picks: Pick[] | undefined): Set<number> {
  return new Set((picks ?? []).filter((p) => p.position <= RULES.squadPlay).map((p) => p.element));
}

function allElementIds(picks: Pick[] | undefined): Set<number> {
  return new Set((picks ?? []).map((p) => p.element));
}

function transferElementIds(transfers: TransferMove[] | undefined): Set<number> {
  const ids = new Set<number>();
  for (const t of transfers ?? []) {
    ids.add(t.element_in);
    ids.add(t.element_out);
  }
  return ids;
}

function jaccardDistance(a: Set<number>, b: Set<number>): number {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return 1 - intersection / union.size;
}

/**
 * The model's own answer, re-parsed from `rawResponse` -- never
 * `TaskOutcome.picks`. When `gateDecision` overrides, the shipped picks *are*
 * the optimizer's, so a differentiation read off them collapses to 0 and the
 * metric silently degenerates into `gate_accept_rate`. That is exactly what
 * happened: three live runs reported differentiation 0.232 / 0.694 / 0.232
 * against gate_accept_rate 0.333 / 1.000 / 0.333, and the apparent
 * differentiation gain was only the gate accepting more often.
 */
function modelAnswerIds(
  kind: EvalCase['input']['kind'],
  attempts: AttemptRecord[],
): Set<number> | undefined {
  for (const a of [...attempts].reverse()) {
    if (a.rawResponse === undefined) continue;
    if (kind === 'squad') {
      const parsed = parseSquadResult(a.rawResponse);
      if (parsed.ok) return new Set(parsed.value.picks);
    } else if (kind === 'lineup') {
      const parsed = parseLineupResult(a.rawResponse);
      if (parsed.ok) return new Set(parsed.value.starters);
    } else {
      const parsed = parseTransferResult(a.rawResponse);
      if (parsed.ok) {
        const { element_in, element_out } = parsed.value;
        return element_in === 0 && element_out === 0
          ? new Set<number>()
          : new Set([element_in, element_out]);
      }
    }
  }
  return undefined;
}

function differentiation(c: EvalCase, o: TaskOutcome): number {
  const model = modelAnswerIds(c.input.kind, o.attempts);
  // No attempt parsed, so there is no model answer to be different from the
  // reference -- 0 would read as "identical to the optimizer".
  if (model === undefined) return NaN;

  if (c.input.kind === 'transfer') {
    const reference = transferElementIds(o.reference.transfers);
    // The transfer reference is `fallbackMove`, which is empty ("make no
    // transfer"). Distance from the empty set is 1 for any move the model
    // makes, so the figure carries no information -- the first live run
    // duly reported a flat 1.0 across every transfer case. NaN is the
    // honest answer until there is a non-trivial reference to compare to.
    if (reference.size === 0) return NaN;
    return jaccardDistance(model, reference);
  }
  if (c.input.kind === 'lineup') {
    return jaccardDistance(model, xiElementIds(o.reference.picks));
  }
  return jaccardDistance(model, allElementIds(o.reference.picks));
}

export const regretGrader: Grader<CaseInput> = {
  id: 'regret',
  grade(c, o) {
    const gate = o.gate;
    const llmScore = gate?.llmScore;
    const detScore = gate?.deterministicScore;
    const hasScores = llmScore !== undefined && detScore !== undefined;
    const regretPoints = hasScores ? detScore - llmScore : NaN;
    const regretRatio = detScore === undefined || detScore === 0 ? NaN : regretPoints / detScore;
    const gateAcceptRate = gate === undefined ? NaN : gate.accept ? 1 : 0;

    return [
      { name: 'regret_points', value: regretPoints, unit: 'points', caveat: REGRET_CAVEAT },
      { name: 'regret_ratio', value: regretRatio, unit: 'ratio', caveat: REGRET_CAVEAT },
      { name: 'gate_accept_rate', value: gateAcceptRate, unit: 'ratio', caveat: REGRET_CAVEAT },
      { name: 'differentiation', value: differentiation(c, o), unit: 'ratio' },
    ] satisfies Score[];
  },
};

function xiRealizedPoints(picks: Pick[] | undefined, pointsByElement: Map<number, number>): number {
  let total = 0;
  for (const p of picks ?? []) {
    if (p.position > RULES.squadPlay) continue;
    const pts = pointsByElement.get(p.element) ?? 0;
    total += p.is_captain ? pts * 2 : pts;
  }
  return total;
}

export const realizedPointsGrader: Grader<CaseInput> = {
  id: 'realized',
  grade(c, o) {
    if (!c.truth) return [];
    // A transfer's realized value isn't a single gameweek's XI points.
    if (o.kind === 'transfer') return [];

    const modelPoints = xiRealizedPoints(o.picks, c.truth.pointsByElement);
    const referencePoints = xiRealizedPoints(o.reference.picks, c.truth.pointsByElement);

    return [
      { name: 'realized_points', value: modelPoints, unit: 'points', caveat: REALIZED_CAVEAT },
      {
        name: 'realized_points_reference',
        value: referencePoints,
        unit: 'points',
        caveat: REALIZED_CAVEAT,
      },
      {
        name: 'realized_delta',
        value: modelPoints - referencePoints,
        unit: 'points',
        caveat: REALIZED_CAVEAT,
      },
    ] satisfies Score[];
  },
};

export const qualityGraders: Grader[] = [regretGrader, realizedPointsGrader];
