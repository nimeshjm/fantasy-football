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

import { Position, RULES } from '../types';

export interface SquadLlmResult {
  picks: number[];
  reason: string;
}

/** What `buildLineupSchema` and `parseLineupResult` need to know about the
 * squad: who is owned, what they play, and how good they are. `xpts` orders
 * the derived bench and nothing else. */
export interface LineupOwned {
  element: number;
  position: Position;
  xpts: number;
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

/**
 * One fixed-length array per position, mirroring the per-position candidate
 * blocks `buildSquadPrompt` emits. The lengths are what the decoder enforces:
 * the real capture in test/fixtures/workers-ai/json-schema-lineup.json is
 * exactly 11 `starters` with one id filling two slots (issue #26), so the
 * model pads to `minItems` even at the cost of repeating an id. Splitting the
 * squad answer this way therefore makes the position COUNTS structural rather
 * than four counters the model has to hold while it picks - it got them wrong
 * in 9 of 9 recorded attempts on the flat `picks: [15]` shape this replaced,
 * with DEF wrong every single time.
 *
 * It does NOT make `position-count` unviolatable: nothing here stops a MID id
 * being written into `def`. `validateSquad` still has to check, and
 * `decideSquad` still has to retry and repair.
 *
 * Lengths must match `RULES.squadSelect`; test/prompts.test.ts asserts that
 * rather than deriving them, so the literal shape stays readable next to the
 * wire format it describes.
 */
export const SQUAD_SCHEMA = {
  type: 'object',
  properties: {
    gk: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 2,
      maxItems: 2,
      description: 'The 2 chosen goalkeeper element ids.',
    },
    def: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 5,
      maxItems: 5,
      description: 'The 5 chosen defender element ids.',
    },
    mid: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 5,
      maxItems: 5,
      description: 'The 5 chosen midfielder element ids.',
    },
    fwd: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 3,
      maxItems: 3,
      description: 'The 3 chosen forward element ids.',
    },
    reason: { type: 'string', maxLength: 300 },
  },
  required: ['gk', 'def', 'mid', 'fwd', 'reason'],
  additionalProperties: false,
} as const;

/** The `SQUAD_SCHEMA` keys in squad-slot order, with the length each one
 * carries. Exported so test/schemas.test.ts can hold it against
 * `RULES.squadSelect` and `RULES.squadSize`. */
export const SQUAD_ANSWER_KEYS = [
  ['gk', 2],
  ['def', 5],
  ['mid', 5],
  ['fwd', 3],
] as const;

const SQUAD_TOTAL = SQUAD_ANSWER_KEYS.reduce((n, [, count]) => n + count, 0);

/** The XI slots the lineup answer is cut into: one fixed-length array per
 * position at that position's MINIMUM, plus a flex array for the rest. */
const LINEUP_MIN_SLOTS = [
  ['gk', Position.GK],
  ['def', Position.DEF],
  ['mid', Position.MID],
  ['fwd', Position.FWD],
] as const;

/** Outfield slots left once every position has filled its `RULES.play`
 * minimum: the size of the `flex` answer list. Exported because
 * `buildLineupPrompt` has to describe the same list, and a prompt promising
 * a different count from the schema would be a silent contradiction. */
export const LINEUP_FLEX_SLOTS =
  RULES.squadPlay - LINEUP_MIN_SLOTS.reduce((n, [, p]) => n + RULES.play[p].min, 0);

/**
 * Built per request, because the id enums come from the squad being picked.
 *
 * What the fixed lengths buy, given the answer names the XI and the bench is
 * derived from it as the complement of the owned 15:
 *
 *  - exactly `RULES.squadPlay` starting slots, and a bench of exactly 4;
 *  - every position at or above its `RULES.play` minimum, so a `formation`
 *    error can no longer come from under-filling one. Every formation
 *    failure recorded on the flat schema was an under-minimum (an XI with 2
 *    DEF against a floor of 3), never an over-maximum;
 *  - the maxima cannot break either, but for a reason worth writing down:
 *    the owned squad holds exactly `RULES.squadSelect` of each position and
 *    for DEF/MID/FWD that equals `RULES.play[...].max`, so an XI drawn from
 *    it cannot exceed a maximum except by repeating an id. GK is the one
 *    position where squad (2) exceeds the XI maximum (1), and the single
 *    `gk` slot is what holds that down - provided no goalkeeper reaches the
 *    flex array, which is what its outfield-only `enum` is for;
 *  - no player outside the owned squad, and no owned player left unused,
 *    since the bench is whatever the XI did not take;
 *  - `captain`/`vice_captain` are INDICES into the XI, not element ids, so
 *    a captain outside the starting XI is not expressible. That failure was
 *    live: an `injured-star` answer captained a benched player.
 *
 * The `enum`s are a different class of claim from the lengths. `minItems`
 * enforcement is evidenced in this repo - the capture in
 * test/fixtures/workers-ai/json-schema-lineup.json holds exactly 11
 * `starters` with one id filling two slots (issue #26), so the decoder
 * padded to length at the cost of a duplicate. NO recorded capture has ever
 * carried an `enum`, so whether Workers AI constrains against one here is
 * untested. `parseLineupResult` therefore re-checks every id's membership
 * and position itself and does not trust the enum.
 */
export function buildLineupSchema(owned: readonly LineupOwned[]): Record<string, unknown> {
  const idsAt = (position: Position): number[] =>
    owned.filter((o) => o.position === position).map((o) => o.element);
  const outfield = [Position.DEF, Position.MID, Position.FWD].flatMap(idsAt);

  const properties: Record<string, unknown> = {};
  for (const [key, position] of LINEUP_MIN_SLOTS) {
    const count = RULES.play[position].min;
    properties[key] = {
      type: 'array',
      items: { type: 'integer', enum: idsAt(position) },
      minItems: count,
      maxItems: count,
      description: `The ${count} starting ${key.toUpperCase()} element id(s).`,
    };
  }
  properties.flex = {
    type: 'array',
    items: { type: 'integer', enum: outfield },
    minItems: LINEUP_FLEX_SLOTS,
    maxItems: LINEUP_FLEX_SLOTS,
    description: `The remaining ${LINEUP_FLEX_SLOTS} starting outfield element ids (DEF, MID or FWD).`,
  };
  properties.captain = {
    type: 'integer',
    minimum: 0,
    maximum: RULES.squadPlay - 1,
    description: `Position of the captain in the starting XI, counting gk, def, mid, fwd then flex from 0.`,
  };
  properties.vice_captain = {
    type: 'integer',
    minimum: 0,
    maximum: RULES.squadPlay - 1,
    description: `Position of the vice-captain in the starting XI, same counting, and not the captain's.`,
  };
  properties.reason = { type: 'string', maxLength: 300 };

  return {
    type: 'object',
    properties,
    required: [
      ...LINEUP_MIN_SLOTS.map(([key]) => key),
      'flex',
      'captain',
      'vice_captain',
      'reason',
    ],
    additionalProperties: false,
  };
}

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
 * distinct. JSON Schema `minItems`/`maxItems` (see `buildLineupSchema`/
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

/**
 * Flattens a squad answer into slot order, accepting either shape: the
 * position-keyed arrays `SQUAD_SCHEMA` now asks for, or the flat
 * `picks: [15]` it asked for before 2026-09-09. The flat form is still
 * live, not dead code - the real capture in
 * test/fixtures/workers-ai/json-schema-squad.json is that older shape, and
 * rewriting a recorded response to suit a newer schema would destroy the
 * only genuine evidence of what this model actually returned.
 */
function squadPicksFrom(obj: Record<string, unknown>): ParseResult<number[]> {
  if (obj.picks !== undefined) {
    if (!isIntegerArray(obj.picks) || obj.picks.length !== SQUAD_TOTAL) {
      return { ok: false, error: `"picks" must be an array of exactly ${SQUAD_TOTAL} integers` };
    }
    return { ok: true, value: obj.picks };
  }
  const picks: number[] = [];
  for (const [key, count] of SQUAD_ANSWER_KEYS) {
    const list = obj[key];
    if (!isIntegerArray(list) || list.length !== count) {
      return { ok: false, error: `"${key}" must be an array of exactly ${count} integers` };
    }
    picks.push(...list);
  }
  return { ok: true, value: picks };
}

export function parseSquadResult(text: string): ParseResult<SquadLlmResult> {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: 'response is not a JSON object' };
  }
  const obj = v as Record<string, unknown>;
  const picks = squadPicksFrom(obj);
  if (!picks.ok) return picks;
  const duplicatePick = findDuplicate(picks.value);
  if (duplicatePick !== undefined) {
    return {
      ok: false,
      error: `squad must be ${SQUAD_TOTAL} distinct ids; ${duplicatePick} appears more than once`,
    };
  }
  if (typeof obj.reason !== 'string') {
    return { ok: false, error: '"reason" must be a string' };
  }
  return { ok: true, value: { picks: picks.value, reason: obj.reason } };
}

/**
 * Parses one `buildLineupSchema` answer.
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
/**
 * The XI in slot order, or an error naming the first thing wrong with it.
 * Membership and position are re-checked here rather than trusted to the
 * schema's `enum`s, which have no recorded evidence of being enforced.
 */
function lineupStartersFrom(
  obj: Record<string, unknown>,
  owned: readonly LineupOwned[],
): ParseResult<number[]> {
  const positionOf = new Map(owned.map((o) => [o.element, o.position] as const));
  const starters: number[] = [];

  for (const [key, position] of LINEUP_MIN_SLOTS) {
    const count = RULES.play[position].min;
    const list = obj[key];
    if (!isIntegerArray(list) || list.length !== count) {
      return { ok: false, error: `"${key}" must be an array of exactly ${count} integer(s)` };
    }
    for (const id of list) {
      if (positionOf.get(id) !== position) {
        return {
          ok: false,
          error: `"${key}" must hold owned ${Position[position]} ids; ${id} is not one`,
        };
      }
    }
    starters.push(...list);
  }

  const flex = obj.flex;
  if (!isIntegerArray(flex) || flex.length !== LINEUP_FLEX_SLOTS) {
    return {
      ok: false,
      error: `"flex" must be an array of exactly ${LINEUP_FLEX_SLOTS} integers`,
    };
  }
  for (const id of flex) {
    const position = positionOf.get(id);
    if (position === undefined) {
      return { ok: false, error: `"flex" holds ${id}, which is not in the owned squad` };
    }
    if (position === Position.GK) {
      return {
        ok: false,
        error: `"flex" must hold outfield ids only; ${id} is a goalkeeper`,
      };
    }
  }
  starters.push(...flex);

  const duplicate = findDuplicate(starters);
  if (duplicate !== undefined) {
    return {
      ok: false,
      error: `the starting XI must be ${RULES.squadPlay} distinct ids; ${duplicate} appears more than once`,
    };
  }
  return { ok: true, value: starters };
}

/** Bench = whatever the XI left behind, in the order `bestLineup` uses:
 * outfield subs by descending xpts, reserve goalkeeper always last, because
 * an autosub only reaches the bench keeper when the starting keeper does not
 * play at all. Deriving it is what makes an unused owned player or a
 * duplicated bench id unrepresentable. */
function benchFrom(starters: readonly number[], owned: readonly LineupOwned[]): number[] {
  const starting = new Set(starters);
  const left = owned.filter((o) => !starting.has(o.element));
  const outfield = left
    .filter((o) => o.position !== Position.GK)
    .sort((a, b) => b.xpts - a.xpts)
    .map((o) => o.element);
  const keepers = left.filter((o) => o.position === Position.GK).map((o) => o.element);
  return [...outfield, ...keepers];
}

function legacyLineupResult(obj: Record<string, unknown>): ParseResult<LineupLlmResult> {
  if (!isIntegerArray(obj.starters) || obj.starters.length !== RULES.squadPlay) {
    return {
      ok: false,
      error: `"starters" must be an array of exactly ${RULES.squadPlay} integers`,
    };
  }
  if (!isIntegerArray(obj.bench) || obj.bench.length !== RULES.squadSize - RULES.squadPlay) {
    return {
      ok: false,
      error: `"bench" must be an array of exactly ${RULES.squadSize - RULES.squadPlay} integers`,
    };
  }
  const duplicateStarter = findDuplicate(obj.starters);
  if (duplicateStarter !== undefined) {
    return {
      ok: false,
      error: `"starters" must be ${RULES.squadPlay} distinct ids; ${duplicateStarter} appears more than once`,
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

/**
 * Parses one `buildLineupSchema` answer into the same `LineupLlmResult`
 * `decideLineup` has always consumed: element ids for captain and vice, a
 * starting XI and a bench in slot order. The answer itself now names only
 * the XI, per position, and points at its captain by index.
 *
 * The flat `starters`/`bench` shape is still accepted when `owned` is empty,
 * and is still a live path rather than dead code: the capture in
 * test/fixtures/workers-ai/json-schema-lineup.json is that older shape and
 * rewriting a recorded response to suit a newer schema would destroy the
 * only genuine evidence of what this model returned. That branch carries
 * NONE of the guarantees above - it trusts the model's own `bench` without
 * checking membership or re-deriving order - which is why reaching it takes
 * a caller with no squad to check against, and `owned` is required rather
 * than defaulted so a forgotten argument is a compile error instead of a
 * confusing per-position parse failure.
 */
export function parseLineupResult(
  text: string,
  owned: readonly LineupOwned[],
): ParseResult<LineupLlmResult> {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  if (typeof v !== 'object' || v === null) {
    return { ok: false, error: 'response is not a JSON object' };
  }
  const obj = v as Record<string, unknown>;
  // An empty `owned` is the caller saying "I have no squad to check against",
  // which only the recorded-capture test does. Keying the legacy branch off
  // that rather than off the presence of a `starters` key matters: keyed off
  // the key, a model could opt out of every guarantee below by naming its
  // answer differently, and the branch it landed in takes `bench` verbatim
  // with no membership or ordering check at all. Every production caller
  // passes a real squad, so none of them can reach it.
  if (owned.length === 0) return legacyLineupResult(obj);

  const starters = lineupStartersFrom(obj, owned);
  if (!starters.ok) return starters;

  const asIndex = (key: 'captain' | 'vice_captain'): ParseResult<number> => {
    const value = obj[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { ok: false, error: `"${key}" must be an integer` };
    }
    if (value < 0 || value >= RULES.squadPlay) {
      return {
        ok: false,
        error: `"${key}" must be a starting-XI position from 0 to ${RULES.squadPlay - 1}; got ${value}`,
      };
    }
    return { ok: true, value };
  };
  const captainIndex = asIndex('captain');
  if (!captainIndex.ok) return captainIndex;
  const viceIndex = asIndex('vice_captain');
  if (!viceIndex.ok) return viceIndex;
  if (captainIndex.value === viceIndex.value) {
    return {
      ok: false,
      error: `"captain" and "vice_captain" must be different starting-XI positions; both are ${captainIndex.value}`,
    };
  }
  if (typeof obj.reason !== 'string') {
    return { ok: false, error: '"reason" must be a string' };
  }

  return {
    ok: true,
    value: {
      starters: starters.value,
      bench: benchFrom(starters.value, owned),
      captain: starters.value[captainIndex.value]!,
      vice_captain: starters.value[viceIndex.value]!,
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
