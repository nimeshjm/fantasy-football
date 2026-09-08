import type { NeuronBudget } from '../../src/ai/decide';
import { estimateNeurons } from '../../src/ai/provider';
import type { DecisionKind } from '../../src/types';
import type { NeuronBudgetLike } from './types';

export class CappedBudget implements NeuronBudgetLike, NeuronBudget {
  private spentNeurons = 0;

  constructor(private readonly capNeurons: number) {}

  remaining(): number {
    return Math.max(0, this.capNeurons - this.spentNeurons);
  }

  record(neurons: number): void {
    this.spentNeurons += neurons;
  }

  spent(): number {
    return this.spentNeurons;
  }
}

export class UnlimitedBudget implements NeuronBudgetLike, NeuronBudget {
  private spentNeurons = 0;

  remaining(): number {
    return Number.POSITIVE_INFINITY;
  }

  record(neurons: number): void {
    this.spentNeurons += neurons;
  }

  spent(): number {
    return this.spentNeurons;
  }
}

// Mirrors DEFAULT_MAX_ANSWER_TOKENS in src/ai/decide.ts, which is not exported.
const MAX_ANSWER_TOKENS: Record<DecisionKind, number> = {
  squad: 600,
  lineup: 500,
  transfer: 150,
};

// MAX_RETRIES = 2 in src/ai/decide.ts, so three attempts per decision.
export const MAX_ATTEMPTS_PER_DECISION = 3;

export function maxAnswerTokensFor(kind: DecisionKind): number {
  return MAX_ANSWER_TOKENS[kind];
}

export interface PlannedDecision {
  kind: DecisionKind;
  promptTokens: number;
}

/** Most a decision can be charged. `decide.ts` charges the pre-call estimate
 * `estimateNeurons(promptTokens, maxAnswerTokens)` on every FAILED call and the
 * metered figure on success, so the ceiling is that estimate times the retry
 * count — the estimate runs ~4x the metered cost, which is why this is a
 * ceiling and not a forecast. */
export function estimateWorstCaseNeurons(
  decisions: readonly PlannedDecision[],
  attemptsPerDecision: number = MAX_ATTEMPTS_PER_DECISION,
): number {
  return decisions.reduce(
    (sum, d) =>
      sum + attemptsPerDecision * estimateNeurons(d.promptTokens, MAX_ANSWER_TOKENS[d.kind]),
    0,
  );
}
