/**
 * Flat JSON Schemas for each LLM decision, plus matching TS types and a
 * hand-rolled runtime parser for each.
 *
 * Kept deliberately FLAT (no nested objects, no oneOf/anyOf) and SMALL:
 * Workers AI's JSON mode for this model can refuse a complex schema outright
 * (see src/ai/provider.ts), and every field the model has to fill costs
 * output Neurons, which are ~7.7x the price of input Neurons (see
 * `estimateNeurons` in provider.ts). `required` lists every field and
 * `additionalProperties: false` is set everywhere, so the model cannot pad
 * its answer with prose per player - just ids and one short reason.
 *
 * `0` is used as the sentinel id for "no transfer" in the transfer schema:
 * no real Fantasy Liga Portugal element has id 0, and a flat schema with
 * every field required has no other way to express "do nothing".
 *
 * No schema-validation library (ajv/zod/etc) is in this project's
 * dependencies, so parsing here is hand-rolled rather than pulling one in
 * for three small, fixed shapes.
 */

export interface SquadLlmResult {
  picks: number[];
  reason: string;
}

export interface LineupLlmResult {
  starters: number[];
  bench: number[];
  captain: number;
  vice_captain: number;
  reason: string;
}

export interface TransferLlmResult {
  element_in: number;
  element_out: number;
  reason: string;
}

export const SQUAD_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 15,
      maxItems: 15,
      description: 'The 15 chosen element ids.',
    },
    reason: { type: 'string', maxLength: 300 },
  },
  required: ['picks', 'reason'],
  additionalProperties: false,
} as const;

export const LINEUP_SCHEMA = {
  type: 'object',
  properties: {
    starters: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 11,
      maxItems: 11,
      description: 'The 11 starting element ids.',
    },
    bench: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 4,
      maxItems: 4,
      description: 'The 4 bench element ids, best-to-worst.',
    },
    captain: { type: 'integer' },
    vice_captain: { type: 'integer' },
    reason: { type: 'string', maxLength: 300 },
  },
  required: ['starters', 'bench', 'captain', 'vice_captain', 'reason'],
  additionalProperties: false,
} as const;

export const TRANSFER_SCHEMA = {
  type: 'object',
  properties: {
    element_in: {
      type: 'integer',
      description: 'Id of the player to buy, matching a candidate. 0 means no transfer.',
    },
    element_out: {
      type: 'integer',
      description: 'Id of the player to sell, matching the same candidate. 0 means no transfer.',
    },
    reason: { type: 'string', maxLength: 300 },
  },
  required: ['element_in', 'element_out', 'reason'],
  additionalProperties: false,
} as const;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isIntegerArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isInteger(x));
}

/**
 * First id that appears more than once in `ids`, or `undefined` if all are
 * distinct. JSON Schema `minItems`/`maxItems` (see `LINEUP_SCHEMA`/
 * `SQUAD_SCHEMA` above) bounds array LENGTH only, not distinctness - the
 * real Workers AI capture in test/fixtures/workers-ai/json-schema-lineup.json
 * is exactly 11 `starters` entries with element 302 filling two of them
 * (issue #26). Rejecting that here, at the schema layer, is cheaper than a
 * full `validateLineup` round trip: `parseLineupResult`/`parseSquadResult`
 * already fail fast on wrong length/type, this is the same class of
 * cheap, local check.
 */
function findDuplicate(ids: number[]): number | undefined {
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'response was not valid JSON' };
  }
}

export function parseSquadResult(text: string): ParseResult<SquadLlmResult> {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: 'response is not a JSON object' };
  }
  const obj = v as Record<string, unknown>;
  if (!isIntegerArray(obj.picks) || obj.picks.length !== 15) {
    return { ok: false, error: '"picks" must be an array of exactly 15 integers' };
  }
  const duplicatePick = findDuplicate(obj.picks);
  if (duplicatePick !== undefined) {
    return {
      ok: false,
      error: `"picks" must be 15 distinct ids; ${duplicatePick} appears more than once`,
    };
  }
  if (typeof obj.reason !== 'string') {
    return { ok: false, error: '"reason" must be a string' };
  }
  return { ok: true, value: { picks: obj.picks, reason: obj.reason } };
}

/**
 * Parses one `LINEUP_SCHEMA` answer.
 *
 * Deliberately does NOT reject an empty `reason`. The real capture in
 * test/fixtures/workers-ai/json-schema-lineup.json returned `reason: ""`
 * alongside its malformed `starters` (issue #26) - `reason` is audit-only,
 * recorded to `ai_calls` for a human to read later, and never feeds into
 * `picks`/`captain`/`vice_captain` or any validation/gate decision. Rejecting
 * it here would spend a retry (`decideLineup`'s `MAX_RETRIES = 2`, see
 * src/ai/decide.ts) - and therefore a real Neuron cost, ~20.6 Neurons for
 * this exact lineup call per the fixture's `_captured.neurons` - on a
 * cosmetic field, and a model that returns `""` once has no particular
 * reason not to do it again, which would burn the retry budget on the
 * reason alone before ever getting to a shape problem worth retrying for.
 * The honest trade this makes: an empty `reason` surfaces downstream as an
 * unexplained decision in `ai_calls`, not as a parse failure here.
 */
export function parseLineupResult(text: string): ParseResult<LineupLlmResult> {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: 'response is not a JSON object' };
  }
  const obj = v as Record<string, unknown>;
  if (!isIntegerArray(obj.starters) || obj.starters.length !== 11) {
    return { ok: false, error: '"starters" must be an array of exactly 11 integers' };
  }
  if (!isIntegerArray(obj.bench) || obj.bench.length !== 4) {
    return { ok: false, error: '"bench" must be an array of exactly 4 integers' };
  }
  const duplicateStarter = findDuplicate(obj.starters);
  if (duplicateStarter !== undefined) {
    return {
      ok: false,
      error: `"starters" must be 11 distinct ids; ${duplicateStarter} appears more than once`,
    };
  }
  const duplicateBenchId = findDuplicate(obj.bench);
  if (duplicateBenchId !== undefined) {
    return {
      ok: false,
      error: `"bench" must be 4 distinct ids; ${duplicateBenchId} appears more than once`,
    };
  }
  const benchIds = new Set(obj.bench);
  const starterAlsoOnBench = obj.starters.find((id) => benchIds.has(id));
  if (starterAlsoOnBench !== undefined) {
    return {
      ok: false,
      error: `element ${starterAlsoOnBench} appears in both "starters" and "bench"`,
    };
  }
  if (typeof obj.captain !== 'number' || !Number.isInteger(obj.captain)) {
    return { ok: false, error: '"captain" must be an integer' };
  }
  if (typeof obj.vice_captain !== 'number' || !Number.isInteger(obj.vice_captain)) {
    return { ok: false, error: '"vice_captain" must be an integer' };
  }
  if (typeof obj.reason !== 'string') {
    return { ok: false, error: '"reason" must be a string' };
  }
  return {
    ok: true,
    value: {
      starters: obj.starters,
      bench: obj.bench,
      captain: obj.captain,
      vice_captain: obj.vice_captain,
      reason: obj.reason,
    },
  };
}

export function parseTransferResult(text: string): ParseResult<TransferLlmResult> {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: 'response is not a JSON object' };
  }
  const obj = v as Record<string, unknown>;
  if (typeof obj.element_in !== 'number' || !Number.isInteger(obj.element_in)) {
    return { ok: false, error: '"element_in" must be an integer' };
  }
  if (typeof obj.element_out !== 'number' || !Number.isInteger(obj.element_out)) {
    return { ok: false, error: '"element_out" must be an integer' };
  }
  if (typeof obj.reason !== 'string') {
    return { ok: false, error: '"reason" must be a string' };
  }
  return {
    ok: true,
    value: { element_in: obj.element_in, element_out: obj.element_out, reason: obj.reason },
  };
}
