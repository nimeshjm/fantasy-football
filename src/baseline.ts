/**
 * Wires the real deterministic optimizer/projection layer
 * (`src/optimizer/lineup.ts`, via `src/ownedPlayers.ts`'s join) into the
 * `DeterministicBaseline` interface `src/ai/decide.ts` depends on.
 *
 * Two integration hazards from the task brief live here:
 *
 *  - HAZARD #1 (the `Pick`/`Element` join): every `bestLineup`/`scoreLineup`
 *    call below goes through `joinOwnedPlayers`, never through raw
 *    `Pick[]` -- see src/ownedPlayers.ts.
 *  - HAZARD #3 (captain doubling): `scoreLineup` here is `import`ed
 *    directly from src/optimizer/lineup.ts, which doubles the captain's
 *    contribution (`CAPTAIN_MULTIPLIER`). Wiring anything else in here would
 *    make the lineup gate's gap always 0 -- see test/workflows.test.ts's
 *    "captain doubling" test.
 */

import { bestLineup, scoreLineup as optimizerScoreLineup } from './optimizer/lineup';
import { joinOwnedPlayers } from './ownedPlayers';
import type { DeterministicBaseline } from './ai/decide';
import type { Element, Pick, Projection, TransferMove } from './types';

/**
 * Deterministic-model xPts total for an arbitrary legal set of 15 picks:
 * recomputes the TRUE best starting XI for those 15 -- ignoring whatever
 * `position`/`is_captain` values happen to already be on the incoming picks
 * -- and scores it with the captain doubled.
 *
 * This is deliberate, not an oversight: a freshly LLM-chosen squad's
 * `Pick.position` values are a fixed PLACEHOLDER split assigned by
 * `assignSquadFormation` in decide.ts (HAZARD #2), not the best-scoring
 * formation for that particular 15. Recomputing the best XI here, rather
 * than trusting the incoming split, makes the squad gate compare "the best
 * this 15 could do" against "the best the deterministic optimum could do" --
 * independent of either side's placeholder formation.
 */
function scoreSquadDeterministically(
  picks: readonly Pick[],
  elements: readonly Element[],
  projections: readonly Projection[],
): number {
  const owned = joinOwnedPlayers(picks, elements);
  if (owned.length < picks.length) return 0; // an unresolvable element id -- treat as worthless, never throw
  try {
    const lineup = bestLineup(owned, projections);
    return optimizerScoreLineup(lineup, projections);
  } catch {
    // bestLineup throws only when no legal formation fits the given owned
    // players. Shouldn't happen for anything that already passed
    // validateSquad's position-count check, but a baseline scoring function
    // must never throw past the workflow boundary -- fail to the worst
    // possible score instead of propagating.
    return 0;
  }
}

/** Baseline for `decideSquad`: `optimalPicks` is the deterministic
 * optimizer's own answer over the full candidate pool (reuse
 * `shortlist.ts`'s `ShortlistResult.deterministicSquad.picks` -- never
 * re-run `buildSquad` a second time for the same decision). */
export function makeSquadBaseline(
  elements: readonly Element[],
  projections: readonly Projection[],
  optimalPicks: Pick[],
): DeterministicBaseline {
  const optimalOwned = joinOwnedPlayers(optimalPicks, elements);
  const optimalLineupPicks = bestLineup(optimalOwned, projections);
  return {
    scoreSquad: (picks) => scoreSquadDeterministically(picks, elements, projections),
    scoreLineup: (picks) => optimizerScoreLineup(picks, projections),
    optimalSquad: () => optimalPicks,
    optimalLineup: () => optimalLineupPicks,
    fallbackSquad: () => optimalPicks,
    fallbackLineup: () => optimalLineupPicks,
    fallbackTransfer: () => [],
  };
}

/** Baseline for `decideLineup`: `ownedPicks` is the 15 the lineup is being
 * chosen from (the just-decided squad, whatever its source). */
export function makeLineupBaseline(
  elements: readonly Element[],
  projections: readonly Projection[],
  ownedPicks: Pick[],
): DeterministicBaseline {
  const owned = joinOwnedPlayers(ownedPicks, elements);
  const optimal = bestLineup(owned, projections);
  return {
    scoreSquad: (picks) => scoreSquadDeterministically(picks, elements, projections),
    scoreLineup: (picks) => optimizerScoreLineup(picks, projections),
    optimalSquad: () => ownedPicks,
    optimalLineup: () => optimal,
    fallbackSquad: () => ownedPicks,
    fallbackLineup: () => optimal,
    fallbackTransfer: () => [],
  };
}

/** Baseline for `decideTransfer`: only `fallbackTransfer` is ever called by
 * `decide.ts`'s `decideTransfer`, but every method must be implemented to
 * satisfy `DeterministicBaseline`. */
export function makeTransferBaseline(
  elements: readonly Element[],
  projections: readonly Projection[],
  ownedPicks: Pick[],
  fallbackMove: TransferMove[],
): DeterministicBaseline {
  const owned = joinOwnedPlayers(ownedPicks, elements);
  const optimal = bestLineup(owned, projections);
  return {
    scoreSquad: (picks) => scoreSquadDeterministically(picks, elements, projections),
    scoreLineup: (picks) => optimizerScoreLineup(picks, projections),
    optimalSquad: () => ownedPicks,
    optimalLineup: () => optimal,
    fallbackSquad: () => ownedPicks,
    fallbackLineup: () => optimal,
    fallbackTransfer: () => fallbackMove,
  };
}
