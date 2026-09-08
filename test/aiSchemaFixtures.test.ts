/**
 * Feeds each json_schema fixture's real, captured answer (see
 * test/fixtures/workers-ai/README.md) through the matching parser in
 * src/ai/schemas.ts, and - for the lineup fixture, whose real answer is
 * malformed - through src/ai/validate.ts as well, to record what this
 * project's pipeline actually does with it.
 *
 * This is deliberately a separate file from test/provider.test.ts:
 * provider.test.ts tests the envelope-parsing layer
 * (`extractResponseText`/`WorkersAiProvider`), this file tests the next
 * layer down (the per-decision schema parsers and lineup validation) against
 * the same real fixtures.
 */
import { describe, expect, it } from 'vitest';

import { extractResponseTextForTest } from '../src/ai/provider';
import { parseLineupResult, parseSquadResult, parseTransferResult } from '../src/ai/schemas';
import { validateLineup, type OwnedPlayer } from '../src/ai/validate';
import { Position, type Pick } from '../src/types';

import jsonSchemaSquad from './fixtures/workers-ai/json-schema-squad.json';
import jsonSchemaLineup from './fixtures/workers-ai/json-schema-lineup.json';
import jsonSchemaTransfer from './fixtures/workers-ai/json-schema-transfer.json';

describe('parseSquadResult against the real json-schema-squad.json capture', () => {
  it('accepts the real answer and returns exactly the recorded picks/reason', () => {
    const text = extractResponseTextForTest(jsonSchemaSquad.envelope);
    const result = parseSquadResult(text!);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual(jsonSchemaSquad.envelope.response);
  });
});

describe('parseTransferResult against the real json-schema-transfer.json capture', () => {
  it('accepts the real answer and returns exactly the recorded element_in/element_out/reason', () => {
    const text = extractResponseTextForTest(jsonSchemaTransfer.envelope);
    const result = parseTransferResult(text!);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual(jsonSchemaTransfer.envelope.response);
  });
});

describe('the real json-schema-lineup.json capture (starters has a duplicate id, reason is empty)', () => {
  // The owned 15, read off `request.messages[1].content` in
  // json-schema-lineup.json ("Owned 15 (id, pos, projected)"): 2 GK, 5 DEF,
  // 5 MID, 3 FWD. Hand-transcribed here once, rather than parsed out of the
  // prompt text, so this test doesn't depend on prompt-string formatting.
  const owned: OwnedPlayer[] = [
    { element: 101, position: Position.GK },
    { element: 102, position: Position.GK },
    { element: 201, position: Position.DEF },
    { element: 202, position: Position.DEF },
    { element: 203, position: Position.DEF },
    { element: 204, position: Position.DEF },
    { element: 205, position: Position.DEF },
    { element: 301, position: Position.MID },
    { element: 302, position: Position.MID },
    { element: 303, position: Position.MID },
    { element: 304, position: Position.MID },
    { element: 305, position: Position.MID },
    { element: 401, position: Position.FWD },
    { element: 402, position: Position.FWD },
    { element: 403, position: Position.FWD },
  ];

  it('parseLineupResult ACCEPTS the malformed answer: the hand-rolled schema parser checks length and integer-ness only, never distinctness or reason non-emptiness', () => {
    // This is the true current behaviour, not a gap being papered over: the
    // fixture's `_captured.note` calls this out explicitly ("schema
    // minItems/maxItems does not imply distinctness"), and per issue #15's
    // instructions this is reported rather than fixed here. `starters` has
    // 11 array entries (302 appears twice, so only 10 distinct ids) and
    // `reason` is the empty string - both satisfy `parseLineupResult`, which
    // only checks `isIntegerArray(...) && length === 11` and
    // `typeof reason === 'string'`.
    const text = extractResponseTextForTest(jsonSchemaLineup.envelope);
    const result = parseLineupResult(text!);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.starters).toEqual(jsonSchemaLineup.envelope.response.starters);
    expect(result.value.reason).toBe('');
  });

  it('validateLineup then REJECTS it, the same way decide.ts builds `picks` and validates them, so the pipeline never ships this answer', () => {
    // Mirrors decideLineup's construction in src/ai/decide.ts: starters fill
    // positions 1-11, bench fills 12-15, and any element equal to `captain`/
    // `vice_captain` is flagged on every pick carrying that element id -
    // which, because 302 (the duplicate) IS the recorded vice_captain, means
    // BOTH of its picks get flagged is_vice_captain here.
    const text = extractResponseTextForTest(jsonSchemaLineup.envelope);
    const parsed = parseLineupResult(text!);
    if (!parsed.ok) throw new Error('unreachable (checked above)');

    const picks: Pick[] = [
      ...parsed.value.starters.map((elementId, i) => ({
        element: elementId,
        position: i + 1,
        is_captain: elementId === parsed.value.captain,
        is_vice_captain: elementId === parsed.value.vice_captain,
      })),
      ...parsed.value.bench.map((elementId, i) => ({
        element: elementId,
        position: 11 + 1 + i,
        is_captain: elementId === parsed.value.captain,
        is_vice_captain: elementId === parsed.value.vice_captain,
      })),
    ];

    const errors = validateLineup(picks, owned);
    const rules = new Set(errors.map((e) => e.rule));

    // Exactly three rules fire, and each catches a genuinely different piece
    // of the malformation:
    //  - 'duplicate-element': element 302 occupies two slots.
    //  - 'owned-not-used': element 102 (a GK) appears nowhere at all - not in
    //    starters, not in bench. This is a correct rejection of a genuinely
    //    unused owned player, NOT an artifact of the duplicate.
    //  - 'vice-captain-count': 302 is the recorded vice_captain, and BOTH of
    //    its picks match `elementId === vice_captain`, so two picks end up
    //    marked vice-captain instead of exactly one.
    //
    // What does NOT fire, and why that is worth recording even though it does
    // not cost this fixture a correct rejection: 'starter-count' and
    // 'formation' both count pick SLOTS, not distinct elements. There are 11
    // starter slots (so 'starter-count' is satisfied) but only 10 distinct
    // starting elements, because 302 fills two of them; the starting MID
    // count comes out to 5 (301, 302, 304, 303, 302 again) - inside the
    // legal 2-5 range - when only 4 distinct MIDs actually start. Neither
    // count-based rule is wrong on its own terms, but neither would catch a
    // duplicate on its own either; it is 'duplicate-element' and
    // 'owned-not-used' - the distinctness/coverage rules - that reject this
    // answer, not the formation check. Reported as an observation about
    // which rule is actually load-bearing here, not a hole to fix (issue #15
    // scope: report, do not patch validate.ts).
    expect(rules).toEqual(new Set(['duplicate-element', 'owned-not-used', 'vice-captain-count']));

    // decideLineup treats any non-empty `errors` as a retry signal and, after
    // MAX_RETRIES, falls back to the deterministic lineup - this malformed
    // answer never reaches gateDecision, let alone gets shipped.
  });
});
