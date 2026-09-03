/**
 * Orchestrates one LLM decision end to end:
 *
 *   check pre-call invariant -> check Neuron budget -> call -> parse ->
 *   validate -> retry up to 2 times (naming the specific violation in the
 *   retry prompt) -> minimal repair (squad only) -> gate -> return a
 *   `Decision` with the honest `source`.
 *
 * Any hard failure (schema refusal, budget exhausted, still-illegal after
 * repair) returns the deterministic fallback with
 * `source: 'deterministic-fallback'`. This function never throws past its
 * own boundary - a missed deadline is worse than a mediocre team.
 *
 * The deterministic optimizer/projection layer does not exist yet (a
 * concurrent workstream owns `src/model` and `src/optimizer`), so this file
 * depends only on the narrow `DeterministicBaseline` interface below,
 * injected by the caller, plus a `NeuronBudget` accessor - never on
 * `src/db` or `src/optimizer` directly.
 */

import {
  Position,
  RULES,
  type Decision,
  type DecisionSource,
  type Element,
  type Pick,
  type TransferMove,
  type DecisionKind,
} from '../types';
import { CONTEXT_WINDOW_TOKENS, estimateNeurons, type LlmProvider } from './provider';
import {
  assertPromptFits,
  buildLineupPrompt,
  buildSquadPrompt,
  buildTransferPrompt,
  estimateTokens,
  type BuiltPrompt,
  type ShortlistEntry,
  type TransferCandidateEntry,
} from './prompts';
import {
  LINEUP_SCHEMA,
  SQUAD_SCHEMA,
  TRANSFER_SCHEMA,
  parseLineupResult,
  parseSquadResult,
  parseTransferResult,
} from './schemas';
import {
  gateDecision,
  repairSquad,
  shortlistContainsLegalSquad,
  validateLineup,
  validateSquad,
  validateTransfer,
  type OwnedPlayer,
  type TransferCandidate,
} from './validate';

/** Neurons remaining in / spent from today's cap. Injected so this module
 * never touches `src/db` directly. */
/**
 * Audit sink for LLM attempts.
 *
 * Every attempt is recorded, successful or not. This exists because the first
 * live run produced two `deterministic-fallback` decisions with an empty
 * `ai_calls` table, and there was no way to tell from the data whether the
 * model had been called and refused, or never called at all — `logAiCall` had
 * been defined and wired in the workflow but never actually invoked from here.
 * An audit trail that only records successes cannot answer the one question
 * you ask it.
 */
export interface LlmAuditSink {
  record(entry: {
    decisionKind: DecisionKind;
    attempt: number;
    outcome: 'ok' | 'skipped-prompt-too-large' | 'skipped-budget' | 'provider-error';
    reason?: string;
    estNeuronsIn: number;
    estNeuronsOut: number;
    rawResponse?: string;
  }): void | Promise<void>;

  /**
   * Records the sanity gate's verdict on the attempt `record` last reported
   * for this `decisionKind`.
   *
   * Separate from `record` because of the ordering: `record` fires when the
   * provider answers, and the gate can only run once that answer has parsed
   * and validated. The gate is the component that decides whether the
   * model's answer ships or is replaced by the deterministic optimum, and
   * until this existed it could fire with no record that it had, or why --
   * making "the gate is miscalibrated" and "the model is bad" the same
   * observation. Both scores are carried on ACCEPT as well as override: an
   * accept is only judgeable next to the margin it did not need.
   *
   * Optional so a caller that only wants call-level auditing (and every
   * existing test fake) stays valid.
   */
  recordGate?(entry: {
    decisionKind: DecisionKind;
    /** Which attempt's answer the gate judged -- matches the `attempt` the
     * corresponding `record` call carried. */
    attempt: number;
    accept: boolean;
    /** The `DecisionSource` the gate settled on. */
    source: DecisionSource;
    overrideReason?: string;
    /** Deterministic-model score of the LLM's own answer, and of the
     * deterministic optimum. Both undefined for the transfer gate, which is
     * a legality check with no score on either side. */
    llmScore?: number;
    deterministicScore?: number;
  }): void | Promise<void>;
}

export interface NeuronBudget {
  /** Neurons remaining in today's cap, checked before spending any. */
  remaining(): number | Promise<number>;
  /** Record actual (or estimated) Neuron spend for a completed call. */
  record(neurons: number): void | Promise<void>;
}

/** Minimal environment shape for the gate's two tunables. wrangler `vars`
 * always arrive as strings (see `wrangler.jsonc`: `SQUAD_MARGIN: "0.10"`,
 * `LINEUP_ABS_FLOOR: "8"`), so both are typed `string` here rather than
 * `number` - same convention as `FantasyEnv` in src/api/client.ts. */
export interface GateEnv {
  SQUAD_MARGIN?: string;
  LINEUP_ABS_FLOOR?: string;
}

const DEFAULT_SQUAD_MARGIN = 0.1;
const DEFAULT_LINEUP_ABS_FLOOR = 8;

/** Parses `env.SQUAD_MARGIN` / `env.LINEUP_ABS_FLOOR` into the numbers
 * `decideSquad` / `decideLineup` expect, falling back to the documented
 * defaults (0.10 / 8) when the var is missing, empty, or not a positive
 * finite number. (`Number('')` is `0`, which is finite but would silently
 * set a 0% margin - the gate would then override every LLM squad that isn't
 * exactly at the optimum, the exact failure mode this design exists to
 * avoid - so `0` and negative values are rejected too, not just NaN.) */
export function parseGateOptionsFromEnv(env: GateEnv): {
  squadMargin: number;
  lineupAbsFloor: number;
} {
  const squadMargin = Number(env.SQUAD_MARGIN);
  const lineupAbsFloor = Number(env.LINEUP_ABS_FLOOR);
  return {
    squadMargin:
      Number.isFinite(squadMargin) && squadMargin > 0 ? squadMargin : DEFAULT_SQUAD_MARGIN,
    lineupAbsFloor:
      Number.isFinite(lineupAbsFloor) && lineupAbsFloor > 0
        ? lineupAbsFloor
        : DEFAULT_LINEUP_ABS_FLOOR,
  };
}

/**
 * The subset of the deterministic optimizer/projection layer this module
 * needs. `src/optimizer/{squad,lineup,transfers}.ts` and
 * `src/model/projection.ts` implement this shape once they exist; decide.ts
 * depends only on the interface, per this workstream's dependency-injection
 * boundary.
 */
export interface DeterministicBaseline {
  /** Deterministic-model xPts total for an arbitrary legal set of 15 picks. */
  scoreSquad(picks: Pick[]): number;
  /** Deterministic-model xPts total for an arbitrary legal lineup (11
   * starters + captain's points doubled). */
  scoreLineup(picks: Pick[]): number;
  /** The provably-optimal squad achievable from the shortlist (squad gate). */
  optimalSquad(): Pick[];
  /** The exact argmax lineup from the owned 15 (lineup gate). */
  optimalLineup(): Pick[];
  /** What to ship if the LLM path fails outright. */
  fallbackSquad(): Pick[];
  fallbackLineup(): Pick[];
  /** Empty array means "make no transfer". */
  fallbackTransfer(): TransferMove[];
}

const MAX_RETRIES = 2;

const DEFAULT_MAX_ANSWER_TOKENS = {
  squad: 600,
  lineup: 500,
  transfer: 150,
} as const;

type LlmSource = Extract<DecisionSource, 'llm' | 'llm-repaired'>;

async function callLlm(
  provider: LlmProvider,
  budget: NeuronBudget,
  prompt: BuiltPrompt,
  jsonSchema: Record<string, unknown>,
  maxTokens: number,
  audit?: LlmAuditSink,
  decisionKind: DecisionKind = 'squad',
  attempt = 0,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const inputTokens = estimateTokens(prompt.system) + estimateTokens(prompt.user);

  // Audit failures too, and never let a failing audit sink break a decision.
  const note = async (
    outcome: 'ok' | 'skipped-prompt-too-large' | 'skipped-budget' | 'provider-error',
    reason?: string,
    rawResponse?: string,
  ): Promise<void> => {
    if (!audit) return;
    try {
      await audit.record({
        decisionKind,
        attempt,
        outcome,
        reason,
        estNeuronsIn: estimateNeurons(inputTokens, 0),
        estNeuronsOut: estimateNeurons(0, maxTokens),
        rawResponse,
      });
    } catch {
      /* observability must never take down the decision path */
    }
  };

  try {
    assertPromptFits(`${prompt.system}\n${prompt.user}`, CONTEXT_WINDOW_TOKENS - maxTokens);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await note('skipped-prompt-too-large', reason);
    return { ok: false, reason };
  }

  const neuronsNeeded = estimateNeurons(inputTokens, maxTokens);
  const remaining = await budget.remaining();
  if (remaining < neuronsNeeded) {
    const reason = `neuron budget exhausted: ${remaining.toFixed(0)} remaining, ~${neuronsNeeded.toFixed(0)} needed`;
    await note('skipped-budget', reason);
    return { ok: false, reason };
  }

  const result = await provider.complete({
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    jsonSchema,
    maxTokens,
  });

  // Workers AI does not report per-call token usage in its response, so the
  // requested max_tokens is the best available spend estimate. Recorded
  // whether or not the call succeeded, since the Neurons were spent either
  // way (a refusal still runs the model).
  await budget.record(neuronsNeeded);

  if (!result.ok) {
    await note('provider-error', result.error);
    return { ok: false, reason: result.error };
  }
  await note('ok', undefined, result.text);
  return { ok: true, text: result.text };
}

/**
 * Records one gate verdict through `audit.recordGate`, if the sink declares
 * it. Shared by all three gate sites (squad, lineup, transfer) rather than
 * duplicated per site, and wrapped the same way `callLlm`'s `note` helper
 * wraps `audit.record` above: a throwing audit sink must never take down
 * the decision path it is merely observing.
 */
async function noteGate(
  audit: LlmAuditSink | undefined,
  entry: Parameters<NonNullable<LlmAuditSink['recordGate']>>[0],
): Promise<void> {
  if (!audit?.recordGate) return;
  try {
    await audit.recordGate(entry);
  } catch {
    /* observability must never take down the decision path */
  }
}

function withViolationNote(base: BuiltPrompt, violationNote: string): BuiltPrompt {
  if (!violationNote) return base;
  return {
    system: base.system,
    user: `${base.user}\n\nYour previous answer was invalid: ${violationNote}\nCorrect this and answer again.`,
  };
}

function formatErrors(errors: { rule: string; detail: string }[]): string {
  return errors.map((e) => `${e.rule} - ${e.detail}`).join('; ');
}

// ---------------------------------------------------------------------------
// Squad
// ---------------------------------------------------------------------------

export interface DecideSquadInput {
  /** Optional audit sink; every LLM attempt is recorded through it. */
  audit?: LlmAuditSink;
  shortlist: ShortlistEntry[];
  elements: Element[];
  provider: LlmProvider;
  budget: NeuronBudget;
  baseline: DeterministicBaseline;
  squadMargin?: number;
  maxAnswerTokens?: number;
}

export async function decideSquad(input: DecideSquadInput): Promise<Decision> {
  const { shortlist, elements, provider, budget, baseline, audit } = input;
  const maxTokens = input.maxAnswerTokens ?? DEFAULT_MAX_ANSWER_TOKENS.squad;

  const fallback = (): Decision => ({
    kind: 'squad',
    source: 'deterministic-fallback',
    picks: baseline.fallbackSquad(),
    reasoning: 'LLM path failed; used the deterministic fallback squad.',
  });

  // Pre-call invariant. A shortlist that cannot contain a legal 15 is a
  // shortlist-construction bug, not something a retry can fix.
  if (
    !shortlistContainsLegalSquad(
      shortlist.map((s) => s.element),
      elements,
    )
  ) {
    return fallback();
  }

  const rankedIds = [...shortlist].sort((a, b) => b.xpts - a.xpts).map((s) => s.element.id);
  const basePrompt = buildSquadPrompt(shortlist);

  let violationNote = '';
  let lastPicks: Pick[] | null = null;
  let lastReason = '';
  // The attempt whose (invalid) answer `lastPicks`/`lastReason` were taken
  // from -- needed so the repair path below can tag its `recordGate` call
  // with the same `attempt` number the corresponding `record` call carried,
  // per `recordGate`'s documented contract. Not necessarily the final loop
  // iteration: a later attempt can fail before ever producing picks
  // (provider error, unparseable JSON), leaving `lastPicks` (and this) at
  // the last attempt that actually validated-with-errors. This is exactly
  // why `makeAuditSink` keys its remembered row ids by (kind, attempt)
  // rather than by kind alone -- keyed by kind, a repaired squad's verdict
  // would be stamped onto that later, unrelated failure's row.
  let lastAttempt = -1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const call = await callLlm(
      provider,
      budget,
      withViolationNote(basePrompt, violationNote),
      SQUAD_SCHEMA,
      maxTokens,
      audit,
      'squad',
      attempt,
    );
    if (!call.ok) {
      violationNote = call.reason;
      continue;
    }

    const parsed = parseSquadResult(call.text);
    if (!parsed.ok) {
      violationNote = parsed.error;
      continue;
    }

    const picks: Pick[] = parsed.value.picks.map((elementId, i) => ({
      element: elementId,
      position: i + 1,
      is_captain: false,
      is_vice_captain: false,
    }));

    const errors = validateSquad(picks, elements);
    if (errors.length === 0) {
      return await gateAndReturnSquad(
        picks,
        parsed.value.reason,
        'llm',
        elements,
        shortlist,
        baseline,
        input.squadMargin,
        attempt,
        audit,
      );
    }

    lastPicks = picks;
    lastReason = parsed.value.reason;
    lastAttempt = attempt;
    violationNote = formatErrors(errors);
  }

  if (lastPicks) {
    const repair = repairSquad(lastPicks, rankedIds, elements);
    if (repair.repaired) {
      return await gateAndReturnSquad(
        repair.picks,
        lastReason,
        'llm-repaired',
        elements,
        shortlist,
        baseline,
        input.squadMargin,
        lastAttempt,
        audit,
      );
    }
  }

  return fallback();
}

/**
 * A squad decision only chooses WHICH 15 players, never who starts - that is
 * `decideLineup`'s job, run separately against the owned 15. But `Pick`
 * carries a `position` slot (1-11 start, 12-15 bench) that is meaningful
 * elsewhere in the codebase, and the LLM's answer arrives as an arbitrary
 * list order with no formation intent behind it at all. Rather than ship
 * whatever order the model happened to list ids in - which is very likely an
 * illegal "formation" (e.g. a bench GK, zero starting FWDs) if ever read
 * before a lineup decision runs - every squad decision gets a fixed,
 * always-legal placeholder split: 1 GK, 4 DEF, 4 MID, 2 FWD start (11), the
 * remaining 1 GK, 1 DEF, 1 MID, 1 FWD are bench (4). This is guaranteed
 * inside RULES.play's min/max for any legal 2/5/5/3 squad composition, and
 * favours each position's higher-xpts players for the placeholder starting
 * slots. It is explicitly a PLACEHOLDER: callers must still run
 * `decideLineup` before ever submitting a lineup - this only guarantees a
 * freshly created squad's `Pick.position` values are never nonsensical if
 * read in between.
 */
const SQUAD_PLACEHOLDER_STARTERS: Record<Position, number> = {
  [Position.GK]: 1,
  [Position.DEF]: 4,
  [Position.MID]: 4,
  [Position.FWD]: 2,
};

function assignSquadFormation(
  elementIds: number[],
  elements: Element[],
  shortlist: ShortlistEntry[],
): Pick[] {
  const byId = new Map(elements.map((e) => [e.id, e] as const));
  const xptsById = new Map(shortlist.map((s) => [s.element.id, s.xpts] as const));

  const byPosition = new Map<Position, number[]>();
  for (const id of elementIds) {
    const el = byId.get(id);
    if (!el) continue; // unknown ids are already caught by validateSquad upstream
    const list = byPosition.get(el.element_type) ?? [];
    list.push(id);
    byPosition.set(el.element_type, list);
  }
  for (const list of byPosition.values()) {
    list.sort((a, b) => (xptsById.get(b) ?? 0) - (xptsById.get(a) ?? 0));
  }

  const starters: number[] = [];
  const bench: number[] = [];
  for (const position of [Position.GK, Position.DEF, Position.MID, Position.FWD] as const) {
    const list = byPosition.get(position) ?? [];
    const starterCount = SQUAD_PLACEHOLDER_STARTERS[position];
    starters.push(...list.slice(0, starterCount));
    bench.push(...list.slice(starterCount));
  }

  return [...starters, ...bench].map((element, i) => ({
    element,
    position: i + 1,
    is_captain: false,
    is_vice_captain: false,
  }));
}

async function gateAndReturnSquad(
  picks: Pick[],
  reason: string,
  source: LlmSource,
  elements: Element[],
  shortlist: ShortlistEntry[],
  baseline: DeterministicBaseline,
  squadMargin: number | undefined,
  attempt: number,
  audit: LlmAuditSink | undefined,
): Promise<Decision> {
  const formedPicks = assignSquadFormation(
    picks.map((p) => p.element),
    elements,
    shortlist,
  );
  const llmScore = baseline.scoreSquad(formedPicks);
  const optimalPicks = baseline.optimalSquad();
  const optimalScore = baseline.scoreSquad(optimalPicks);
  const gate = gateDecision('squad', { score: llmScore }, { score: optimalScore }, { squadMargin });
  await noteGate(audit, {
    decisionKind: 'squad',
    attempt,
    accept: gate.accept,
    source: gate.source,
    overrideReason: gate.overrideReason,
    llmScore,
    deterministicScore: optimalScore,
  });
  if (!gate.accept) {
    return {
      kind: 'squad',
      source: gate.source,
      picks: optimalPicks,
      reasoning: reason,
      overrideReason: gate.overrideReason,
    };
  }
  return { kind: 'squad', source, picks: formedPicks, reasoning: reason };
}

// ---------------------------------------------------------------------------
// Lineup
// ---------------------------------------------------------------------------

export interface DecideLineupInput {
  /** Optional audit sink; every LLM attempt is recorded through it. */
  audit?: LlmAuditSink;
  owned: ShortlistEntry[];
  elements: Element[];
  provider: LlmProvider;
  budget: NeuronBudget;
  baseline: DeterministicBaseline;
  lineupAbsFloor?: number;
  maxAnswerTokens?: number;
}

function toOwnedPlayers(owned: ShortlistEntry[]): OwnedPlayer[] {
  return owned.map((o) => ({ element: o.element.id, position: o.element.element_type }));
}

function hardLineupViolations(picks: Pick[], elements: Element[]): string[] {
  const byId = new Map(elements.map((e) => [e.id, e] as const));
  const violations: string[] = [];
  for (const pick of picks) {
    if (pick.position > RULES.squadPlay) continue; // only starters carry a hard signal
    const el = byId.get(pick.element);
    if (el && el.status !== 'a') {
      violations.push(`starter ${pick.element} (${el.web_name}) status is "${el.status}"`);
    }
  }
  return violations;
}

export async function decideLineup(input: DecideLineupInput): Promise<Decision> {
  const { owned, elements, provider, budget, baseline, audit } = input;
  const maxTokens = input.maxAnswerTokens ?? DEFAULT_MAX_ANSWER_TOKENS.lineup;
  const ownedPlayers = toOwnedPlayers(owned);

  const fallback = (): Decision => ({
    kind: 'lineup',
    source: 'deterministic-fallback',
    picks: baseline.fallbackLineup(),
    reasoning: 'LLM path failed; used the deterministic fallback lineup.',
  });

  const basePrompt = buildLineupPrompt(owned);
  let violationNote = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const call = await callLlm(
      provider,
      budget,
      withViolationNote(basePrompt, violationNote),
      LINEUP_SCHEMA,
      maxTokens,
      audit,
      'lineup',
      attempt,
    );
    if (!call.ok) {
      violationNote = call.reason;
      continue;
    }

    const parsed = parseLineupResult(call.text);
    if (!parsed.ok) {
      violationNote = parsed.error;
      continue;
    }

    const picks: Pick[] = [
      ...parsed.value.starters.map((elementId, i) => ({
        element: elementId,
        position: i + 1,
        is_captain: elementId === parsed.value.captain,
        is_vice_captain: elementId === parsed.value.vice_captain,
      })),
      ...parsed.value.bench.map((elementId, i) => ({
        element: elementId,
        position: RULES.squadPlay + 1 + i,
        is_captain: elementId === parsed.value.captain,
        is_vice_captain: elementId === parsed.value.vice_captain,
      })),
    ];

    const errors = validateLineup(picks, ownedPlayers);
    if (errors.length === 0) {
      return await gateAndReturnLineup(
        picks,
        parsed.value.reason,
        'llm',
        elements,
        baseline,
        input.lineupAbsFloor,
        attempt,
        audit,
      );
    }

    violationNote = formatErrors(errors);
  }

  // No repair strategy is defined for lineups (unlike squads): the owned 15
  // is fixed and small, so a still-illegal answer after two retries goes
  // straight to the deterministic fallback.
  return fallback();
}

async function gateAndReturnLineup(
  picks: Pick[],
  reason: string,
  source: LlmSource,
  elements: Element[],
  baseline: DeterministicBaseline,
  lineupAbsFloor: number | undefined,
  attempt: number,
  audit: LlmAuditSink | undefined,
): Promise<Decision> {
  const llmScore = baseline.scoreLineup(picks);
  const optimalPicks = baseline.optimalLineup();
  const optimalScore = baseline.scoreLineup(optimalPicks);
  const hardViolations = hardLineupViolations(picks, elements);
  const gate = gateDecision(
    'lineup',
    { score: llmScore, hardViolations },
    { score: optimalScore },
    { lineupAbsFloor },
  );
  await noteGate(audit, {
    decisionKind: 'lineup',
    attempt,
    accept: gate.accept,
    source: gate.source,
    overrideReason: gate.overrideReason,
    llmScore,
    deterministicScore: optimalScore,
  });
  if (!gate.accept) {
    return {
      kind: 'lineup',
      source: gate.source,
      picks: optimalPicks,
      reasoning: reason,
      overrideReason: gate.overrideReason,
    };
  }
  return { kind: 'lineup', source, picks, reasoning: reason };
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

/** One candidate transfer with everything decide.ts needs: display data for
 * the prompt, the full `TransferMove` (with prices) for validation, and the
 * deterministic projected gain. */
export interface TransferCandidateInput {
  elementIn: ShortlistEntry;
  elementOut: ShortlistEntry;
  move: TransferMove;
  gain: number;
}

export interface DecideTransferInput {
  /** Optional audit sink; every LLM attempt is recorded through it. */
  audit?: LlmAuditSink;
  squad: ShortlistEntry[];
  candidates: TransferCandidateInput[];
  bankTenths: number;
  provider: LlmProvider;
  budget: NeuronBudget;
  baseline: DeterministicBaseline;
  maxAnswerTokens?: number;
}

export async function decideTransfer(input: DecideTransferInput): Promise<Decision> {
  const { squad, candidates, bankTenths, provider, budget, baseline, audit } = input;
  const maxTokens = input.maxAnswerTokens ?? DEFAULT_MAX_ANSWER_TOKENS.transfer;

  const fallback = (reasoning: string): Decision => ({
    kind: 'transfer',
    source: 'deterministic-fallback',
    transfers: baseline.fallbackTransfer(),
    reasoning,
  });

  if (candidates.length === 0) {
    return fallback('No candidate transfers were offered.');
  }

  const promptCandidates: TransferCandidateEntry[] = candidates.map((c) => ({
    elementIn: c.elementIn,
    elementOut: c.elementOut,
    gain: c.gain,
  }));
  const validateCandidates: TransferCandidate[] = candidates.map((c) => ({
    move: c.move,
    gain: c.gain,
  }));
  const basePrompt = buildTransferPrompt(squad, promptCandidates, bankTenths);

  let violationNote = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const call = await callLlm(
      provider,
      budget,
      withViolationNote(basePrompt, violationNote),
      TRANSFER_SCHEMA,
      maxTokens,
      audit,
      'transfer',
      attempt,
    );
    if (!call.ok) {
      violationNote = call.reason;
      continue;
    }

    const parsed = parseTransferResult(call.text);
    if (!parsed.ok) {
      violationNote = parsed.error;
      continue;
    }

    if (parsed.value.element_in === 0 && parsed.value.element_out === 0) {
      // Electing not to transfer is always legal - no gate needed.
      return { kind: 'transfer', source: 'llm', transfers: [], reasoning: parsed.value.reason };
    }

    const match = candidates.find(
      (c) =>
        c.move.element_in === parsed.value.element_in &&
        c.move.element_out === parsed.value.element_out,
    );
    const move: TransferMove = match?.move ?? {
      element_in: parsed.value.element_in,
      element_out: parsed.value.element_out,
      purchase_price: 0,
      selling_price: 0,
    };

    const errors = validateTransfer(move, validateCandidates);
    const gate = gateDecision('transfer', { transferValid: errors.length === 0 }, {}, {});
    // Unlike the squad/lineup gates (each recorded exactly once, at the
    // attempt whose answer they judged and returned), the transfer gate is
    // a per-attempt LEGALITY retry signal, not a terminal override: a
    // rejection here `continue`s the loop rather than returning a
    // `deterministic-gate` decision, and an exhausted loop falls through to
    // `source: 'deterministic-fallback'` below -- 'deterministic-gate' never
    // appears as a transfer decision's own source. So every attempt's
    // verdict is recorded here, inside the loop, rather than once after it
    // -- otherwise only the LAST attempt's rejection would ever reach the
    // audit trail, silently dropping every earlier one. `llmScore`/
    // `deterministicScore` are omitted: the transfer gate is a legality
    // check (is this move an offered candidate with positive gain?), not a
    // score comparison, so neither side has a score to record.
    await noteGate(audit, {
      decisionKind: 'transfer',
      attempt,
      accept: gate.accept,
      source: gate.source,
      overrideReason: gate.overrideReason,
    });
    if (gate.accept) {
      return { kind: 'transfer', source: 'llm', transfers: [move], reasoning: parsed.value.reason };
    }

    violationNote = errors.length > 0 ? formatErrors(errors) : (gate.overrideReason ?? 'rejected');
  }

  return fallback('LLM path failed; used the deterministic fallback (possibly no transfer).');
}
