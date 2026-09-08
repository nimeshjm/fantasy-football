import { describe, expect, it } from 'vitest';

import { extractResponseTextForTest, WorkersAiProvider } from '../src/ai/provider';
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
