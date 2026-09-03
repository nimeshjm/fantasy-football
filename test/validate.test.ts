/**
 * Tests for the safety layer standing between a weak model and irreversible,
 * points-costing writes. Uses a small hand-built synthetic universe of
 * elements so every boundary case (over budget by exactly 1, exactly 15/16/14
 * picks, precise per-position and per-club counts) is unambiguous and does
 * not depend on how bootstrap-static.json happens to be priced.
 */
import { describe, expect, it } from 'vitest';

import { Position, RULES, type Element, type Pick, type TransferMove } from '../src/types';
import {
  gateDecision,
  repairSquad,
  shortlistContainsLegalSquad,
  validateLineup,
  validateSquad,
  validateTransfer,
  type OwnedPlayer,
  type TransferCandidate,
} from '../src/ai/validate';
import { decideSquad, type DeterministicBaseline, type NeuronBudget } from '../src/ai/decide';
import { StubProvider } from '../src/ai/provider';
import type { ShortlistEntry } from '../src/ai/prompts';

// ---------------------------------------------------------------------------
// Synthetic universe
// ---------------------------------------------------------------------------

function makeElement(overrides: Partial<Element> & { id: number }): Element {
  return {
    code: overrides.id,
    web_name: `P${overrides.id}`,
    first_name: '',
    second_name: `P${overrides.id}`,
    team: 1,
    element_type: Position.MID,
    now_cost: 50,
    status: 'a',
    news: '',
    news_added: null,
    chance_of_playing_this_round: null,
    chance_of_playing_next_round: null,
    total_points: 0,
    event_points: 0,
    points_per_game: '0.0',
    form: '0.0',
    ep_next: '0.0',
    ep_this: null,
    selected_by_percent: '0.0',
    minutes: 900,
    removed: false,
    can_select: true,
    can_transact: true,
    ...overrides,
  };
}

// A legal 15-player squad: 2 GK, 5 DEF, 5 MID, 3 FWD, total cost 755 (<=
// 1000), no club above 3 players.
//   club1: GK101, DEF103, MID108        (3)
//   club2: GK102, DEF104, MID112        (3)
//   club3: DEF105, MID109, FWD113       (3)
//   club4: DEF106, MID110               (2)
//   club5: DEF107, FWD114               (2)
//   club6: MID111, FWD115               (2)
const LEGAL_SQUAD_ELEMENTS: Element[] = [
  makeElement({ id: 101, element_type: Position.GK, team: 1, now_cost: 40 }),
  makeElement({ id: 102, element_type: Position.GK, team: 2, now_cost: 40 }),
  makeElement({ id: 103, element_type: Position.DEF, team: 1, now_cost: 40 }),
  makeElement({ id: 104, element_type: Position.DEF, team: 2, now_cost: 40 }),
  makeElement({ id: 105, element_type: Position.DEF, team: 3, now_cost: 40 }),
  makeElement({ id: 106, element_type: Position.DEF, team: 4, now_cost: 45 }),
  makeElement({ id: 107, element_type: Position.DEF, team: 5, now_cost: 45 }),
  makeElement({ id: 108, element_type: Position.MID, team: 1, now_cost: 50 }),
  makeElement({ id: 109, element_type: Position.MID, team: 3, now_cost: 50 }),
  makeElement({ id: 110, element_type: Position.MID, team: 4, now_cost: 55 }),
  makeElement({ id: 111, element_type: Position.MID, team: 6, now_cost: 55 }),
  makeElement({ id: 112, element_type: Position.MID, team: 2, now_cost: 60 }),
  makeElement({ id: 113, element_type: Position.FWD, team: 3, now_cost: 60 }),
  makeElement({ id: 114, element_type: Position.FWD, team: 5, now_cost: 65 }),
  makeElement({ id: 115, element_type: Position.FWD, team: 6, now_cost: 70 }),
];

// Extra elements used only by individual negative tests (never part of the
// legal baseline above).
const REMOVED_ELEMENT = makeElement({ id: 500, element_type: Position.DEF, removed: true });
const UNSELECTABLE_ELEMENT = makeElement({
  id: 501,
  element_type: Position.DEF,
  can_select: false,
});
const FOURTH_CLUB1_MID = makeElement({
  id: 502,
  element_type: Position.MID,
  team: 1,
  now_cost: 50,
});
const EXTRA_DEF = makeElement({ id: 503, element_type: Position.DEF, team: 7, now_cost: 40 });
const CHEAP_FILLER = makeElement({ id: 504, element_type: Position.DEF, team: 8, now_cost: 40 });

const ALL_ELEMENTS: Element[] = [
  ...LEGAL_SQUAD_ELEMENTS,
  REMOVED_ELEMENT,
  UNSELECTABLE_ELEMENT,
  FOURTH_CLUB1_MID,
  EXTRA_DEF,
  CHEAP_FILLER,
];

function picksFor(elements: Element[]): Pick[] {
  return elements.map((e, i) => ({
    element: e.id,
    position: i + 1,
    is_captain: false,
    is_vice_captain: false,
  }));
}

// ---------------------------------------------------------------------------
// validateSquad
// ---------------------------------------------------------------------------

describe('validateSquad', () => {
  it('accepts a legal squad with no errors', () => {
    expect(validateSquad(picksFor(LEGAL_SQUAD_ELEMENTS), ALL_ELEMENTS)).toEqual([]);
  });

  it('rejects 4 players from one club', () => {
    // Swap out MID111 (club6) for a 4th club1 player.
    const elements = LEGAL_SQUAD_ELEMENTS.filter((e) => e.id !== 111).concat(FOURTH_CLUB1_MID);
    const errors = validateSquad(picksFor(elements), ALL_ELEMENTS);
    expect(errors.some((e) => e.rule === 'club-limit')).toBe(true);
  });

  it('rejects 16 picks', () => {
    const elements = [...LEGAL_SQUAD_ELEMENTS, EXTRA_DEF];
    const errors = validateSquad(picksFor(elements), ALL_ELEMENTS);
    expect(errors.some((e) => e.rule === 'squad-size')).toBe(true);
  });

  it('rejects 14 picks', () => {
    const elements = LEGAL_SQUAD_ELEMENTS.slice(0, 14);
    const errors = validateSquad(picksFor(elements), ALL_ELEMENTS);
    expect(errors.some((e) => e.rule === 'squad-size')).toBe(true);
  });

  it('rejects a squad over budget by 1 (tenth of a million)', () => {
    const overBudget = LEGAL_SQUAD_ELEMENTS.map((e) =>
      e.id === 115 ? { ...e, now_cost: e.now_cost + (RULES.budget - 755) + 1 } : e,
    );
    const errors = validateSquad(picksFor(overBudget), [
      ...overBudget,
      REMOVED_ELEMENT,
      UNSELECTABLE_ELEMENT,
    ]);
    expect(errors.some((e) => e.rule === 'budget')).toBe(true);
  });

  it('accepts a squad exactly at budget', () => {
    const atBudget = LEGAL_SQUAD_ELEMENTS.map((e) =>
      e.id === 115 ? { ...e, now_cost: e.now_cost + (RULES.budget - 755) } : e,
    );
    const errors = validateSquad(picksFor(atBudget), [
      ...atBudget,
      REMOVED_ELEMENT,
      UNSELECTABLE_ELEMENT,
    ]);
    expect(errors).toEqual([]);
  });

  it('rejects wrong per-position counts (3 GK instead of 2)', () => {
    // Replace DEF107 with a 3rd GK (a new id, so the canonical elements list
    // below reflects it rather than a stale copy of the original DEF107).
    const thirdGk = makeElement({ id: 505, element_type: Position.GK, team: 5, now_cost: 45 });
    const elements = LEGAL_SQUAD_ELEMENTS.filter((e) => e.id !== 107).concat(thirdGk);
    const errors = validateSquad(picksFor(elements), [...ALL_ELEMENTS, thirdGk]);
    expect(errors.some((e) => e.rule === 'position-count')).toBe(true);
  });

  it('rejects duplicate ids', () => {
    const elements = LEGAL_SQUAD_ELEMENTS.slice(0, 14).concat(LEGAL_SQUAD_ELEMENTS[0]!);
    const errors = validateSquad(picksFor(elements), ALL_ELEMENTS);
    expect(errors.some((e) => e.rule === 'duplicate-element')).toBe(true);
  });

  it('rejects a non-existent id', () => {
    const picks = picksFor(LEGAL_SQUAD_ELEMENTS.slice(0, 14));
    picks.push({ element: 999999, position: 15, is_captain: false, is_vice_captain: false });
    const errors = validateSquad(picks, ALL_ELEMENTS);
    expect(errors.some((e) => e.rule === 'unknown-element')).toBe(true);
  });

  it('rejects a removed player', () => {
    const elements = LEGAL_SQUAD_ELEMENTS.slice(0, 14).concat(REMOVED_ELEMENT);
    const errors = validateSquad(picksFor(elements), ALL_ELEMENTS);
    expect(errors.some((e) => e.rule === 'unselectable-element')).toBe(true);
  });

  it('rejects a non-selectable player', () => {
    const elements = LEGAL_SQUAD_ELEMENTS.slice(0, 14).concat(UNSELECTABLE_ELEMENT);
    const errors = validateSquad(picksFor(elements), ALL_ELEMENTS);
    expect(errors.some((e) => e.rule === 'unselectable-element')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateLineup
// ---------------------------------------------------------------------------

const OWNED: OwnedPlayer[] = LEGAL_SQUAD_ELEMENTS.map((e) => ({
  element: e.id,
  position: e.element_type,
}));

/** A legal lineup from LEGAL_SQUAD_ELEMENTS: GK101; DEF103,104,105,106;
 * MID108,109,110,111; FWD113,114 (11 starters: 1 GK, 4 DEF, 4 MID, 2 FWD).
 * Bench: DEF107, MID112, FWD115, GK102. Captain MID108, vice FWD113. */
function legalLineup(): Pick[] {
  const starters = [101, 103, 104, 105, 106, 108, 109, 110, 111, 113, 114];
  const bench = [107, 112, 115, 102];
  return [
    ...starters.map((element, i) => ({
      element,
      position: i + 1,
      is_captain: element === 108,
      is_vice_captain: element === 113,
    })),
    ...bench.map((element, i) => ({
      element,
      position: 12 + i,
      is_captain: false,
      is_vice_captain: false,
    })),
  ];
}

describe('validateLineup', () => {
  it('accepts a legal lineup with no errors', () => {
    expect(validateLineup(legalLineup(), OWNED)).toEqual([]);
  });

  it('rejects an unowned player in the XI', () => {
    const picks = legalLineup();
    picks[0] = { ...picks[0]!, element: 999999 };
    const errors = validateLineup(picks, OWNED);
    expect(errors.some((e) => e.rule === 'not-owned')).toBe(true);
  });

  it('rejects two captains', () => {
    const picks = legalLineup();
    const secondStarterIndex = picks.findIndex((p) => p.element === 109);
    picks[secondStarterIndex] = { ...picks[secondStarterIndex]!, is_captain: true };
    const errors = validateLineup(picks, OWNED);
    expect(errors.some((e) => e.rule === 'captain-count')).toBe(true);
  });

  it('rejects captain === vice', () => {
    // Make the existing vice-captain (113) the captain too, and clear the
    // original captain (108) so there is exactly one captain and one vice -
    // both the same player.
    const picks = legalLineup().map((p) => {
      if (p.element === 113) return { ...p, is_captain: true };
      if (p.element === 108) return { ...p, is_captain: false };
      return p;
    });
    const errors = validateLineup(picks, OWNED);
    expect(errors.some((e) => e.rule === 'captain-vice-collision')).toBe(true);
  });

  it('rejects an illegal formation (2 GK on the pitch)', () => {
    // Starters: GK101, GK102 (2 GK), DEF103,104,105 (3 DEF), MID108,109,110,111
    // (4 MID), FWD113,114 (2 FWD) = 11 starters. Bench: DEF106,107, MID112, FWD115.
    const starters = [101, 102, 103, 104, 105, 108, 109, 110, 111, 113, 114];
    const bench = [106, 107, 112, 115];
    const picks: Pick[] = [
      ...starters.map((element, i) => ({
        element,
        position: i + 1,
        is_captain: element === 108,
        is_vice_captain: element === 113,
      })),
      ...bench.map((element, i) => ({
        element,
        position: 12 + i,
        is_captain: false,
        is_vice_captain: false,
      })),
    ];
    const errors = validateLineup(picks, OWNED);
    expect(errors.some((e) => e.rule === 'formation')).toBe(true);
  });

  it('rejects a captain marked on the bench', () => {
    // A plausible model mistake: the captain id it names is one it also put
    // on the bench rather than in the starting XI.
    const picks = legalLineup().map((p) => {
      if (p.element === 108) return { ...p, is_captain: false }; // clear the real captain
      if (p.element === 107) return { ...p, is_captain: true }; // 107 is on the bench
      return p;
    });
    const errors = validateLineup(picks, OWNED);
    expect(errors.some((e) => e.rule === 'captain-not-starting')).toBe(true);
  });

  it('rejects a duplicated slot (two players both marked position 9)', () => {
    // Bench player 107 (normally slot 12) is mis-slotted onto starter MID111's
    // slot (9), leaving slot 12 unassigned - both a slot-assignment error and
    // a starter-count error (12 players now read as "starting").
    const picks = legalLineup().map((p) => (p.element === 107 ? { ...p, position: 9 } : p));
    const errors = validateLineup(picks, OWNED);
    expect(errors.some((e) => e.rule === 'slot-assignment')).toBe(true);
    expect(errors.some((e) => e.rule === 'starter-count')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateTransfer
// ---------------------------------------------------------------------------

const TRANSFER_CANDIDATES: TransferCandidate[] = [
  {
    move: { element_in: 201, element_out: 101, purchase_price: 45, selling_price: 40 },
    gain: 3.5,
  },
  {
    move: { element_in: 202, element_out: 102, purchase_price: 50, selling_price: 40 },
    gain: 0,
  },
];

describe('validateTransfer', () => {
  it('accepts a candidate move with positive gain', () => {
    expect(validateTransfer(TRANSFER_CANDIDATES[0]!.move, TRANSFER_CANDIDATES)).toEqual([]);
  });

  it('rejects a transfer not in the candidate list', () => {
    const move: TransferMove = {
      element_in: 999,
      element_out: 998,
      purchase_price: 10,
      selling_price: 10,
    };
    const errors = validateTransfer(move, TRANSFER_CANDIDATES);
    expect(errors.some((e) => e.rule === 'not-a-candidate')).toBe(true);
  });

  it('rejects a transfer with gain <= 0', () => {
    const errors = validateTransfer(TRANSFER_CANDIDATES[1]!.move, TRANSFER_CANDIDATES);
    expect(errors.some((e) => e.rule === 'non-positive-gain')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shortlistContainsLegalSquad
// ---------------------------------------------------------------------------

describe('shortlistContainsLegalSquad', () => {
  it('returns true when the shortlist contains a legal 15', () => {
    expect(shortlistContainsLegalSquad(LEGAL_SQUAD_ELEMENTS, ALL_ELEMENTS)).toBe(true);
  });

  it('returns false when the shortlist has too few of a position', () => {
    // Only 1 GK candidate - 2 are required.
    const shortlist = LEGAL_SQUAD_ELEMENTS.filter((e) => e.id !== 102);
    expect(shortlistContainsLegalSquad(shortlist, ALL_ELEMENTS)).toBe(false);
  });

  it('returns false when every candidate is concentrated in too few clubs', () => {
    // Enough of each position, but every single one is from club1: the
    // 3-per-club cap makes 15 legal picks impossible.
    const shortlist: Element[] = [
      makeElement({ id: 601, element_type: Position.GK, team: 1 }),
      makeElement({ id: 602, element_type: Position.GK, team: 1 }),
      makeElement({ id: 603, element_type: Position.DEF, team: 1 }),
      makeElement({ id: 604, element_type: Position.DEF, team: 1 }),
      makeElement({ id: 605, element_type: Position.DEF, team: 1 }),
      makeElement({ id: 606, element_type: Position.DEF, team: 1 }),
      makeElement({ id: 607, element_type: Position.DEF, team: 1 }),
      makeElement({ id: 608, element_type: Position.MID, team: 1 }),
      makeElement({ id: 609, element_type: Position.MID, team: 1 }),
      makeElement({ id: 610, element_type: Position.MID, team: 1 }),
      makeElement({ id: 611, element_type: Position.MID, team: 1 }),
      makeElement({ id: 612, element_type: Position.MID, team: 1 }),
      makeElement({ id: 613, element_type: Position.FWD, team: 1 }),
      makeElement({ id: 614, element_type: Position.FWD, team: 1 }),
      makeElement({ id: 615, element_type: Position.FWD, team: 1 }),
    ];
    expect(shortlistContainsLegalSquad(shortlist, shortlist)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// repairSquad
// ---------------------------------------------------------------------------

describe('repairSquad', () => {
  it('reports repaired: false when the squad is already legal', () => {
    const result = repairSquad(picksFor(LEGAL_SQUAD_ELEMENTS), [], ALL_ELEMENTS);
    expect(result.repaired).toBe(false);
    expect(validateSquad(result.picks, ALL_ELEMENTS)).toEqual([]);
  });

  it('repairs a 4th player from one club by swapping the cheapest offender', () => {
    // A 4th club1 player, cheaper than club1's other 3 - it must be the one
    // swapped out, for a same-position (MID) replacement offered in `ranked`.
    const cheapestClub1Mid = makeElement({
      id: 507,
      element_type: Position.MID,
      team: 1,
      now_cost: 10,
    });
    const midReplacement = makeElement({
      id: 508,
      element_type: Position.MID,
      team: 9,
      now_cost: 55,
    });
    const elements = LEGAL_SQUAD_ELEMENTS.filter((e) => e.id !== 111).concat(cheapestClub1Mid);
    const ranked = [midReplacement.id, ...LEGAL_SQUAD_ELEMENTS.map((e) => e.id)];
    const universe = [...ALL_ELEMENTS, cheapestClub1Mid, midReplacement];
    const result = repairSquad(picksFor(elements), ranked, universe);
    expect(result.repaired).toBe(true);
    expect(validateSquad(result.picks, universe)).toEqual([]);
  });

  it('repairs a wrong position count by pulling in a next-ranked player of the deficient position', () => {
    // 3 GK, 4 DEF instead of 2 GK, 5 DEF.
    const thirdGk = makeElement({ id: 505, element_type: Position.GK, team: 7, now_cost: 40 });
    const elements = LEGAL_SQUAD_ELEMENTS.filter((e) => e.id !== 107).concat(thirdGk);
    const ranked = [EXTRA_DEF.id, ...LEGAL_SQUAD_ELEMENTS.map((e) => e.id)];
    const universe = [...ALL_ELEMENTS, thirdGk];
    const result = repairSquad(picksFor(elements), ranked, universe);
    expect(result.repaired).toBe(true);
    expect(validateSquad(result.picks, universe)).toEqual([]);
  });

  it('returns repaired: false and the original picks when no legal alternative exists', () => {
    const elements = LEGAL_SQUAD_ELEMENTS.filter((e) => e.id !== 111).concat(FOURTH_CLUB1_MID);
    const result = repairSquad(picksFor(elements), [], ALL_ELEMENTS); // no alternatives ranked
    expect(result.repaired).toBe(false);
    expect(result.picks).toEqual(picksFor(elements));
  });
});

// ---------------------------------------------------------------------------
// Gate calibration - the point of this whole design
// ---------------------------------------------------------------------------

describe('gateDecision - lineup', () => {
  it('PASSES a lineup that differs from the deterministic argmax by one captain choice', () => {
    // A captain swap that costs 7.5 points (e.g. optimum captains a player
    // projected for 12 points, the LLM captains one projected for 8.25 -
    // captain points are doubled, so the swing is 2 * (12 - 8.25) = 7.5)
    // stays under the default 8-point absolute floor and must be accepted.
    const optimalScore = 60;
    const llmScore = optimalScore - 7.5;
    const gate = gateDecision(
      'lineup',
      { score: llmScore, hardViolations: [] },
      { score: optimalScore },
    );
    expect(gate.accept).toBe(true);
    expect(gate.source).toBe('llm');
  });

  it('illustrates why a percentage margin would be wrong here', () => {
    // Same 7.5-point captain swing, on a realistic ~55-point lineup total.
    // The absolute floor (8) still accepts it - even the *squad* margin
    // (10%, generous for a lineup) would not have: 55 * 0.90 = 49.5 > 47.5.
    const optimalScore = 55;
    const llmScore = optimalScore - 7.5;
    const gate = gateDecision(
      'lineup',
      { score: llmScore, hardViolations: [] },
      { score: optimalScore },
    );
    expect(gate.accept).toBe(true);

    const squadStyleMarginThreshold = optimalScore * (1 - 0.1);
    expect(llmScore).toBeLessThan(squadStyleMarginThreshold); // would have failed a % gate
  });

  it('REJECTS a lineup with a hard-signal contradiction regardless of score', () => {
    const gate = gateDecision(
      'lineup',
      { score: 59, hardViolations: ['starter 999 (X) status is "i"'] },
      { score: 60 },
    );
    expect(gate.accept).toBe(false);
    expect(gate.source).toBe('deterministic-gate');
    expect(gate.overrideReason).toContain('hard-signal');
  });

  it('REJECTS a lineup more than the absolute floor below the optimum', () => {
    const gate = gateDecision('lineup', { score: 40, hardViolations: [] }, { score: 60 });
    expect(gate.accept).toBe(false);
    expect(gate.source).toBe('deterministic-gate');
  });
});

describe('gateDecision - squad', () => {
  it('accepts a squad within the default 10% margin', () => {
    const gate = gateDecision('squad', { score: 92 }, { score: 100 });
    expect(gate.accept).toBe(true);
  });

  it('rejects a squad more than the default 10% margin below the optimum', () => {
    const gate = gateDecision('squad', { score: 85 }, { score: 100 });
    expect(gate.accept).toBe(false);
    expect(gate.source).toBe('deterministic-gate');
  });
});

describe('gateDecision - transfer', () => {
  it('accepts a validated transfer', () => {
    const gate = gateDecision('transfer', { transferValid: true }, {});
    expect(gate.accept).toBe(true);
  });

  it('rejects an unvalidated transfer', () => {
    const gate = gateDecision('transfer', { transferValid: false }, {});
    expect(gate.accept).toBe(false);
    expect(gate.source).toBe('deterministic-gate');
  });
});

// ---------------------------------------------------------------------------
// decideSquad retries with the specific violation named - never against the
// real Workers AI binding, via StubProvider.
// ---------------------------------------------------------------------------

/** Builds the `OwnedPlayer[]` a caller would construct by joining a squad's
 * picks against the element pool, so formation/slot-assignment can be
 * checked on whatever squad a test actually produced. */
function ownedFromPicks(picks: Pick[], pool: Element[]): OwnedPlayer[] {
  const byId = new Map(pool.map((e) => [e.id, e] as const));
  return picks.map((p) => ({ element: p.element, position: byId.get(p.element)!.element_type }));
}

describe('decideSquad retry loop', () => {
  it('names the specific violation in the retry prompt, and accepts once the model corrects it', async () => {
    const shortlist: ShortlistEntry[] = LEGAL_SQUAD_ELEMENTS.map((element) => ({
      element,
      clubShortName: `C${element.team}`,
      xpts: 5,
    }));
    const legalIds = LEGAL_SQUAD_ELEMENTS.map((e) => e.id);
    const illegalIds = [...legalIds.slice(0, 14), legalIds[0]]; // duplicate -> 'duplicate-element'

    const provider = new StubProvider([
      { ok: true, text: JSON.stringify({ picks: illegalIds, reason: 'first attempt' }) },
      { ok: true, text: JSON.stringify({ picks: legalIds, reason: 'second attempt' }) },
    ]);
    const budget: NeuronBudget = { remaining: () => 1_000_000, record: () => {} };
    const baseline: DeterministicBaseline = {
      scoreSquad: () => 100,
      scoreLineup: () => 0,
      optimalSquad: () => picksFor(LEGAL_SQUAD_ELEMENTS),
      optimalLineup: () => [],
      fallbackSquad: () => picksFor(LEGAL_SQUAD_ELEMENTS),
      fallbackLineup: () => [],
      fallbackTransfer: () => [],
    };

    const decision = await decideSquad({
      shortlist,
      elements: ALL_ELEMENTS,
      provider,
      budget,
      baseline,
    });

    expect(decision.source).toBe('llm');
    expect(provider.calls).toHaveLength(2);
    // The first call carries no violation note yet.
    expect(provider.calls[0]!.messages[1]!.content).not.toContain('duplicate-element');
    // The retry names the specific rule the first answer broke.
    expect(provider.calls[1]!.messages[1]!.content).toContain('duplicate-element');

    // The returned picks get a placeholder starting formation (decideLineup's
    // job comes later), so they must never read as an illegal formation or a
    // broken slot assignment in the meantime.
    expect(decision.picks).toHaveLength(15);
    const formationErrors = validateLineup(
      decision.picks!,
      ownedFromPicks(decision.picks!, ALL_ELEMENTS),
    ).filter((e) => e.rule === 'formation' || e.rule === 'slot-assignment');
    expect(formationErrors).toEqual([]);
  });

  it('repairs and still returns a well-formed placeholder formation', async () => {
    // A 4th club1 player (cheapest of the 4), with a same-position
    // replacement available in the shortlist - the exact scenario the
    // repairSquad unit tests cover, but driven end to end through decideSquad.
    const cheapestClub1Mid = makeElement({
      id: 507,
      element_type: Position.MID,
      team: 1,
      now_cost: 10,
    });
    const midReplacement = makeElement({
      id: 508,
      element_type: Position.MID,
      team: 9,
      now_cost: 55,
    });
    const pool = [...ALL_ELEMENTS, cheapestClub1Mid, midReplacement];
    const shortlist: ShortlistEntry[] = [...LEGAL_SQUAD_ELEMENTS, midReplacement].map(
      (element) => ({ element, clubShortName: `C${element.team}`, xpts: 5 }),
    );
    const illegalIds = [
      ...LEGAL_SQUAD_ELEMENTS.filter((e) => e.id !== 111).map((e) => e.id),
      cheapestClub1Mid.id,
    ];

    // Every attempt (initial + both retries) returns the same illegal
    // squad, so decideSquad exhausts its retries and falls through to
    // repairSquad.
    const provider = new StubProvider({
      ok: true,
      text: JSON.stringify({ picks: illegalIds, reason: 'stubbornly illegal' }),
    });
    const budget: NeuronBudget = { remaining: () => 1_000_000, record: () => {} };
    const baseline: DeterministicBaseline = {
      scoreSquad: () => 100,
      scoreLineup: () => 0,
      optimalSquad: () => picksFor(LEGAL_SQUAD_ELEMENTS),
      optimalLineup: () => [],
      fallbackSquad: () => picksFor(LEGAL_SQUAD_ELEMENTS),
      fallbackLineup: () => [],
      fallbackTransfer: () => [],
    };

    const decision = await decideSquad({
      shortlist,
      elements: pool,
      provider,
      budget,
      baseline,
    });

    expect(decision.source).toBe('llm-repaired');
    expect(validateSquad(decision.picks!, pool)).toEqual([]);
    const formationErrors = validateLineup(
      decision.picks!,
      ownedFromPicks(decision.picks!, pool),
    ).filter((e) => e.rule === 'formation' || e.rule === 'slot-assignment');
    expect(formationErrors).toEqual([]);
  });
});
