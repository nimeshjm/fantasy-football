/**
 * Opponent-visibility note (issue #69): builds `ShortlistEntry.opponentNote`
 * -- the compact `opp:` prompt fragment (src/ai/prompts.ts) that tells the
 * model WHICH club a player faces and how strong that opponent is. Kept out
 * of `src/workflows/decideCommit.ts` on purpose, same reasoning as
 * `src/uefaRotation.ts`'s module doc: the formatting/orchestration logic is
 * pure and unit-testable without any D1/Workflow plumbing (see
 * test/opponentNote.test.ts) -- `decideCommit.ts` only ever calls
 * `buildOpponentNotesByTeam`, from inside the `project` step where the
 * fixtures/ratings reads already happen.
 *
 * `xpts` (src/model/projection.ts) is ALREADY fixture-adjusted -- it bakes
 * the opponent's attack/defence straight into the expected-points number.
 * The model itself, though, never sees WHICH fixture produced that number,
 * so it can't sanity-check an unusually high/low `xpts`, and can't weigh a
 * `news`/`europe` rotation-risk signal against how hard the upcoming
 * fixture actually is. This module exists purely to make that already-used
 * input visible, not to add a new one.
 */

import type { TeamRow } from './db';
import type { UpcomingFixtureInfo } from './model/projection';
import type { RatingsModel, TeamRating } from './model/ratings';

/** Same fallback `expectedGoals` (src/model/ratings.ts) uses for a team its
 * fit never saw a game for (newly promoted, or simply absent from
 * `ratings.ratings`): neutral 1.0/1.0 rather than throwing or fabricating a
 * number. `ratings.ts` keeps its own copy of this constant module-private,
 * so it's duplicated here rather than imported -- both copies are the same
 * "no evidence -> assume league average" default, just applied at a
 * different call site. */
const NEUTRAL_RATING: TeamRating = { attack: 1, defence: 1 };

/** Resolves a team id to its short name for the note text. Falls back to
 * `#<id>` -- rather than throwing or silently dropping the fixture -- for a
 * team id `teams` doesn't cover; that should never happen in production
 * (every `Fixture.team_h`/`team_a` refers to a real bootstrap-static team),
 * but a stale/short `teams` list in a test or a mid-season data hiccup must
 * degrade to a visibly-odd note, not a thrown error that blocks the whole
 * decision. */
function teamShortName(teams: readonly TeamRow[], teamId: number): string {
  return teams.find((t) => t.id === teamId)?.short_name ?? `#${teamId}`;
}

/**
 * Formats one team's upcoming-fixture note text, e.g.:
 *   - `vs SLB (H) att1.35 concede0.78`
 *   - `vs VSC (A) att0.92 concede1.10, vs CDSC (H) att1.01 concede0.95` (a
 *     double gameweek -- each fixture is rendered and joined with `, `)
 *   - `no fixture` (blank gameweek for this team)
 *
 * `att`/`concede` are read off the OPPONENT's `TeamRating`, not the
 * player's own club -- the `opp:` prefix `formatPlayerLine` adds (src/ai/
 * prompts.ts) is what scopes both numbers to the opponent. `att` is
 * `TeamRating.attack` verbatim. `concede` is deliberately NOT called `def`:
 * `TeamRating.defence` is documented (src/model/ratings.ts) as *defensive
 * weakness* -- above 1.0 concedes MORE than average, below 1.0 concedes
 * FEWER. A field labelled `def` would invite exactly the wrong reading (low
 * number = weak defence); `concede` names the quantity for what it actually
 * measures, so a low number reads as "hard to score against", which is the
 * true direction.
 */
function formatOpponentNote(
  teams: readonly TeamRow[],
  fixtures: readonly UpcomingFixtureInfo[],
  ratings: RatingsModel,
): string {
  if (fixtures.length === 0) return 'no fixture';
  return fixtures
    .map((f) => {
      const oppRating = ratings.ratings.get(f.opponent) ?? NEUTRAL_RATING;
      const venue = f.isHome ? 'H' : 'A';
      return (
        `vs ${teamShortName(teams, f.opponent)} (${venue}) ` +
        `att${oppRating.attack.toFixed(2)} concede${oppRating.defence.toFixed(2)}`
      );
    })
    .join(', ');
}

/**
 * Builds one `opp:` note per team in `teams`, keyed by team id (NOT element
 * id -- see the doc comment at the `project`-step call site in
 * decideCommit.ts for why the carried map is keyed this way).
 *
 * Returns an EMPTY map when `ratings` or `fixturesByTeam` is `undefined`.
 * That's the `ep-next` projection strategy's signature (src/model/
 * projection.ts) -- it never loads either -- and an empty map means no
 * `opp` column appears in the prompt at all (`formatPlayerLine` renders
 * nothing when `opponentNote` is `undefined`). That degradation is
 * deliberate: `ep-next` has no fixture-adjusted `xpts` for the note to
 * cross-check in the first place, so showing an `opp` column there would
 * either require a second, unrelated fixture read just for display, or
 * (worse) render fixtures against ratings the active strategy isn't even
 * using. Never a blocked decision -- same contract as `getEuropeNotes`.
 *
 * Otherwise, one entry per team id in `teams`. A team absent from
 * `fixturesByTeam` (or present with an empty list -- a genuine blank
 * gameweek, see `UpcomingFixtureInfo`'s own doc) gets `'no fixture'`.
 */
export function buildOpponentNotesByTeam(
  teams: readonly TeamRow[],
  fixturesByTeam: ReadonlyMap<number, readonly UpcomingFixtureInfo[]> | undefined,
  ratings: RatingsModel | undefined,
): Map<number, string> {
  const notes = new Map<number, string>();
  if (!ratings || !fixturesByTeam) return notes;

  for (const team of teams) {
    const fixtures = fixturesByTeam.get(team.id) ?? [];
    notes.set(team.id, formatOpponentNote(teams, fixtures, ratings));
  }
  return notes;
}
