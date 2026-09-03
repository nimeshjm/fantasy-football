/**
 * The one join helper for turning a squad's `Pick[]` into the
 * `{ element, position }` shape that `validateLineup` (src/ai/validate.ts)
 * and `bestLineup`/`scoreLineup`'s caller (src/optimizer/lineup.ts) need.
 *
 * `Pick` deliberately does not carry `element_type` -- it's a squad-slot
 * record, not a player record -- so formation checking and the exact
 * lineup solve are both structurally unable to run against `SquadState.picks`
 * directly. Skipping this join (passing picks straight through) silently
 * produces an OwnedPlayer list with `position` undefined for every player,
 * which makes every formation check pass or fail meaninglessly rather than
 * erroring loudly -- this is INTEGRATION HAZARD #1 from the task brief.
 *
 * `src/ai/validate.ts`'s `OwnedPlayer` and `src/optimizer/lineup.ts`'s
 * `OwnedPlayer` are structurally identical (`{ element: number; position:
 * Position }`), so one join serves both call sites.
 */

import type { Element, Pick, Position } from './types';

export interface OwnedPlayer {
  element: number;
  position: Position;
}

/**
 * Joins `picks` against `elements` to recover each owned player's position.
 * A pick whose element id has no match in `elements` is dropped rather than
 * throwing -- callers that need "every pick resolved" should check the
 * output length against `picks.length` themselves (this mirrors how
 * `validateSquad`/`validateLineup` report a missing element as a validation
 * error rather than a thrown exception).
 */
export function joinOwnedPlayers(
  picks: readonly Pick[],
  elements: readonly Element[],
): OwnedPlayer[] {
  const byId = new Map(elements.map((e) => [e.id, e] as const));
  const owned: OwnedPlayer[] = [];
  for (const pick of picks) {
    const element = byId.get(pick.element);
    if (!element) continue;
    owned.push({ element: pick.element, position: element.element_type });
  }
  return owned;
}
