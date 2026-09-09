/**
 * Feeds each json_schema fixture's real, captured answer (see
 * test/fixtures/workers-ai/README.md) through the matching parser in
 * src/ai/schemas.ts, and - for the lineup fixture, whose real answer is
 * malformed - through src/ai/validate.ts as well. For the lineup fixture
 * this now asserts the INVARIANT that the malformed answer is rejected, and
 * that the count-based rules catch what they were built to catch (issue
 * #26), rather than pinning in place whichever rules happened to fire first.
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

  it('parseLineupResult REJECTS the malformed answer at the schema layer, naming the duplicated id (issue #26)', () => {
    // Before issue #26's fix, `parseLineupResult` accepted this answer: it
    // checked length and integer-ness only, never distinctness. `starters`
    // has 11 array entries but 302 fills two of them (10 distinct ids), so
    // the schema-level distinctness check now added to `parseLineupResult`
    // (see src/ai/schemas.ts) rejects it before `validateLineup` is ever
    // reached - cheaper than the full validation round trip below, and the
    // error names the offending id so a retry prompt (src/ai/decide.ts) can
    // tell the model exactly what was wrong.
    const text = extractResponseTextForTest(jsonSchemaLineup.envelope);
    // Empty owned selects parseLineupResult's legacy flat-shape branch,
    // which this capture predates the per-position schema and is written in.
    const result = parseLineupResult(text!, []);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('302');
  });

  it('validateLineup ALSO rejects it (defense in depth): the same construction decide.ts would build from the raw envelope response, run through validation without going via the (now rejecting) parser', () => {
    // The parser now catches this answer before it ever reaches
    // `validateLineup` in the real pipeline, so this test builds `picks`
    // directly from the captured envelope response - bypassing
    // `parseLineupResult` on purpose - to prove `validateLineup` is an
    // independent safety net, not merely accepting whatever the parser lets
    // through. Mirrors decideLineup's construction in src/ai/decide.ts:
    // starters fill positions 1-11, bench fills 12-15, and any element equal
    // to `captain`/`vice_captain` is flagged on every pick carrying that
    // element id - which, because 302 (the duplicate) IS the recorded
    // vice_captain, means BOTH of its picks get flagged is_vice_captain here.
    const response = jsonSchemaLineup.envelope.response;
    const picks: Pick[] = [
      ...response.starters.map((elementId, i) => ({
        element: elementId,
        position: i + 1,
        is_captain: elementId === response.captain,
        is_vice_captain: elementId === response.vice_captain,
      })),
      ...response.bench.map((elementId, i) => ({
        element: elementId,
        position: 11 + 1 + i,
        is_captain: elementId === response.captain,
        is_vice_captain: elementId === response.vice_captain,
      })),
    ];

    const errors = validateLineup(picks, owned);
    const rules = new Set(errors.map((e) => e.rule));

    // Four rules fire, each catching a genuinely different piece of the
    // malformation - this is the invariant issue #26 asks this test to
    // assert, not the old incidental arrangement:
    //  - 'duplicate-element': element 302 occupies two slots.
    //  - 'owned-not-used': element 102 (a GK) appears nowhere at all - not in
    //    starters, not in bench. A correct rejection of a genuinely unused
    //    owned player, NOT an artifact of the duplicate.
    //  - 'vice-captain-count': 302 is the recorded vice_captain, and BOTH of
    //    its picks match `elementId === vice_captain`, so two picks end up
    //    marked vice-captain instead of exactly one.
    //  - 'starter-count': now that it counts DISTINCT starting elements
    //    (src/ai/validate.ts) rather than starter SLOTS, it correctly sees
    //    10 distinct starters (302 counted once) where 11 are required. This
    //    is the count rule the issue is about - before the fix it counted 11
    //    slots and passed.
    //
    // 'formation' is deliberately NOT expected here, and this is not a
    // remaining gap: the 10 distinct starters are 1 GK, 3 DEF, 4 MID
    // (301/302/303/304), 2 FWD - every bucket already legal under RULES.play
    // (1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD). What's wrong with this lineup is the
    // *total* headcount (10 instead of 11), which is 'starter-count's job;
    // there is no distinct-element-shape violation for 'formation' to catch
    // on THIS capture. 'formation's own fix (also counting distinct
    // elements, so it can no longer be inflated by a duplicated slot) is
    // proven separately in test/validate.test.ts with a constructed case
    // where a duplicate genuinely does push a position's distinct count
    // outside its legal range.
    expect(rules).toContain('duplicate-element');
    expect(rules).toContain('owned-not-used');
    expect(rules).toContain('vice-captain-count');
    expect(rules).toContain('starter-count');
    expect(errors.length).toBeGreaterThan(0);

    // decideLineup treats any non-empty `errors` as a retry signal and, after
    // MAX_RETRIES, falls back to the deterministic lineup - this malformed
    // answer never reaches gateDecision, let alone gets shipped. In the real
    // pipeline it will not even get this far: `parseLineupResult` now
    // rejects it first (see the test above).
  });
});
