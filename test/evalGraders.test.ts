/**
 * Holds the graders to the five real Workers AI captures, so the cost axis is
 * anchored to figures Cloudflare actually charged rather than to the harness's
 * own arithmetic.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateNeurons } from '../src/ai/provider';
import { costGrader } from '../eval/suites/fantasy/graders/cost';
import { conformanceGrader } from '../eval/suites/fantasy/graders/conformance';
import type { AttemptRecord, EvalCase, Score, TaskOutcome } from '../eval/core/types';
import type { DecisionKind } from '../src/types';

const FIX = path.join(import.meta.dirname, 'fixtures/workers-ai');

interface Capture {
  _captured: { neurons: number; respondingModel: string };
  request: Record<string, unknown>;
  envelope: {
    model: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      neurons: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    response: unknown;
  };
}

function load(name: string): Capture {
  return JSON.parse(readFileSync(path.join(FIX, `${name}.json`), 'utf8')) as Capture;
}

const CAPTURES: { name: string; kind: DecisionKind; expected: number }[] = [
  { name: 'json-schema-squad', kind: 'squad', expected: 21.4 },
  { name: 'json-schema-lineup', kind: 'lineup', expected: 20.6 },
  { name: 'json-schema-transfer', kind: 'transfer', expected: 10.9 },
];

function attemptFrom(cap: Capture): AttemptRecord {
  const u = cap.envelope.usage;
  return {
    attempt: 0,
    outcome: 'ok',
    rawResponse: JSON.stringify(cap.envelope.response),
    estNeuronsIn: 0,
    estNeuronsOut: 0,
    usage: {
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      neurons: u.neurons,
      cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    },
    respondingModel: cap.envelope.model,
  };
}

function outcomeFrom(kind: DecisionKind, attempts: AttemptRecord[]): TaskOutcome {
  return {
    kind,
    source: 'llm',
    reasoning: '',
    attempts,
    reference: {},
    requestedModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  };
}

const anyCase = { id: 'x', taskId: 'x', tags: {}, input: { kind: 'squad' } } as unknown as EvalCase;

function value(scores: Score[], name: string): number {
  const s = scores.find((x) => x.name === name);
  expect(s, `missing score ${name}`).toBeDefined();
  return s!.value;
}

describe('cost grader against the real captures', () => {
  for (const { name, kind, expected } of CAPTURES) {
    it(`${name} reproduces the charged Neuron figure`, () => {
      const cap = load(name);
      const scores = costGrader.grade(anyCase, outcomeFrom(kind, [attemptFrom(cap)]));
      expect(value(scores, 'metered_neurons')).toBeCloseTo(cap._captured.neurons, 5);
      expect(value(scores, 'metered_neurons')).toBeCloseTo(expected, 1);
      // A successful attempt is charged the metered figure, not the estimate.
      expect(value(scores, 'charged_neurons')).toBeCloseTo(cap._captured.neurons, 5);
    });

    it(`${name} usage.neurons is reproduced by estimateNeurons`, () => {
      const u = load(name).envelope.usage;
      const computed = estimateNeurons(u.prompt_tokens, u.completion_tokens);
      // The LlmUsage docstring in src/ai/provider.ts says this reproduces
      // usage.neurons "to the digit". Measured across all five captures it
      // agrees to 2.3-4.3 parts per million, not exactly -- the pricing
      // constants are right, the claim is very slightly overstated. Asserting
      // the measured tolerance keeps this honest and still catches a real
      // constant drift, which would move the figure by orders of magnitude.
      expect(Math.abs(computed - u.neurons) / u.neurons).toBeLessThan(1e-5);
    });
  }

  it('charges the pre-call estimate on a failed attempt, as decide.ts does', () => {
    const failed: AttemptRecord = {
      attempt: 0,
      outcome: 'provider-error',
      reason: 'workers-ai truncated the response at max_tokens (finish_reason: "length")',
      estNeuronsIn: 12,
      estNeuronsOut: 74,
    };
    const scores = costGrader.grade(anyCase, outcomeFrom('squad', [failed]));
    expect(value(scores, 'charged_neurons')).toBe(86);
    expect(value(scores, 'metered_neurons')).toBeNaN();
  });

  it('reports NaN, not zero, when nothing reported usage', () => {
    const scores = costGrader.grade(anyCase, outcomeFrom('squad', []));
    expect(value(scores, 'metered_neurons')).toBeNaN();
    expect(value(scores, 'prompt_tokens')).toBeNaN();
  });
});

describe('conformance grader against the real captures', () => {
  it('rejects the genuinely malformed lineup capture', () => {
    const cap = load('json-schema-lineup');
    const scores = conformanceGrader.grade(anyCase, outcomeFrom('lineup', [attemptFrom(cap)]));
    // The recorded answer has 11 starters with element 302 twice (issue #26).
    expect(value(scores, 'parse_ok@1')).toBe(0);
  });

  it('does not count a budget skip as a refusal', () => {
    const skipped: AttemptRecord = {
      attempt: 0,
      outcome: 'skipped-budget',
      estNeuronsIn: 0,
      estNeuronsOut: 0,
    };
    const scores = conformanceGrader.grade(anyCase, outcomeFrom('squad', [skipped]));
    expect(value(scores, 'refusal_rate')).toBeNaN();
    expect(value(scores, 'truncation_rate')).toBeNaN();
  });

  it('counts a real refusal and a real truncation from the provider strings', () => {
    const refusal: AttemptRecord = {
      attempt: 0,
      outcome: 'provider-error',
      reason: 'workers-ai refused the request: JSON Mode could not be met',
      estNeuronsIn: 1,
      estNeuronsOut: 1,
    };
    const truncated: AttemptRecord = {
      attempt: 1,
      outcome: 'provider-error',
      reason: 'workers-ai truncated the response at max_tokens (finish_reason: "length")',
      estNeuronsIn: 1,
      estNeuronsOut: 1,
    };
    const scores = conformanceGrader.grade(anyCase, outcomeFrom('squad', [refusal, truncated]));
    expect(value(scores, 'refusal_rate')).toBeCloseTo(0.5, 5);
    expect(value(scores, 'truncation_rate')).toBeCloseTo(0.5, 5);
    expect(value(scores, 'provider_error_rate')).toBeCloseTo(1, 5);
  });
});
