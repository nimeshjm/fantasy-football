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
 *  2. Then fill, subject to a hard cap of `RULES.teamLimit` entries per club
 *     (`maxPerClub`): the seed and every currently-owned player go in
 *     unconditionally, then value-per-cost candidates a rank at a time
 *     across positions, weighted by how many of each position a squad
 *     needs, then any newsworthy player a club slot is still free for. The
 *     cap is what makes `club-limit` unviolatable for a squad drawn from
 *     this shortlist - see `BuildShortlistOptions.maxPerClub` for why that
 *     matters and where the guarantee stops.
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
import { Position, RULES, type Element, type Projection } from './types';

const ALL_POSITIONS = [Position.GK, Position.DEF, Position.MID, Position.FWD] as const;

const DEFAULT_PER_POSITION_TOP_N = 12;

export interface BuildShortlistOptions {
  /** How many top value-per-cost candidates to keep per position beyond the
   * deterministic-optimum seed. Default 12, per the task brief. */
  perPositionTopN?: number;
  /**
   * Most shortlist entries any one club may contribute. Defaults to
   * `RULES.teamLimit`, which makes the club limit UNVIOLATABLE for a squad
   * built from this shortlist: a 15 drawn from a pool holding at most 3 of
   * any club cannot break a max-3-per-club rule, whatever the model does.
   *
   * That is the point of it. Across three live eval runs on the flat answer
   * schema the model broke `club-limit` in nearly every squad answer, the
   * retries only sometimes recovered it, and one answer holding six players
   * from a single club defeated `repairSquad` outright. None of that is
   * reachable from a capped shortlist.
   *
   * The seed and owned players are exempt, because dropping either would
   * cost more than the cap buys - the seed is what proves a legal 15 is
   * present at all, and an owned player the model cannot see is one it
   * cannot sell. Both are themselves legal squads and so hold at most 3 of
   * any club, which is why the guarantee survives the exemption for the only
   * caller that matters: the squad-creation path passes no owned players.
   * With a non-empty owned set that disagrees with the seed, the cap becomes
   * best-effort and `validateSquad` is still the backstop.
   */
  maxPerClub?: number;
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
  const maxPerClub = opts.maxPerClub ?? RULES.teamLimit;

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
  const shortlistIds = new Set<number>();
  const perClub = new Map<number, number>();

  const admit = (element: Element): boolean => {
    if (shortlistIds.has(element.id)) return false;
    shortlistIds.add(element.id);
    perClub.set(element.team, (perClub.get(element.team) ?? 0) + 1);
    return true;
  };
  const hasClubRoom = (element: Element): boolean =>
    !shortlistIds.has(element.id) && (perClub.get(element.team) ?? 0) < maxPerClub;

  // 1b. The seed and 2b's owned players go in first and unconditionally, so
  // the cap can only ever bite on the fill below.
  for (const pick of deterministicSquad.picks) {
    const element = elementById.get(pick.element);
    if (element) admit(element);
  }
  for (const id of ownedElementIds) {
    const element = elementById.get(id);
    if (element) admit(element);
  }

  // 2a. Top ~N per position by value-per-cost, taken a rank at a time across
  // all four positions rather than one position to exhaustion. Draining
  // positions in order would hand every slot of the strong clubs to
  // whichever position ran first and leave the later ones drawing on weak
  // clubs alone.
  const byPosition = new Map<Position, Element[]>();
  for (const position of ALL_POSITIONS) byPosition.set(position, []);
  for (const e of elements) byPosition.get(e.element_type)?.push(e);

  const rankedByPosition = new Map<Position, Element[]>();
  for (const position of ALL_POSITIONS) {
    const list = byPosition.get(position) ?? [];
    rankedByPosition.set(
      position,
      [...list].sort((a, b) => {
        const valueA = (scores.get(a.id) ?? 0) / Math.max(a.now_cost, 1);
        const valueB = (scores.get(b.id) ?? 0) / Math.max(b.now_cost, 1);
        return valueB - valueA;
      }),
    );
  }

  // Each round takes `RULES.squadSelect[position]` admissible players per
  // position, so the shortlist ends up shaped like the squad it has to
  // furnish. Taking one per position per round instead gave every position an
  // equal share of the club slots, which measured 13 GK against 10 MID on a
  // 54-player shortlist - 13 candidates for 2 GK slots while the 5 MID slots
  // picked from 10.
  const cursor = new Map<Position, number>(ALL_POSITIONS.map((p) => [p, 0]));
  const admitted = new Map<Position, number>(ALL_POSITIONS.map((p) => [p, 0]));
  for (let progress = true; progress;) {
    progress = false;
    for (const position of ALL_POSITIONS) {
      const ranked = rankedByPosition.get(position) ?? [];
      const quota = perPositionTopN * RULES.squadSelect[position];
      let taken = 0;
      let i = cursor.get(position)!;
      while (taken < RULES.squadSelect[position] && i < ranked.length) {
        if (admitted.get(position)! >= quota) break;
        const candidate = ranked[i]!;
        i++;
        if (!hasClubRoom(candidate)) continue;
        admit(candidate);
        admitted.set(position, admitted.get(position)! + 1);
        taken++;
        progress = true;
      }
      cursor.set(position, i);
    }
  }

  // 2c. Players with non-empty news (the free-text signal a numeric model
  // can't read -- see src/ai/prompts.ts's module doc), but no longer
  // unconditionally: news does not earn a club slot ahead of a better player.
  // A flagged player left out is one the model cannot pick at all, which
  // serves the same end as showing it the note and asking it to steer clear.
  // Any flagged player who does make the shortlist still carries his news
  // verbatim into the prompt.
  for (const e of elements) {
    if (e.news && hasClubRoom(e)) admit(e);
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
