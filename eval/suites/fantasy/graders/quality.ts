import { RULES, type Pick, type TransferMove } from '../../../../src/types';
import type { CaseInput, EvalCase, Grader, Score, TaskOutcome } from '../../../core/types';

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

function differentiation(c: EvalCase, o: TaskOutcome): number {
  if (c.input.kind === 'transfer') {
    return jaccardDistance(
      transferElementIds(o.transfers),
      transferElementIds(o.reference.transfers),
    );
  }
  if (c.input.kind === 'lineup') {
    return jaccardDistance(xiElementIds(o.picks), xiElementIds(o.reference.picks));
  }
  return jaccardDistance(allElementIds(o.picks), allElementIds(o.reference.picks));
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
