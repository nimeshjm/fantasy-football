import type { AttemptRecord, EvalCase, Grader, Score, TaskOutcome } from '../../../core/types';

const NO_USAGE_CAVEAT = 'no attempt reported metered usage; true cost was non-zero';

function sumUsage(
  attempts: AttemptRecord[],
  pick: (u: NonNullable<AttemptRecord['usage']>) => number,
): number {
  const withUsage = attempts.filter((a) => a.usage);
  if (withUsage.length === 0) return NaN;
  return withUsage.reduce((total, a) => total + pick(a.usage!), 0);
}

function estNeurons(attempts: AttemptRecord[]): number {
  return attempts.reduce((total, a) => total + a.estNeuronsIn + a.estNeuronsOut, 0);
}

/** Reproduces the charge `decide.ts`'s `callLlm` makes at its
 * `budget.record(...)` call: the metered figure on a successful call with
 * usage, the pre-call estimate otherwise. */
function chargedNeurons(attempts: AttemptRecord[]): number {
  return attempts.reduce((total, a) => {
    if (a.outcome === 'ok' && a.usage) return total + a.usage.neurons;
    return total + a.estNeuronsIn + a.estNeuronsOut;
  }, 0);
}

export const costGrader: Grader = {
  id: 'cost',
  grade(_c: EvalCase, o: TaskOutcome): Score[] {
    const attempts = o.attempts;
    const metered = sumUsage(attempts, (u) => u.neurons);
    const est = estNeurons(attempts);
    const estOverMetered = metered > 0 ? est / metered : NaN;
    const promptTokens = sumUsage(attempts, (u) => u.promptTokens);
    const completionTokens = sumUsage(attempts, (u) => u.completionTokens);
    const cachedTokens = sumUsage(attempts, (u) => u.cachedTokens ?? 0);

    return [
      {
        name: 'metered_neurons',
        value: metered,
        unit: 'neurons',
        ...(Number.isNaN(metered) ? { caveat: NO_USAGE_CAVEAT } : {}),
      },
      { name: 'est_neurons', value: est, unit: 'neurons' },
      {
        name: 'est_over_metered',
        value: estOverMetered,
        unit: 'ratio',
        caveat:
          'expect ~4x: the pre-call estimate reserves the full max_tokens while the metered figure bills actual completion tokens',
      },
      { name: 'charged_neurons', value: chargedNeurons(attempts), unit: 'neurons' },
      {
        name: 'prompt_tokens',
        value: promptTokens,
        unit: 'tokens',
        ...(Number.isNaN(promptTokens) ? { caveat: NO_USAGE_CAVEAT } : {}),
      },
      {
        name: 'completion_tokens',
        value: completionTokens,
        unit: 'tokens',
        ...(Number.isNaN(completionTokens) ? { caveat: NO_USAGE_CAVEAT } : {}),
      },
      {
        name: 'cached_tokens',
        value: cachedTokens,
        unit: 'tokens',
        ...(Number.isNaN(cachedTokens) ? { caveat: NO_USAGE_CAVEAT } : {}),
      },
    ];
  },
};

export const costGraders: Grader[] = [costGrader];
