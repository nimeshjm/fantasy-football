/**
 * The three `EvalTask`s that drive production's LLM decisions
 * (`decideSquad`/`decideLineup`/`decideTransfer`) end to end, one per
 * decision kind.
 */
import {
  decideLineup,
  decideSquad,
  decideTransfer,
  type TransferCandidateInput,
} from '../../../src/ai/decide';
import { makeLineupBaseline, makeSquadBaseline, makeTransferBaseline } from '../../../src/baseline';
import { WorkersAiProvider } from '../../../src/ai/provider';
import {
  buildLineupPrompt,
  buildSquadPrompt,
  buildTransferPrompt,
  estimateTokens,
  type BuiltPrompt,
} from '../../../src/ai/prompts';
import { estimateWorstCaseNeurons } from '../../core/budget';
import { RecordingAuditSink } from '../../core/sink';
import {
  asAi,
  type EvalCase,
  type EvalTask,
  type LineupCaseInput,
  type SquadCaseInput,
  type TransferCaseInput,
} from '../../core/types';
import { adversarialLineupCases } from './adversarial';
import { fantasyCases } from './dataset';

function promptTokenCount(p: BuiltPrompt): number {
  return estimateTokens(p.system) + estimateTokens(p.user);
}

function squadPrompt(c: EvalCase<SquadCaseInput>): BuiltPrompt {
  return buildSquadPrompt(c.input.shortlist);
}

function lineupPrompt(c: EvalCase<LineupCaseInput>): BuiltPrompt {
  return buildLineupPrompt(c.input.owned);
}

function transferPrompt(c: EvalCase<TransferCaseInput>): BuiltPrompt {
  return buildTransferPrompt(c.input.squad, c.input.candidates, c.input.bankTenths);
}

export const squadTask: EvalTask<SquadCaseInput> = {
  id: 'fantasy/squad',
  kind: 'squad',
  cases: () => fantasyCases().squad,
  prompt: squadPrompt,
  worstCaseNeurons: (c) =>
    estimateWorstCaseNeurons([{ kind: 'squad', promptTokens: promptTokenCount(squadPrompt(c)) }]),
  attemptCeilingNeurons: (c) =>
    estimateWorstCaseNeurons(
      [{ kind: 'squad', promptTokens: promptTokenCount(squadPrompt(c)) }],
      1,
    ),
  async run(c, ai, ctx) {
    const { input } = c;
    const provider = new WorkersAiProvider(asAi(ai), ctx.model);
    const audit = new RecordingAuditSink();
    const baseline = makeSquadBaseline(input.elements, input.projections, input.optimalPicks);
    const decision = await decideSquad({
      shortlist: input.shortlist,
      elements: input.elements,
      provider,
      budget: ctx.budget,
      baseline,
      audit,
      squadMargin: ctx.squadMargin,
    });
    return {
      kind: decision.kind,
      source: decision.source,
      picks: decision.picks,
      reasoning: decision.reasoning,
      overrideReason: decision.overrideReason,
      attempts: audit.attempts(),
      gate: audit.gate(),
      reference: { picks: input.optimalPicks, score: baseline.scoreSquad(input.optimalPicks) },
      requestedModel: ctx.model,
    };
  },
};

export const lineupTask: EvalTask<LineupCaseInput> = {
  id: 'fantasy/lineup',
  kind: 'lineup',
  cases: () => [...fantasyCases().lineup, ...adversarialLineupCases()],
  prompt: lineupPrompt,
  worstCaseNeurons: (c) =>
    estimateWorstCaseNeurons([{ kind: 'lineup', promptTokens: promptTokenCount(lineupPrompt(c)) }]),
  attemptCeilingNeurons: (c) =>
    estimateWorstCaseNeurons(
      [{ kind: 'lineup', promptTokens: promptTokenCount(lineupPrompt(c)) }],
      1,
    ),
  async run(c, ai, ctx) {
    const { input } = c;
    const provider = new WorkersAiProvider(asAi(ai), ctx.model);
    const audit = new RecordingAuditSink();
    const baseline = makeLineupBaseline(input.elements, input.projections, input.ownedPicks);
    const decision = await decideLineup({
      owned: input.owned,
      elements: input.elements,
      provider,
      budget: ctx.budget,
      baseline,
      audit,
      lineupAbsFloor: ctx.lineupAbsFloor,
    });
    const optimalLineup = baseline.optimalLineup();
    return {
      kind: decision.kind,
      source: decision.source,
      picks: decision.picks,
      reasoning: decision.reasoning,
      overrideReason: decision.overrideReason,
      attempts: audit.attempts(),
      gate: audit.gate(),
      reference: { picks: optimalLineup, score: baseline.scoreLineup(optimalLineup) },
      requestedModel: ctx.model,
    };
  },
};

export const transferTask: EvalTask<TransferCaseInput> = {
  id: 'fantasy/transfer',
  kind: 'transfer',
  cases: () => fantasyCases().transfer,
  prompt: transferPrompt,
  worstCaseNeurons: (c) =>
    estimateWorstCaseNeurons([
      { kind: 'transfer', promptTokens: promptTokenCount(transferPrompt(c)) },
    ]),
  attemptCeilingNeurons: (c) =>
    estimateWorstCaseNeurons(
      [{ kind: 'transfer', promptTokens: promptTokenCount(transferPrompt(c)) }],
      1,
    ),
  async run(c, ai, ctx) {
    const { input } = c;
    const provider = new WorkersAiProvider(asAi(ai), ctx.model);
    const audit = new RecordingAuditSink();
    const baseline = makeTransferBaseline(
      input.elements,
      input.projections,
      input.ownedPicks,
      input.fallbackMove,
    );
    // Fixtures carry no `selling_price` for owned players; `now_cost` is the
    // best available stand-in for both prices.
    const candidates: TransferCandidateInput[] = input.candidates.map((entry) => ({
      elementIn: entry.elementIn,
      elementOut: entry.elementOut,
      gain: entry.gain,
      move: {
        element_in: entry.elementIn.element.id,
        element_out: entry.elementOut.element.id,
        purchase_price: entry.elementIn.element.now_cost,
        selling_price: entry.elementOut.element.now_cost,
      },
    }));
    const decision = await decideTransfer({
      squad: input.squad,
      candidates,
      bankTenths: input.bankTenths,
      provider,
      budget: ctx.budget,
      baseline,
      audit,
    });
    return {
      kind: decision.kind,
      source: decision.source,
      transfers: decision.transfers,
      reasoning: decision.reasoning,
      overrideReason: decision.overrideReason,
      attempts: audit.attempts(),
      gate: audit.gate(),
      reference: { transfers: input.fallbackMove },
      requestedModel: ctx.model,
    };
  },
};

export function fantasyTasks(): EvalTask[] {
  return [squadTask, lineupTask, transferTask];
}
