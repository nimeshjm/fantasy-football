/**
 * Re-derives schema and legality verdicts from `AttemptRecord.rawResponse`
 * rather than trusting any flag on `TaskOutcome`: `LlmAuditSink.record` fires
 * before `parse*Result`/`validate*` run in decide.ts, and neither reports
 * back through it, so `providerOk` only ever says "the provider returned
 * text" (see eval/core/types.ts's `TrialRecord.providerOk`).
 */
import { RULES, type DecisionKind, type Pick, type TransferMove } from '../../../../src/types';
import {
  parseLineupResult,
  parseSquadResult,
  parseTransferResult,
  type ParseResult,
} from '../../../../src/ai/schemas';
import {
  validateLineup,
  validateSquad,
  validateTransfer,
  type OwnedPlayer,
  type TransferCandidate,
} from '../../../../src/ai/validate';
import type { AttemptRecord, EvalCase, Grader, Score, TaskOutcome } from '../../../core/types';

function parseByKind(kind: DecisionKind, text: string): ParseResult<unknown> {
  switch (kind) {
    case 'squad':
      return parseSquadResult(text);
    case 'lineup':
      return parseLineupResult(text);
    case 'transfer':
      return parseTransferResult(text);
  }
}

function attemptReachedProvider(a: AttemptRecord): boolean {
  return a.outcome !== 'skipped-budget' && a.outcome !== 'skipped-prompt-too-large';
}

export const conformanceGrader: Grader = {
  id: 'conformance',
  grade(_c: EvalCase, o: TaskOutcome): Score[] {
    const attempts = o.attempts;
    const attempt0 = attempts[0];

    const parseOk1 =
      attempt0?.rawResponse !== undefined && parseByKind(o.kind, attempt0.rawResponse).ok;
    const parseOkAny = attempts.some(
      (a) => a.rawResponse !== undefined && parseByKind(o.kind, a.rawResponse).ok,
    );

    // Skips never reached the provider, so they carry no refusal/truncation/
    // provider-error signal at all - counting one as "not a refusal" would
    // misreport a model that was simply never asked.
    const reached = attempts.filter(attemptReachedProvider);
    const rate = (pred: (a: AttemptRecord) => boolean): number =>
      reached.length === 0 ? NaN : reached.filter(pred).length / reached.length;

    return [
      { name: 'parse_ok@1', value: parseOk1 ? 1 : 0, unit: 'ratio' },
      { name: 'parse_ok@any', value: parseOkAny ? 1 : 0, unit: 'ratio' },
      { name: 'attempts_used', value: attempts.length, unit: 'count' },
      {
        name: 'refusal_rate',
        value: rate((a) => (a.reason ?? '').includes('refused the request')),
        unit: 'ratio',
      },
      {
        name: 'truncation_rate',
        value: rate((a) => (a.reason ?? '').includes('truncated the response')),
        unit: 'ratio',
      },
      {
        name: 'provider_error_rate',
        value: rate((a) => a.outcome === 'provider-error'),
        unit: 'ratio',
      },
    ];
  },
};

interface LegalityJudgement {
  parsed: boolean;
  errors: { rule: string; detail: string }[];
}

function judgeLegality(c: EvalCase, attempt0: AttemptRecord | undefined): LegalityJudgement {
  if (attempt0?.rawResponse === undefined) return { parsed: false, errors: [] };
  const input = c.input;
  const text = attempt0.rawResponse;

  switch (input.kind) {
    case 'squad': {
      const parsed = parseSquadResult(text);
      if (!parsed.ok) return { parsed: false, errors: [] };
      const picks: Pick[] = parsed.value.picks.map((element, i) => ({
        element,
        position: i + 1,
        is_captain: false,
        is_vice_captain: false,
      }));
      return { parsed: true, errors: validateSquad(picks, input.elements) };
    }
    case 'lineup': {
      const parsed = parseLineupResult(text);
      if (!parsed.ok) return { parsed: false, errors: [] };
      const { starters, bench, captain, vice_captain } = parsed.value;
      const picks: Pick[] = [
        ...starters.map((element, i) => ({
          element,
          position: i + 1,
          is_captain: element === captain,
          is_vice_captain: element === vice_captain,
        })),
        ...bench.map((element, i) => ({
          element,
          position: RULES.squadPlay + 1 + i,
          is_captain: element === captain,
          is_vice_captain: element === vice_captain,
        })),
      ];
      const owned: OwnedPlayer[] = input.owned.map((o) => ({
        element: o.element.id,
        position: o.element.element_type,
      }));
      return { parsed: true, errors: validateLineup(picks, owned) };
    }
    case 'transfer': {
      const parsed = parseTransferResult(text);
      if (!parsed.ok) return { parsed: false, errors: [] };
      // Mirrors decideTransfer: (0, 0) means "no transfer" and is always
      // legal, never run through validateTransfer's candidate check.
      if (parsed.value.element_in === 0 && parsed.value.element_out === 0) {
        return { parsed: true, errors: [] };
      }
      const candidates: TransferCandidate[] = input.candidates.map((cand) => ({
        move: {
          element_in: cand.elementIn.element.id,
          element_out: cand.elementOut.element.id,
          purchase_price: cand.elementIn.element.now_cost,
          selling_price: cand.elementOut.element.now_cost,
        },
        gain: cand.gain,
      }));
      const move: TransferMove = {
        element_in: parsed.value.element_in,
        element_out: parsed.value.element_out,
        purchase_price: 0,
        selling_price: 0,
      };
      return { parsed: true, errors: validateTransfer(move, candidates) };
    }
  }
}

export const legalityGrader: Grader = {
  id: 'legality',
  grade(c: EvalCase, o: TaskOutcome): Score[] {
    const attempt0 = o.attempts[0];
    const judgement = judgeLegality(c, attempt0);
    const legal1 = judgement.parsed && judgement.errors.length === 0;

    const scores: Score[] = [{ name: 'legal@1', value: legal1 ? 1 : 0, unit: 'ratio' }];
    if (attempt0?.rawResponse === undefined) {
      scores[0]!.caveat = `attempt 0 produced no text (outcome: ${attempt0?.outcome ?? 'none'}); not evidence of an illegal answer.`;
    }

    // Scoped to exactly `source === 'llm-repaired'`: repairSquad runs inside
    // decideSquad, so which repair strategy fired and how many iterations it
    // took is not observable from out here, and re-validating rawResponse
    // only shows the pre-repair state - not a repair histogram.
    scores.push({ name: 'repair_rate', value: o.source === 'llm-repaired' ? 1 : 0, unit: 'ratio' });

    const violationCounts = new Map<string, number>();
    for (const e of judgement.errors) {
      violationCounts.set(e.rule, (violationCounts.get(e.rule) ?? 0) + 1);
    }
    for (const rule of [...violationCounts.keys()].sort()) {
      scores.push({ name: `violation_${rule}`, value: violationCounts.get(rule)!, unit: 'count' });
    }

    return scores;
  },
};

export const conformanceGraders: Grader[] = [conformanceGrader, legalityGrader];
