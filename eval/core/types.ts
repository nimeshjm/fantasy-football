import type { LlmUsage } from '../../src/ai/provider';
import type { DecisionKind, DecisionSource, Element, Pick, TransferMove } from '../../src/types';
import type { ShortlistEntry, TransferCandidateEntry } from '../../src/ai/prompts';

/** The `Ai` surface `WorkersAiProvider` actually uses. Both eval modes implement
 * only this and are cast `as unknown as Ai` at the point of use, so the real
 * `WorkersAiProvider` — and therefore its envelope parsing, refusal check,
 * truncation check and usage extraction — stays under the benchmark. */
export interface AiLike {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface AiCallLog {
  model: string;
  input: Record<string, unknown>;
  envelope?: unknown;
  error?: string;
}

/** `LlmAuditSink` never sees the envelope, so `envelope.model` — the model that
 * actually answered — is observable only here. The runner correlates attempt N
 * with `calls[N]`. */
export interface AiShim extends AiLike {
  readonly mode: 'replay' | 'live';
  readonly calls: AiCallLog[];
}

export function asAi(shim: AiLike): Ai {
  return shim as unknown as Ai;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface SquadCaseInput {
  kind: 'squad';
  shortlist: ShortlistEntry[];
  elements: Element[];
}

export interface LineupCaseInput {
  kind: 'lineup';
  owned: ShortlistEntry[];
  elements: Element[];
}

export interface TransferCaseInput {
  kind: 'transfer';
  squad: ShortlistEntry[];
  candidates: TransferCandidateEntry[];
  bankTenths: number;
  elements: Element[];
}

export type CaseInput = SquadCaseInput | LineupCaseInput | TransferCaseInput;

/** Realized outcome for a case. `pointsByElement` is actual points scored in
 * the case's gameweek, keyed by element id. */
export interface CaseTruth {
  event: number;
  pointsByElement: Map<number, number>;
}

export interface EvalCase<I extends CaseInput = CaseInput> {
  id: string;
  taskId: string;
  tags: Record<string, string>;
  input: I;
  truth?: CaseTruth;
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

/** One provider round trip, as observed through `LlmAuditSink.record`. */
export interface AttemptRecord {
  attempt: number;
  outcome: 'ok' | 'skipped-prompt-too-large' | 'skipped-budget' | 'provider-error';
  reason?: string;
  rawResponse?: string;
  estNeuronsIn: number;
  estNeuronsOut: number;
  usage?: LlmUsage;
  /** `envelope.model` — the model that actually answered. JSON mode reroutes,
   * so this is routinely not the requested id and cannot be inferred. */
  respondingModel?: string;
}

export interface GateRecord {
  attempt: number;
  accept: boolean;
  source: DecisionSource;
  overrideReason?: string;
  llmScore?: number;
  deterministicScore?: number;
}

/** The deterministic optimizer's own answer for the same input. */
export interface ReferenceAnswer {
  picks?: Pick[];
  transfers?: TransferMove[];
  score?: number;
}

export interface TaskOutcome {
  kind: DecisionKind;
  source: DecisionSource;
  picks?: Pick[];
  transfers?: TransferMove[];
  reasoning: string;
  overrideReason?: string;
  attempts: AttemptRecord[];
  gate?: GateRecord;
  reference: ReferenceAnswer;
  requestedModel: string;
  error?: string;
}

export interface NeuronBudgetLike {
  remaining(): number | Promise<number>;
  record(neurons: number): void | Promise<void>;
  spent(): number;
}

export interface RunContext {
  model: string;
  budget: NeuronBudgetLike;
  squadMargin?: number;
  lineupAbsFloor?: number;
}

export interface EvalTask<I extends CaseInput = CaseInput> {
  id: string;
  kind: DecisionKind;
  cases(): EvalCase<I>[];
  /** The prompt this case will send, built without calling a model. Drives the
   * prompt-snapshot lane. */
  prompt(c: EvalCase<I>): { system: string; user: string };
  run(c: EvalCase<I>, ai: AiLike, ctx: RunContext): Promise<TaskOutcome>;
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export type ScoreUnit = 'ratio' | 'points' | 'neurons' | 'count' | 'tokens';

export interface Score {
  name: string;
  value: number;
  unit: ScoreUnit;
  /** Set when a score must not be read as a quality signal on its own — the
   * report prints it next to the number. */
  caveat?: string;
}

export interface Grader<I extends CaseInput = CaseInput> {
  id: string;
  grade(c: EvalCase<I>, o: TaskOutcome): Score[];
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One trial = one case run once. Field names deliberately mirror
 * `AiCallInput` in src/db/types.ts so eval trials and production `ai_calls`
 * rows can be compared directly. */
export interface TrialRecord {
  runId: string;
  ts: string;
  caseId: string;
  taskId: string;
  decisionKind: DecisionKind;
  repeat: number;
  mode: 'replay' | 'live';
  model: string;
  respondingModel?: string;
  source: DecisionSource;
  attemptCount: number;
  schemaValid?: boolean;
  validationOutcome?: string;
  repaired: boolean;
  gateVerdict?: 'accept' | 'override';
  gateSource?: string;
  gateOverrideReason?: string;
  llmScore?: number;
  deterministicScore?: number;
  estNeuronsIn: number;
  estNeuronsOut: number;
  meteredPromptTokens?: number;
  meteredCompletionTokens?: number;
  meteredNeurons?: number;
  cachedTokens?: number;
  scores: Score[];
  error?: string;
}

export interface Recorder {
  record(t: TrialRecord): void;
  trials(): TrialRecord[];
  flush(): void;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunSuiteOptions {
  runId: string;
  mode: 'replay' | 'live';
  model: string;
  tasks: EvalTask[];
  graders: Grader[];
  ai: AiLike;
  budget: NeuronBudgetLike;
  recorder: Recorder;
  repeats?: number;
  squadMargin?: number;
  lineupAbsFloor?: number;
}

export interface RunSuiteResult {
  runId: string;
  mode: 'replay' | 'live';
  trials: TrialRecord[];
  neuronsSpent: number;
  /** Cases that never produced a trial, with why. A budget stop is expected
   * and must not read as a model failure. */
  skipped: { caseId: string; repeat: number; reason: string }[];
}

export class BudgetExhaustedError extends Error {}
