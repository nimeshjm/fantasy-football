/**
 * The layer standing between a weak model and irreversible, points-costing
 * writes. Every LLM answer flows through here before it can become a
 * `Decision` (see decide.ts). Nothing in this file trusts the model.
 *
 * ## The sanity gate, and why it is per-decision
 *
 * `gateDecision` is deliberately NOT one global percentage:
 *
 *  - Lineup/captain/subs: the deterministic optimizer computes the EXACT
 *    argmax of the same xPts the gate would score with. Any LLM lineup that
 *    differs is, by definition, below that argmax - one different captain
 *    pick on a 60-point projection can blow past a 15% margin on its own. A
 *    percentage gate here would override the model on essentially every
 *    gameweek and ship something that only *looks* LLM-driven. So the gate
 *    instead checks (a) hard-signal contradictions - a starter with
 *    `status !== 'a'`, an illegal formation - and (b) an ABSOLUTE floor:
 *    reject only if the lineup projects more than `lineupAbsFloor` (default
 *    8) points below the optimum. Disagreeing with the argmax is the
 *    judgment this whole design asks the model for.
 *  - Transfers: must be one of the offered candidates with gain > 0.
 *    Near-automatic, since candidates are pre-filtered.
 *  - Squad creation: irreversible and sets up the season, and the shortlist
 *    provably contains the deterministic optimum (see
 *    `shortlistContainsLegalSquad`), so a percentage gate IS meaningful here
 *    - reject if more than `squadMargin` (default 0.10) below the
 *    deterministic optimum.
 *
 * Whenever the gate fires, the reason is returned so it can be logged and
 * reviewed - frequent lineup overrides mean the gate is miscalibrated, not
 * the model.
 */

import {
  Position,
  RULES,
  type Element,
  type DecisionSource,
  type Pick,
  type TransferMove,
  type ValidationError,
} from '../types';

const ALL_POSITIONS = [Position.GK, Position.DEF, Position.MID, Position.FWD] as const;

function err(rule: string, detail: string): ValidationError {
  return { rule, detail };
}

function elementMap(elements: Element[]): Map<number, Element> {
  const map = new Map<number, Element>();
  for (const el of elements) map.set(el.id, el);
  return map;
}

// ---------------------------------------------------------------------------
// 1. validateSquad
// ---------------------------------------------------------------------------

export function validateSquad(picks: Pick[], elements: Element[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const byId = elementMap(elements);

  // 'squad-size' deliberately stays a SLOT count (picks.length), not a
  // distinct-element count - same treatment as 'squad-size'/'slot-assignment'
  // in validateLineup below: it legitimately polices how many picks the
  // model submitted, and 'duplicate-element' immediately below already
  // reports the case where those slots don't hold distinct ids. What this
  // function's downstream counts (position/club/cost, further down) do need
  // fixing for is a different hole: they were built by iterating `picks`
  // itself, so a duplicated id inflated whichever position/club bucket it
  // fell in and double-charged its cost - the same class of bug that let
  // validateLineup's 'formation' miscount a duplicated starter (see that
  // fix's comment). Fixed below by iterating `seen` (each element id once)
  // instead of `picks`.
  if (picks.length !== RULES.squadSize) {
    errors.push(
      err('squad-size', `squad has ${picks.length} players, expected ${RULES.squadSize}`),
    );
  }

  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const pick of picks) {
    if (seen.has(pick.element)) duplicates.add(pick.element);
    seen.add(pick.element);
  }
  if (duplicates.size > 0) {
    errors.push(err('duplicate-element', `duplicate element id(s): ${[...duplicates].join(', ')}`));
  }

  // Everything below counts DISTINCT owned elements, not picks: iterating
  // `picks` directly (with `seen`, above, deduped) would let a duplicate id
  // count itself twice towards its position/club bucket and towards
  // `totalCost` - the same class of hole `validateLineup`'s 'formation' and
  // 'starter-count' had before this fix (see the long comment there, and
  // the real capture in test/fixtures/workers-ai/json-schema-lineup.json
  // that exposed it). `seen` already holds each pick.element exactly once
  // regardless of how many slots it occupies, so it is the right iteration
  // source for a squad's true composition and true cost.
  const missingIds: number[] = [];
  const unselectable: number[] = [];
  let totalCost = 0;
  const positionCounts = new Map<Position, number>();
  const clubCounts = new Map<number, number>();

  for (const elementId of seen) {
    const element = byId.get(elementId);
    if (!element) {
      missingIds.push(elementId);
      continue;
    }
    if (element.removed || !element.can_select) {
      unselectable.push(elementId);
    }
    totalCost += element.now_cost;
    positionCounts.set(element.element_type, (positionCounts.get(element.element_type) ?? 0) + 1);
    clubCounts.set(element.team, (clubCounts.get(element.team) ?? 0) + 1);
  }

  if (missingIds.length > 0) {
    errors.push(err('unknown-element', `element id(s) not found: ${missingIds.join(', ')}`));
  }
  if (unselectable.length > 0) {
    errors.push(
      err(
        'unselectable-element',
        `removed or non-selectable element id(s): ${unselectable.join(', ')}`,
      ),
    );
  }

  if (totalCost > RULES.budget) {
    errors.push(
      err(
        'budget',
        `total cost ${(totalCost / 10).toFixed(1)}m exceeds budget ${(RULES.budget / 10).toFixed(1)}m`,
      ),
    );
  }

  for (const position of ALL_POSITIONS) {
    const required = RULES.squadSelect[position];
    const actual = positionCounts.get(position) ?? 0;
    if (actual !== required) {
      errors.push(
        err(
          'position-count',
          `position ${Position[position]}: ${actual} selected, expected ${required}`,
        ),
      );
    }
  }

  for (const [team, count] of clubCounts) {
    if (count > RULES.teamLimit) {
      errors.push(
        err('club-limit', `club ${team}: ${count} players selected, max ${RULES.teamLimit}`),
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// 2. validateLineup
// ---------------------------------------------------------------------------

/** An owned squad member's element id and position (GK/DEF/MID/FWD). `Pick`
 * itself doesn't carry position, so callers build this by joining the
 * current 15 (`SquadState.picks`) with their `Element` records. */
export interface OwnedPlayer {
  element: number;
  position: Position;
}

export function validateLineup(picks: Pick[], owned: OwnedPlayer[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const ownedById = new Map(owned.map((o) => [o.element, o] as const));

  if (picks.length !== RULES.squadSize) {
    errors.push(err('squad-size', `lineup has ${picks.length} slots, expected ${RULES.squadSize}`));
  }

  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const pick of picks) {
    if (seen.has(pick.element)) duplicates.add(pick.element);
    seen.add(pick.element);
  }
  if (duplicates.size > 0) {
    errors.push(
      err('duplicate-element', `duplicate element id(s) in lineup: ${[...duplicates].join(', ')}`),
    );
  }

  // Positions 1-15 must each be assigned exactly once.
  const slotCounts = new Map<number, number>();
  for (const pick of picks) {
    slotCounts.set(pick.position, (slotCounts.get(pick.position) ?? 0) + 1);
  }
  for (let slot = 1; slot <= RULES.squadSize; slot++) {
    const count = slotCounts.get(slot) ?? 0;
    if (count !== 1) {
      errors.push(
        err('slot-assignment', `slot ${slot} assigned ${count} time(s), expected exactly 1`),
      );
    }
  }

  // 'starter-count' and 'formation' below both count DISTINCT starting
  // elements, not starting SLOTS ('slot-assignment' above already polices
  // slots). The real Workers AI capture in
  // test/fixtures/workers-ai/json-schema-lineup.json returned 11 starter
  // *slots* with element 302 filling two of them (10 distinct starters) -
  // counting slots, 'starter-count' saw 11 and passed, and 'formation' saw
  // the duplicated MID inflate its bucket to 5 (still inside the legal 2-5
  // range) and passed too. Both rules existed to police exactly this kind
  // of malformation and neither did; only 'duplicate-element' and
  // 'owned-not-used' (element 102, a GK, unused anywhere) rejected that
  // answer, incidentally rather than for the reason each rule's name
  // implies. Counting distinct elements here means 'starter-count' now
  // reports the true number of distinct players starting (10, not 11) and
  // 'formation' reports the true per-position shape of those distinct
  // starters (MID: 4, not 5) - on that capture 'formation' turns out to
  // still pass, because 1 GK/3 DEF/4 MID/2 FWD IS a legal shape; what is
  // wrong is the total headcount, which is exactly 'starter-count's job, not
  // 'formation's. See test/validate.test.ts for a constructed case (a
  // duplicated DEF pushing distinct DEF below the minimum) where 'formation'
  // itself now correctly fires on a duplicate it previously missed.
  const starters = picks.filter((p) => p.position >= 1 && p.position <= RULES.squadPlay);
  const distinctStarterIds = new Set(starters.map((p) => p.element));
  if (distinctStarterIds.size !== RULES.squadPlay) {
    errors.push(
      err(
        'starter-count',
        `${distinctStarterIds.size} distinct starters (positions 1-${RULES.squadPlay} hold ` +
          `${starters.length} slots), expected ${RULES.squadPlay}`,
      ),
    );
  }

  // All players owned: the 15 element ids on `picks` must be exactly the
  // owned 15, no invented players and no owned player left unused.
  const ownedIds = new Set(owned.map((o) => o.element));
  const pickIds = new Set(picks.map((p) => p.element));
  const notOwned = picks.filter((p) => !ownedIds.has(p.element)).map((p) => p.element);
  if (notOwned.length > 0) {
    errors.push(err('not-owned', `element id(s) not in the owned squad: ${notOwned.join(', ')}`));
  }
  const missingOwned = owned.filter((o) => !pickIds.has(o.element)).map((o) => o.element);
  if (missingOwned.length > 0) {
    errors.push(
      err(
        'owned-not-used',
        `owned element id(s) missing from the lineup: ${missingOwned.join(', ')}`,
      ),
    );
  }

  // Formation minima/maxima, computed over DISTINCT starting elements that
  // are owned (an unowned starter is already flagged above). Iterating
  // `distinctStarterIds` rather than `starters` is what makes this an
  // element-based count: iterating `starters` directly would count a
  // duplicated id's slot twice, inflating whichever position it occupies -
  // exactly the miscount that let the fixture's duplicated MID (302, filling
  // two starter slots) read as 5 starting MIDs instead of the true 4.
  const positionCounts = new Map<Position, number>();
  for (const elementId of distinctStarterIds) {
    const ownedPlayer = ownedById.get(elementId);
    if (!ownedPlayer) continue;
    positionCounts.set(ownedPlayer.position, (positionCounts.get(ownedPlayer.position) ?? 0) + 1);
  }
  for (const position of ALL_POSITIONS) {
    const { min, max } = RULES.play[position];
    const count = positionCounts.get(position) ?? 0;
    if (count < min || count > max) {
      errors.push(
        err('formation', `${Position[position]}: ${count} starting, must be ${min}-${max}`),
      );
    }
  }

  const captains = picks.filter((p) => p.is_captain);
  const vices = picks.filter((p) => p.is_vice_captain);
  if (captains.length !== 1) {
    errors.push(err('captain-count', `${captains.length} captain(s) marked, expected exactly 1`));
  }
  if (vices.length !== 1) {
    errors.push(
      err('vice-captain-count', `${vices.length} vice-captain(s) marked, expected exactly 1`),
    );
  }
  if (captains.length === 1 && vices.length === 1 && captains[0]!.element === vices[0]!.element) {
    errors.push(
      err('captain-vice-collision', 'captain and vice-captain must be different players'),
    );
  }
  if (captains.length === 1 && captains[0]!.position > RULES.squadPlay) {
    errors.push(err('captain-not-starting', 'captain must be in the starting XI'));
  }
  if (vices.length === 1 && vices[0]!.position > RULES.squadPlay) {
    errors.push(err('vice-captain-not-starting', 'vice-captain must be in the starting XI'));
  }

  return errors;
}

// ---------------------------------------------------------------------------
// 3. validateTransfer
// ---------------------------------------------------------------------------

/** One pre-validated, budget-checked transfer candidate, with the
 * deterministic model's projected point gain over the planning horizon. */
export interface TransferCandidate {
  move: TransferMove;
  gain: number;
}

export function validateTransfer(
  move: TransferMove,
  candidates: TransferCandidate[],
): ValidationError[] {
  const errors: ValidationError[] = [];
  const match = candidates.find(
    (c) => c.move.element_in === move.element_in && c.move.element_out === move.element_out,
  );
  if (!match) {
    errors.push(
      err(
        'not-a-candidate',
        `transfer (out ${move.element_out}, in ${move.element_in}) was not one of the offered candidates`,
      ),
    );
    return errors; // no matching candidate to check gain against
  }
  if (!(match.gain > 0)) {
    errors.push(err('non-positive-gain', `candidate gain ${match.gain} is not > 0`));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 4. shortlistContainsLegalSquad
// ---------------------------------------------------------------------------

/**
 * PRE-CALL invariant: can this shortlist contain ANY legal 15? If not, that
 * is a bug in shortlist construction (too few of a position, or every
 * candidate concentrated in one or two clubs), not a model failure, and
 * callers MUST check this before spending a single Neuron.
 *
 * This is a greedy cheapest-feasible-squad heuristic, not an exact ILP
 * solver: it fills positions scarcest-slack-first, and within each position
 * takes the cheapest eligible players that don't push any club over the
 * limit. That correctly identifies the common failure modes (too few of a
 * position, one club dominating the shortlist). It can in principle produce
 * a false NEGATIVE (declare infeasible when a cleverer combination would
 * work) in an adversarial shortlist, which is the safe direction to be wrong
 * in for a pre-flight bug check; it never produces a false POSITIVE, because
 * every squad it builds is re-checked with `validateSquad` before returning
 * true.
 */
export function shortlistContainsLegalSquad(shortlist: Element[], elements: Element[]): boolean {
  const byId = elementMap(elements);
  const eligible = shortlist.filter((e) => {
    const canonical = byId.get(e.id) ?? e;
    return !canonical.removed && canonical.can_select;
  });

  const byPosition = new Map<Position, Element[]>();
  for (const position of ALL_POSITIONS) {
    byPosition.set(
      position,
      eligible.filter((e) => e.element_type === position).sort((a, b) => a.now_cost - b.now_cost),
    );
  }

  // Scarcest-first: the position with the least slack (available minus
  // required) is the most likely to be infeasible, so lock it in first while
  // club slots are most free.
  const positions = [...ALL_POSITIONS].sort((a, b) => {
    const slackA = (byPosition.get(a)?.length ?? 0) - RULES.squadSelect[a];
    const slackB = (byPosition.get(b)?.length ?? 0) - RULES.squadSelect[b];
    return slackA - slackB;
  });

  const clubCounts = new Map<number, number>();
  const chosen: Element[] = [];

  for (const position of positions) {
    const required = RULES.squadSelect[position];
    const candidates = byPosition.get(position) ?? [];
    let taken = 0;
    for (const candidate of candidates) {
      if (taken >= required) break;
      const clubCount = clubCounts.get(candidate.team) ?? 0;
      if (clubCount >= RULES.teamLimit) continue;
      chosen.push(candidate);
      clubCounts.set(candidate.team, clubCount + 1);
      taken += 1;
    }
    if (taken < required) return false;
  }

  const totalCost = chosen.reduce((sum, e) => sum + e.now_cost, 0);
  if (totalCost > RULES.budget) return false;

  const picks: Pick[] = chosen.map((e, i) => ({
    element: e.id,
    position: i + 1,
    is_captain: false,
    is_vice_captain: false,
  }));
  return validateSquad(picks, elements).length === 0;
}

// ---------------------------------------------------------------------------
// 5. repairSquad
// ---------------------------------------------------------------------------

/**
 * Minimal repair: for the first rule violation found, swap the cheapest
 * offending player for the next-ranked legal alternative from `ranked`
 * (element ids in caller-preferred order, best first - e.g. by projected
 * xPts), then re-check. Bounded so an unrepairable squad terminates rather
 * than looping.
 *
 * Returns whether it actually repaired the squad into a legal one, so the
 * caller can log `'llm-repaired'` rather than passing the result off as the
 * model's own unassisted choice. On failure, returns the ORIGINAL `picks`
 * unchanged - callers must treat `repaired: false` as a hard failure and
 * fall back to the deterministic squad, never ship a still-illegal result.
 */
export function repairSquad(
  picks: Pick[],
  ranked: number[],
  elements: Element[],
): { picks: Pick[]; repaired: boolean } {
  const byId = elementMap(elements);
  const working = picks.map((p) => ({ ...p }));

  if (validateSquad(working, elements).length === 0) {
    return { picks: working, repaired: false }; // nothing to repair
  }

  const MAX_ITERATIONS = RULES.squadSize * 2;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const errors = validateSquad(working, elements);
    if (errors.length === 0) {
      return { picks: working, repaired: true };
    }
    if (!applyOneRepair(working, errors, ranked, byId)) {
      break; // no repair strategy could make progress
    }
  }

  return { picks, repaired: false };
}

function applyOneRepair(
  working: Pick[],
  errors: ValidationError[],
  ranked: number[],
  byId: Map<number, Element>,
): boolean {
  const rules = new Set(errors.map((e) => e.rule));

  if (rules.has('duplicate-element')) {
    const seen = new Set<number>();
    for (const pick of working) {
      if (seen.has(pick.element)) {
        return replaceOffender(working, pick, ranked, byId);
      }
      seen.add(pick.element);
    }
  }

  if (rules.has('unknown-element') || rules.has('unselectable-element')) {
    const offender = working.find((p) => {
      const el = byId.get(p.element);
      return !el || el.removed || !el.can_select;
    });
    if (offender) return replaceOffender(working, offender, ranked, byId);
  }

  if (rules.has('club-limit')) {
    const clubPicks = new Map<number, Pick[]>();
    for (const pick of working) {
      const el = byId.get(pick.element);
      if (!el) continue;
      const list = clubPicks.get(el.team) ?? [];
      list.push(pick);
      clubPicks.set(el.team, list);
    }
    // Any club already holding `teamLimit` picks is off limits as a source of
    // replacements: swapping into the offending club leaves the count
    // untouched, and swapping into another full club just moves the
    // violation. Without this the loop spins to MAX_ITERATIONS and repair
    // gives up, dropping the decision to the deterministic fallback. It
    // takes a badly over-weighted club to show: a squad-gw2 answer with SIX
    // players from one club failed this way, because the top-ranked
    // same-position candidates were from that same club, while answers with
    // four or five from one club still converged.
    const fullTeams = new Set(
      [...clubPicks.entries()].filter(([, list]) => list.length >= RULES.teamLimit).map(([t]) => t),
    );
    for (const list of clubPicks.values()) {
      if (list.length > RULES.teamLimit) {
        const cheapest = [...list].sort(
          (a, b) => byId.get(a.element)!.now_cost - byId.get(b.element)!.now_cost,
        )[0]!;
        return replaceOffender(working, cheapest, ranked, byId, undefined, fullTeams);
      }
    }
  }

  if (rules.has('position-count')) {
    const byPosition = new Map<Position, Pick[]>();
    for (const pick of working) {
      const el = byId.get(pick.element);
      if (!el) continue;
      const list = byPosition.get(el.element_type) ?? [];
      list.push(pick);
      byPosition.set(el.element_type, list);
    }
    let over: Pick | undefined;
    let underPosition: Position | undefined;
    for (const position of ALL_POSITIONS) {
      const required = RULES.squadSelect[position];
      const list = byPosition.get(position) ?? [];
      if (list.length > required && !over) {
        over = [...list].sort(
          (a, b) => byId.get(a.element)!.now_cost - byId.get(b.element)!.now_cost,
        )[0]!;
      }
      if (list.length < required && underPosition === undefined) {
        underPosition = position;
      }
    }
    if (over && underPosition !== undefined) {
      return replaceOffender(working, over, ranked, byId, underPosition);
    }
  }

  if (rules.has('budget')) {
    const withCost = working
      .map((p) => ({ p, cost: byId.get(p.element)?.now_cost ?? 0 }))
      .sort((a, b) => b.cost - a.cost);
    const mostExpensive = withCost[0]?.p;
    if (mostExpensive) return replaceOffender(working, mostExpensive, ranked, byId);
  }

  return false;
}

/** Replace `offender`'s element in `working` with the next-ranked eligible
 * alternative (same position as `offender`, unless `wantPosition` is given)
 * that is not already in the squad. Mutates `working` in place. */
function replaceOffender(
  working: Pick[],
  offender: Pick,
  ranked: number[],
  byId: Map<number, Element>,
  wantPosition?: Position,
  avoidTeams?: ReadonlySet<number>,
): boolean {
  const offenderElement = byId.get(offender.element);
  const targetPosition = wantPosition ?? offenderElement?.element_type;
  const inSquad = new Set(working.map((p) => p.element));

  for (const candidateId of ranked) {
    if (inSquad.has(candidateId)) continue;
    const candidate = byId.get(candidateId);
    if (!candidate) continue;
    if (candidate.removed || !candidate.can_select) continue;
    if (targetPosition !== undefined && candidate.element_type !== targetPosition) continue;
    if (avoidTeams?.has(candidate.team)) continue;
    offender.element = candidateId;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sanity gate
// ---------------------------------------------------------------------------

export type GateKind = 'squad' | 'lineup' | 'transfer';

export interface GateLlmResult {
  /** Total projected xPts of the LLM's answer, scored under the same
   * deterministic model as `deterministicResult.score` (squad/lineup only). */
  score?: number;
  /** Hard-signal contradictions found in the LLM's answer (lineup only): a
   * starter with `status !== 'a'`, an illegal formation, etc. Any non-empty
   * list here rejects regardless of score. */
  hardViolations?: string[];
  /** Whether the chosen transfer is one of the offered candidates with
   * gain > 0, i.e. `validateTransfer(...).length === 0` (transfer only). */
  transferValid?: boolean;
}

export interface GateDeterministicResult {
  /** Deterministic optimum score (squad/lineup only). */
  score?: number;
}

export interface GateOptions {
  /** Squad: reject if more than this fraction below the deterministic
   * optimum. Default 0.10 (matches `env.SQUAD_MARGIN`). */
  squadMargin?: number;
  /** Lineup: reject only if more than this many points below the
   * deterministic argmax. Default 8 (matches `env.LINEUP_ABS_FLOOR`). */
  lineupAbsFloor?: number;
}

export interface GateResult {
  accept: boolean;
  source: DecisionSource;
  overrideReason?: string;
}

const DEFAULT_SQUAD_MARGIN = 0.1;
const DEFAULT_LINEUP_ABS_FLOOR = 8;

export function gateDecision(
  kind: GateKind,
  llmResult: GateLlmResult,
  deterministicResult: GateDeterministicResult,
  opts: GateOptions = {},
): GateResult {
  switch (kind) {
    case 'squad': {
      const margin = opts.squadMargin ?? DEFAULT_SQUAD_MARGIN;
      const llmScore = llmResult.score ?? 0;
      const detScore = deterministicResult.score ?? 0;
      const threshold = detScore * (1 - margin);
      if (llmScore < threshold) {
        return {
          accept: false,
          source: 'deterministic-gate',
          overrideReason:
            `squad xPts ${llmScore.toFixed(2)} is more than ${(margin * 100).toFixed(0)}% below ` +
            `the deterministic optimum ${detScore.toFixed(2)}`,
        };
      }
      return { accept: true, source: 'llm' };
    }
    case 'lineup': {
      const floor = opts.lineupAbsFloor ?? DEFAULT_LINEUP_ABS_FLOOR;
      const violations = llmResult.hardViolations ?? [];
      if (violations.length > 0) {
        return {
          accept: false,
          source: 'deterministic-gate',
          overrideReason: `lineup has hard-signal contradictions: ${violations.join('; ')}`,
        };
      }
      const llmScore = llmResult.score ?? 0;
      const detScore = deterministicResult.score ?? 0;
      const gap = detScore - llmScore;
      if (gap > floor) {
        return {
          accept: false,
          source: 'deterministic-gate',
          overrideReason:
            `lineup projects ${gap.toFixed(2)} points below the deterministic optimum ` +
            `${detScore.toFixed(2)}, exceeding the ${floor}-point floor`,
        };
      }
      return { accept: true, source: 'llm' };
    }
    case 'transfer': {
      if (!llmResult.transferValid) {
        return {
          accept: false,
          source: 'deterministic-gate',
          overrideReason: 'chosen transfer was not an offered candidate with positive gain',
        };
      }
      return { accept: true, source: 'llm' };
    }
  }
}
