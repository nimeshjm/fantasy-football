import { describe, expect, it } from 'vitest';

import { estimateNeurons, extractResponseTextForTest, WorkersAiProvider } from '../src/ai/provider';
import { LINEUP_SCHEMA, SQUAD_SCHEMA, TRANSFER_SCHEMA } from '../src/ai/schemas';
import { StubAi } from './stubs/workersAi';

import jsonSchemaSquad from './fixtures/workers-ai/json-schema-squad.json';
import jsonSchemaLineup from './fixtures/workers-ai/json-schema-lineup.json';
import jsonSchemaTransfer from './fixtures/workers-ai/json-schema-transfer.json';
import plainTextJsonContent from './fixtures/workers-ai/plain-text-json-content.json';
import plainTextProse from './fixtures/workers-ai/plain-text-prose.json';

/** Every recorded envelope, named for `it.each`/`describe.each`-style
 * iteration below. All five are real, captured Workers AI responses (see
 * test/fixtures/workers-ai/README.md) - none are hand-written.
 *
 * `schema` is the request schema THAT fixture was actually captured against
 * (`plain-text-json-content` had no `response_format` at all, so it is given
 * SQUAD_SCHEMA here purely as a schema for `WorkersAiProvider.complete()`'s
 * request shape to carry - `StubAi` never inspects it, only `complete()`'s
 * own request-building does, and that is what these tests check). */
const OBJECT_RESPONSE_FIXTURES = [
  { name: 'json-schema-squad', fixture: jsonSchemaSquad, schema: SQUAD_SCHEMA },
  { name: 'json-schema-lineup', fixture: jsonSchemaLineup, schema: LINEUP_SCHEMA },
  { name: 'json-schema-transfer', fixture: jsonSchemaTransfer, schema: TRANSFER_SCHEMA },
  { name: 'plain-text-json-content', fixture: plainTextJsonContent, schema: SQUAD_SCHEMA },
];

const ALL_FIXTURES = [
  ...OBJECT_RESPONSE_FIXTURES,
  { name: 'plain-text-prose', fixture: plainTextProse },
];

describe('extractResponseText', () => {
  it('accepts a string response (plain text mode)', () => {
    expect(extractResponseTextForTest({ response: '{"picks":[1,2]}' })).toBe('{"picks":[1,2]}');
  });

  it('accepts an OBJECT response, which is what JSON mode actually returns', () => {
    // The regression that mattered: with response_format json_schema the
    // runtime parses the answer and `response` is an object, not a string.
    // Accepting only strings discarded every live call *after* spending the
    // Neurons, and silently produced deterministic-fallback decisions.
    const parsed = extractResponseTextForTest({ response: { picks: [1, 2, 3] } });
    expect(parsed).toBe('{"picks":[1,2,3]}');
    expect(JSON.parse(parsed!)).toEqual({ picks: [1, 2, 3] });
  });

  it('returns null for an empty string, a missing field, and a non-object', () => {
    expect(extractResponseTextForTest({ response: '' })).toBeNull();
    expect(extractResponseTextForTest({})).toBeNull();
    expect(extractResponseTextForTest(null)).toBeNull();
  });

  // Fixture-driven contract cases. Per issue #15, the hand-written cases
  // above encode an ASSUMPTION about the envelope shape; these encode the
  // shape as it was actually recorded from live Workers AI (see
  // test/fixtures/workers-ai/README.md for capture method). This is the
  // check that would have caught d2a959c before it shipped: a mock that
  // shares the code's misunderstanding of an external contract cannot test
  // that contract, but a recorded envelope can.
  describe('against recorded envelopes where response is an object', () => {
    for (const { name, fixture } of OBJECT_RESPONSE_FIXTURES) {
      it(`re-serialises ${name}'s envelope.response back into its JSON`, () => {
        const text = extractResponseTextForTest(fixture.envelope);
        expect(text).not.toBeNull();
        expect(JSON.parse(text!)).toEqual(fixture.envelope.response);
      });
    }
  });

  it("returns the raw string for plain-text-prose's envelope.response (the one captured case where response is a string)", () => {
    const text = extractResponseTextForTest(plainTextProse.envelope);
    expect(text).toBe(plainTextProse.envelope.response);
    expect(typeof plainTextProse.envelope.response).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Contract-snapshot: fails loudly if a future re-capture changes the shape
// `extractResponseText` depends on.
// ---------------------------------------------------------------------------

describe('recorded envelope contract (fails if Workers AI changes shape)', () => {
  // Deliberately NOT a whole-object snapshot (`toMatchSnapshot()` on the
  // envelope): that would fail on any cosmetic field Workers AI adds or
  // reorders (id, created, usage.*, etc - none of which `extractResponseText`
  // reads) and would need re-approving constantly, training reviewers to
  // rubber-stamp snapshot diffs. This asserts only the one thing the parser
  // actually depends on: `typeof envelope.response` is either 'string' or a
  // non-null 'object'. If a future re-capture of any fixture ever produces
  // `undefined`, `number`, `boolean`, or `null`, this fails here instead of
  // silently degrading production to deterministic-fallback the way d2a959c
  // did.
  for (const { name, fixture } of ALL_FIXTURES) {
    it(`${name}: envelope.response is a type extractResponseText understands`, () => {
      const response = fixture.envelope.response;
      expect(response).not.toBeNull();
      expect(['string', 'object']).toContain(typeof response);
    });
  }

  it('the envelope itself is a JSON object with a response field present (not merely undefined)', () => {
    for (const { name, fixture } of ALL_FIXTURES) {
      expect(typeof fixture.envelope, name).toBe('object');
      expect(fixture.envelope, name).not.toBeNull();
      expect(Object.prototype.hasOwnProperty.call(fixture.envelope, 'response'), name).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// WorkersAiProvider.complete() end to end, through StubAi, fed real envelopes.
// ---------------------------------------------------------------------------

describe('WorkersAiProvider.complete() against recorded envelopes', () => {
  for (const { name, fixture, schema } of OBJECT_RESPONSE_FIXTURES) {
    it(`${name}: returns {ok: true, text} that JSON.parses back to the fixture's response`, async () => {
      const ai = new StubAi(fixture.envelope);
      const provider = new WorkersAiProvider(ai as unknown as Ai);

      const result = await provider.complete({
        messages: [{ role: 'user', content: 'irrelevant - StubAi ignores it' }],
        jsonSchema: schema,
        maxTokens: 400,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(JSON.parse(result.text)).toEqual(fixture.envelope.response);
    });
  }

  it("returns {ok: true, text} for plain-text-prose's envelope, with text equal to the prose string", async () => {
    const ai = new StubAi(plainTextProse.envelope);
    const provider = new WorkersAiProvider(ai as unknown as Ai);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'irrelevant - StubAi ignores it' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.text).toBe(plainTextProse.envelope.response);
  });

  it('sends response_format.json_schema as the RAW schema object, and max_tokens explicitly', async () => {
    const ai = new StubAi(jsonSchemaSquad.envelope);
    const provider = new WorkersAiProvider(ai as unknown as Ai);

    await provider.complete({
      messages: [{ role: 'system', content: 'sys' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    });

    expect(ai.calls).toHaveLength(1);
    const input = ai.calls[0]!.input;
    // Workers AI's JSON mode takes the raw JSON Schema object under
    // `json_schema`, NOT an OpenAI-style `{ name, schema }` wrapper (see the
    // doc comment on `LlmCompleteRequest.jsonSchema` in src/ai/provider.ts,
    // and the `request.response_format.json_schema` recorded in every
    // json-schema-*.json fixture, which is the schema itself with no
    // wrapper).
    expect(input.response_format).toEqual({ type: 'json_schema', json_schema: SQUAD_SCHEMA });
    // Tie SQUAD_SCHEMA to live evidence rather than just its own constant:
    // this is the exact raw, unwrapped schema json-schema-squad.json's
    // `request.response_format.json_schema` recorded, which is the schema
    // that actually got a good answer out of Workers AI.
    expect(jsonSchemaSquad.request.response_format.json_schema).toEqual(SQUAD_SCHEMA);
    expect((input.response_format as { json_schema: unknown }).json_schema).not.toHaveProperty(
      'name',
    );
    expect((input.response_format as { json_schema: unknown }).json_schema).not.toHaveProperty(
      'schema',
    );
    // The binding defaults max_tokens to 256, truncating every answer
    // mid-JSON - it MUST be sent explicitly.
    expect(input.max_tokens).toBe(400);
  });

  it('returns {ok: false, error} and never throws when env.AI.run throws (e.g. "JSON Mode couldn\'t be met")', async () => {
    const ai = new StubAi(new Error("JSON Mode couldn't be met"));
    const provider = new WorkersAiProvider(ai as unknown as Ai);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    });

    expect(result).toEqual({ ok: false, error: "JSON Mode couldn't be met" });
  });

  it('returns {ok: false, error} when the queued response has no parsable response field', async () => {
    const ai = new StubAi({ choices: [], usage: {} }); // no `response` key at all
    const provider = new WorkersAiProvider(ai as unknown as Ai);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    });

    expect(result).toEqual({ ok: false, error: 'workers-ai returned no parsable response text' });
  });
});

// ---------------------------------------------------------------------------
// Issue #28: fall back to choices[0].message.content when `response` is
// absent, empty, or unrecognisable - and never throw doing so.
// ---------------------------------------------------------------------------

/** Loose envelope shape for the tests below, which deliberately mutate a
 * cloned fixture into shapes the real Workers AI response never took (a
 * deleted `response`, a malformed `choices`, an injected `refusal`) to
 * exercise paths the five recorded captures never touch. `structuredClone`
 * is required, not optional: the fixtures are imported once per test file
 * (`import jsonSchemaSquad from './fixtures/...json'`), so mutating
 * `fixture.envelope` directly would corrupt the single shared object other
 * `describe` blocks in this file assert against (notably the "recorded
 * envelope contract" block, which checks `response` is present on every
 * fixture). */
type Envelope = Record<string, unknown>;

function cloneEnvelope(envelope: unknown): Envelope {
  return structuredClone(envelope) as Envelope;
}

function firstChoiceOf(envelope: Envelope): Record<string, unknown> {
  return (envelope.choices as unknown[])[0] as Record<string, unknown>;
}

function messageOf(envelope: Envelope): Record<string, unknown> {
  return firstChoiceOf(envelope).message as Record<string, unknown>;
}

describe('extractResponseText falls back to choices[0].message.content (issue #28)', () => {
  it('returns the fixture answer from choices[0].message.content when response is deleted', () => {
    const envelope = cloneEnvelope(jsonSchemaSquad.envelope);
    delete envelope.response;

    const text = extractResponseTextForTest(envelope);

    expect(text).not.toBeNull();
    expect(text).toBe(messageOf(envelope).content);
    // The fallback text is the SAME answer response would have carried -
    // choices[0].message.content is the raw string, response its parsed form.
    expect(JSON.parse(text!)).toEqual(jsonSchemaSquad.envelope.response);
  });

  it('still prefers response when present, even if choices[0].message.content disagrees', () => {
    const envelope = cloneEnvelope(jsonSchemaSquad.envelope);
    // Mutate content to something response does NOT match, so a test that
    // passed only because the two happen to agree cannot pass here - this
    // proves the fallback isn't silently taking over when response is fine.
    messageOf(envelope).content = '{"picks":[999],"reason":"not the real answer"}';

    const text = extractResponseTextForTest(envelope);

    expect(JSON.parse(text!)).toEqual(jsonSchemaSquad.envelope.response);
    expect(text).not.toBe(messageOf(envelope).content);
  });

  it('falls back for plain-text-prose too, where response is a string rather than an object', () => {
    const envelope = cloneEnvelope(plainTextProse.envelope);
    delete envelope.response;

    const text = extractResponseTextForTest(envelope);

    expect(text).toBe(messageOf(envelope).content);
    expect(text).toBe(plainTextProse.envelope.response);
  });

  it('falls back when response is an empty string', () => {
    const envelope = cloneEnvelope(plainTextProse.envelope);
    envelope.response = '';

    expect(extractResponseTextForTest(envelope)).toBe(messageOf(envelope).content);
  });

  it('falls back when response is neither a string nor an object (e.g. a number)', () => {
    const envelope = cloneEnvelope(jsonSchemaSquad.envelope);
    envelope.response = 42;

    const text = extractResponseTextForTest(envelope);

    expect(text).toBe(messageOf(envelope).content);
  });

  it.each<[string, (envelope: Envelope) => void]>([
    ['choices missing entirely', (e) => delete e.choices],
    ['choices is an empty array', (e) => (e.choices = [])],
    ['choices is not an array', (e) => (e.choices = { not: 'an array' })],
    ['choices[0] has no message', (e) => (e.choices = [{ finish_reason: 'stop' }])],
    [
      'choices[0].message.content is not a string',
      (e) => (e.choices = [{ message: { content: 12345, refusal: null } }]),
    ],
  ])('returns null, never throws, when %s (and response is also absent)', (_case, mutate) => {
    const envelope = cloneEnvelope(jsonSchemaSquad.envelope);
    delete envelope.response;
    mutate(envelope);

    expect(() => extractResponseTextForTest(envelope)).not.toThrow();
    expect(extractResponseTextForTest(envelope)).toBeNull();
  });

  it('WorkersAiProvider.complete() returns {ok: true} via the fallback when response is absent', async () => {
    const envelope = cloneEnvelope(jsonSchemaSquad.envelope);
    delete envelope.response;
    const ai = new StubAi(envelope);
    const provider = new WorkersAiProvider(ai as unknown as Ai);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(JSON.parse(result.text)).toEqual(jsonSchemaSquad.envelope.response);
  });

  it('WorkersAiProvider.complete() returns {ok: false, error} rather than throwing on a malformed envelope', async () => {
    const ai = new StubAi({ choices: 'not-an-array' });
    const provider = new WorkersAiProvider(ai as unknown as Ai);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    });

    expect(result).toEqual({ ok: false, error: 'workers-ai returned no parsable response text' });
  });
});

// ---------------------------------------------------------------------------
// Issue #28: a refusal and a truncation are distinct events from an
// unparsable envelope, and from each other.
// ---------------------------------------------------------------------------

describe('WorkersAiProvider.complete() surfaces refusal and truncation distinctly (issue #28)', () => {
  it('a non-null refusal produces its own error string, not the generic "no parsable response text"', async () => {
    const envelope = cloneEnvelope(jsonSchemaSquad.envelope);
    // None of the five captures ever recorded a non-null refusal (all are
    // `refusal: null`) - this is reachable only by construction, mirroring
    // the "JSON Mode couldn't be met" refusal documented in this file's
    // header comment.
    messageOf(envelope).refusal = "JSON Mode couldn't be met";
    const ai = new StubAi(envelope);
    const provider = new WorkersAiProvider(ai as unknown as Ai);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    });

    expect(result).toEqual({
      ok: false,
      error: "workers-ai refused the request: JSON Mode couldn't be met",
      // A refusal is a real answer about the request, not proof there was
      // nothing worth logging - the fixture's message.content is carried
      // through so it still reaches ai_calls.raw_response (issue #27, task
      // 6: before this, a failed call's raw_response was written only via
      // decide.ts's `reason` fallback, which is the error string, never the
      // model's own text).
      rawResponse: messageOf(envelope).content,
    });
  });

  it('a refusal is reported even when the envelope also carries a usable response', async () => {
    // Distinguish "refusal happened to co-occur with extractable text" from
    // "the fallback silently swallowed the refusal" - complete() must check
    // refusal before ever calling extractResponseText.
    const envelope = cloneEnvelope(jsonSchemaSquad.envelope);
    messageOf(envelope).refusal = 'declined';
    expect(extractResponseTextForTest(envelope)).not.toBeNull(); // text WOULD extract

    const ai = new StubAi(envelope);
    const provider = new WorkersAiProvider(ai as unknown as Ai);
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    });

    expect(result).toEqual({
      ok: false,
      error: 'workers-ai refused the request: declined',
      rawResponse: messageOf(envelope).content,
    });
  });

  it('finish_reason "length" produces its own error string, even when text would have extracted', async () => {
    const envelope = cloneEnvelope(jsonSchemaSquad.envelope);
    // None of the five captures ever recorded anything but "stop" - this is
    // reachable only by construction, mirroring the truncation this file's
    // header comment warns `max_tokens` does not fully prevent.
    firstChoiceOf(envelope).finish_reason = 'length';
    expect(extractResponseTextForTest(envelope)).not.toBeNull(); // text WOULD extract

    const ai = new StubAi(envelope);
    const provider = new WorkersAiProvider(ai as unknown as Ai);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/truncat/i);
    expect(result.error).toContain('length');
    expect(result.error).not.toBe('workers-ai returned no parsable response text');
    // Issue #27, task 6: the partial body must not vanish from the audit
    // trail just because a truncated answer is (correctly, per #28) a
    // failed call.
    expect(result.rawResponse).toBe(messageOf(envelope).content);
  });

  it('refusal, truncation, and the generic no-parsable-text error are three distinct strings', async () => {
    const refused = cloneEnvelope(jsonSchemaSquad.envelope);
    messageOf(refused).refusal = 'nope';

    const truncated = cloneEnvelope(jsonSchemaSquad.envelope);
    firstChoiceOf(truncated).finish_reason = 'length';

    const unparsable = { choices: [] };

    const ai = new StubAi([refused, truncated, unparsable]);
    const provider = new WorkersAiProvider(ai as unknown as Ai);
    const request = {
      messages: [{ role: 'user' as const, content: 'x' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    };

    const results = [
      await provider.complete(request),
      await provider.complete(request),
      await provider.complete(request),
    ];

    const errors = results.map((r) => (r.ok ? null : r.error));
    expect(new Set(errors).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Issue #27: WorkersAiProvider.complete() surfaces envelope.usage as
// LlmUsage, so decide.ts can true up the pre-call Neuron reservation against
// what Workers AI actually metered instead of always charging the estimate.
// ---------------------------------------------------------------------------

describe('WorkersAiProvider.complete() surfaces metered usage (issue #27)', () => {
  for (const { name, fixture, schema } of OBJECT_RESPONSE_FIXTURES) {
    it(`${name}: result.usage matches envelope.usage exactly`, async () => {
      const ai = new StubAi(fixture.envelope);
      const provider = new WorkersAiProvider(ai as unknown as Ai);

      const result = await provider.complete({
        messages: [{ role: 'user', content: 'irrelevant - StubAi ignores it' }],
        jsonSchema: schema,
        maxTokens: 400,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.usage).toEqual({
        promptTokens: fixture.envelope.usage.prompt_tokens,
        completionTokens: fixture.envelope.usage.completion_tokens,
        neurons: fixture.envelope.usage.neurons,
        cachedTokens: fixture.envelope.usage.prompt_tokens_details.cached_tokens,
      });
    });
  }

  it('plain-text-prose: result.usage matches envelope.usage exactly (response is a string, not an object)', async () => {
    const ai = new StubAi(plainTextProse.envelope);
    const provider = new WorkersAiProvider(ai as unknown as Ai);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'irrelevant - StubAi ignores it' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.usage).toEqual({
      promptTokens: plainTextProse.envelope.usage.prompt_tokens,
      completionTokens: plainTextProse.envelope.usage.completion_tokens,
      neurons: plainTextProse.envelope.usage.neurons,
      cachedTokens: plainTextProse.envelope.usage.prompt_tokens_details.cached_tokens,
    });
  });

  it('estimateNeurons(usage.promptTokens, usage.completionTokens) reproduces usage.neurons on all five captures', () => {
    // The pricing constants were never wrong (issue #27) - this is the
    // check that proves it directly against the metered figure, independent
    // of anything estimateTokens ever guesses.
    for (const { fixture } of ALL_FIXTURES) {
      const { prompt_tokens, completion_tokens, neurons } = fixture.envelope.usage;
      // precision 3 (i.e. within 0.0005) rather than exact equality -
      // `neurons` in the fixtures carries float noise from Cloudflare's own
      // computation (e.g. 21.355327606201172), not a value derived from
      // this formula bit-for-bit.
      expect(estimateNeurons(prompt_tokens, completion_tokens)).toBeCloseTo(neurons, 3);
    }
  });

  it('omits usage entirely when prompt_tokens, completion_tokens, or neurons is missing or not a finite number', async () => {
    // Defensive per field, not "extract what's there" - a partial/guessed
    // usage block would silently corrupt decide.ts's true-up arithmetic, so
    // any one bad field drops the whole block rather than shipping a
    // partial one.
    const cases: Record<string, unknown>[] = [
      { ...structuredClone(jsonSchemaSquad.envelope), usage: undefined },
      {
        ...structuredClone(jsonSchemaSquad.envelope),
        usage: { prompt_tokens: 'not-a-number', completion_tokens: 1, neurons: 1 },
      },
      {
        ...structuredClone(jsonSchemaSquad.envelope),
        usage: { prompt_tokens: 1, completion_tokens: Number.NaN, neurons: 1 },
      },
      {
        ...structuredClone(jsonSchemaSquad.envelope),
        usage: { prompt_tokens: 1, completion_tokens: 1 }, // neurons missing entirely
      },
    ];
    for (const envelope of cases) {
      const ai = new StubAi(envelope);
      const provider = new WorkersAiProvider(ai as unknown as Ai);
      const result = await provider.complete({
        messages: [{ role: 'user', content: 'x' }],
        jsonSchema: SQUAD_SCHEMA,
        maxTokens: 400,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.usage).toBeUndefined();
    }
  });

  it('cached_tokens is optional and does not gate the rest of usage', async () => {
    const envelope = structuredClone(jsonSchemaSquad.envelope) as Record<string, unknown>;
    // `prompt_tokens_details` absent entirely - a plausible future envelope
    // shape, not just cached_tokens: 0. usage must still extract.
    delete (envelope.usage as Record<string, unknown>).prompt_tokens_details;
    const ai = new StubAi(envelope);
    const provider = new WorkersAiProvider(ai as unknown as Ai);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: SQUAD_SCHEMA,
      maxTokens: 400,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.usage).toEqual({
      promptTokens: jsonSchemaSquad.envelope.usage.prompt_tokens,
      completionTokens: jsonSchemaSquad.envelope.usage.completion_tokens,
      neurons: jsonSchemaSquad.envelope.usage.neurons,
    });
    expect(result.usage).not.toHaveProperty('cachedTokens');
  });
});
