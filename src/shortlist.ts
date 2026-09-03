/**
 * Shortlist construction for the squad/transfer LLM decisions: a
 * budget-friendly subset of the full element pool, small enough to fit a
 * prompt, that is PROVABLY capable of containing a legal 15.
 *
 * ORDERING IS A CORRECTNESS REQUIREMENT (see the task brief):
 *
 *  1. Run `buildSquad` (the deterministic optimizer) FIRST over the WHOLE
 *     candidate pool and union its 15 into the shortlist. A shortlist built
 *     purely by value-per-cost gives NO guarantee any legal 15 exists
 *     inside it -- value-density ranking clusters on cheap players from
 *     strong clubs, exactly where the 3-per-club cap bites. Seeding with
 *     the deterministic optimum makes at least one legal squad provably
 *     present, and costs nothing extra since that optimum is needed for the
 *     squad sanity gate anyway (see `DeterministicBaseline` in
 *     src/ai/decide.ts) -- this module returns it alongside the shortlist
 *     so callers never have to run `buildSquad` twice.
 *  2. Then fill: top ~12 per position by value-per-cost (xpts / now_cost),
 *     plus every currently-owned player, plus every player with non-empty
 *     `news`.
 *  3. Assert `shortlistContainsLegalSquad` before returning. If that ever
 *     fails, it is a bug in THIS construction (not a model failure) --
 *     `buildShortlist` throws `ShortlistInvariantError` rather than
 *     returning a shortlist that could silently send the LLM decision on an
 *     impossible task.
 *
 * Pure function: no D1/fetch/env, arrays and records in, values out.
 */

import {
  buildHorizonScores,
  buildSquad,
  candidatesFromElements,
  type BuildSquadResult,
} from './optimizer/squad';
import { shortlistContainsLegalSquad } from './ai/validate';
import { Position, type Element, type Projection } from './types';

const ALL_POSITIONS = [Position.GK, Position.DEF, Position.MID, Position.FWD] as const;

const DEFAULT_PER_POSITION_TOP_N = 12;

export interface BuildShortlistOptions {
  /** How many top value-per-cost candidates to keep per position beyond the
   * deterministic-optimum seed. Default 12, per the task brief. */
  perPositionTopN?: number;
}

export interface ShortlistResult {
  /** The shortlist: deterministic-optimum seed UNION the per-position fill
   * UNION owned players UNION newsworthy players. Element order is
   * unspecified -- callers sort as needed for prompt-building. */
  shortlist: Element[];
  /** `buildSquad`'s own result over the FULL candidate pool. Callers reuse
   * this directly as the squad gate's deterministic optimum/fallback
   * (`DeterministicBaseline.optimalSquad`/`fallbackSquad`) rather than
   * running `buildSquad` a second time. */
  deterministicSquad: BuildSquadResult;
}

/** Thrown when the shortlist invariant fails: `buildShortlist` could not
 * assemble a shortlist provably containing a legal 15. This is always a
 * construction bug (an empty/near-empty element pool, or a `buildSquad`
 * failure on the full pool), never a model failure -- callers should log
 * this loudly and fall back to the deterministic path rather than ever
 * spending a Neuron on the resulting shortlist. */
export class ShortlistInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShortlistInvariantError';
  }
}

/**
 * Builds the shortlist for one gameweek's squad/transfer decision.
 *
 * @param elements Full element pool (typically every non-removed, selectable
 *   player from `bootstrap-static`, but this function does not filter --
 *   pass whatever pool `buildSquad` should optimise over).
 * @param projections One gameweek's `Projection[]` (the horizon this
 *   shortlist is built for -- typically the next event).
 * @param ownedElementIds Every element id in the currently-owned squad, if
 *   any (empty for a fresh squad build).
 */
export function buildShortlist(
  elements: readonly Element[],
  projections: readonly Projection[],
  ownedElementIds: ReadonlySet<number> = new Set(),
  opts: BuildShortlistOptions = {},
): ShortlistResult {
  const perPositionTopN = opts.perPositionTopN ?? DEFAULT_PER_POSITION_TOP_N;

  const scores = buildHorizonScores([projections], [1]);
  const candidates = candidatesFromElements([...elements], scores);

  // 1. Seed with the deterministic optimum over the WHOLE pool.
  const deterministicSquad = buildSquad(candidates);
  if (!deterministicSquad.feasible || deterministicSquad.picks.length === 0) {
    throw new ShortlistInvariantError(
      'buildShortlist: the deterministic optimizer found no feasible squad in the full element pool -- ' +
        'cannot seed a shortlist that provably contains a legal 15.',
    );
  }

  const elementById = new Map(elements.map((e) => [e.id, e] as const));
  const shortlistIds = new Set<number>(deterministicSquad.picks.map((p) => p.element));

  // 2a. Top ~N per position by value-per-cost.
  const byPosition = new Map<Position, Element[]>();
  for (const position of ALL_POSITIONS) byPosition.set(position, []);
  for (const e of elements) byPosition.get(e.element_type)?.push(e);

  for (const position of ALL_POSITIONS) {
    const list = byPosition.get(position) ?? [];
    const ranked = [...list].sort((a, b) => {
      const valueA = (scores.get(a.id) ?? 0) / Math.max(a.now_cost, 1);
      const valueB = (scores.get(b.id) ?? 0) / Math.max(b.now_cost, 1);
      return valueB - valueA;
    });
    for (const e of ranked.slice(0, perPositionTopN)) shortlistIds.add(e.id);
  }

  // 2b. Every currently-owned player.
  for (const id of ownedElementIds) {
    if (elementById.has(id)) shortlistIds.add(id);
  }

  // 2c. Every player with non-empty news (the free-text signal a numeric
  // model can't read -- see src/ai/prompts.ts's module doc).
  for (const e of elements) {
    if (e.news) shortlistIds.add(e.id);
  }

  const shortlist = [...shortlistIds]
    .map((id) => elementById.get(id))
    .filter((e): e is Element => !!e);

  // 3. The invariant. Must hold by construction (step 1 alone guarantees
  // it), but is asserted explicitly per the task brief rather than trusted.
  if (!shortlistContainsLegalSquad(shortlist, [...elements])) {
    throw new ShortlistInvariantError(
      'buildShortlist: assembled shortlist does not provably contain a legal 15 ' +
        '(shortlistContainsLegalSquad returned false) -- this is a shortlist-construction bug.',
    );
  }

  return { shortlist, deterministicSquad };
}
