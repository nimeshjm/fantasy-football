/**
 * UEFA rotation-risk signal (issue #51): name-matching, note-formatting and
 * orchestration for the `europe:` prompt note. Kept out of
 * `src/workflows/decideCommit.ts` on purpose so the matching/formatting
 * logic is unit-testable without any D1/fetch/Workflow plumbing (see
 * test/uefaRotation.test.ts) -- `decideCommit.ts` only ever calls the two
 * exported orchestration functions below.
 */

import {
  getFixtureSubstitutions,
  getRecentFinishedFixturesForTeam,
  type ApiFootballAppearance,
} from './api/apiFootball';
import { apiFootballTeamId } from './api/apiFootballTeams';
import {
  getUefaAppearancesForElements,
  hasUefaAppearances,
  upsertUefaAppearances,
} from './db/uefaAppearances';
import type { TeamRow, UefaAppearanceRow } from './db/types';
import type { Element } from './types';

/** Lowercases, strips diacritics (NFD-decompose then drop combining marks --
 * e.g. "João" -> "joao") and strips punctuation, collapsing whitespace.
 * Both sides of a name comparison go through this before being compared, so
 * "João Mário" and "Joao Mario" (or "Joao-Mario") normalize identically. */
function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Matches one API-Football `playerName` against a club's own owned
 * elements. API-Football's player ids don't share an id space with this
 * project's `element.id` (issue #51's flagged open risk), so this is a
 * NAME match, and deliberately a narrow one:
 *
 *   1. Exact normalized `first_name + " " + second_name"` equality.
 *   2. Falling back to exact normalized `web_name` equality (API-Football
 *      sometimes reports just a short/display name, matching how this
 *      site's own `web_name` tends to work for these players).
 *
 * NEVER a fuzzy/partial match beyond that. An unmatched name -- zero
 * candidates agree, OR more than one candidate normalizes to the same
 * name at either step (ambiguous) -- returns `null` rather than guessing:
 * the caller logs/skips it, so a missed match just means no `europe:` note
 * for that player this cycle, never a note attached to the wrong player.
 */
export function matchElementByName(
  candidates: readonly {
    id: number;
    web_name: string;
    first_name?: string;
    second_name?: string;
  }[],
  apiFootballName: string,
): number | null {
  const target = normalizeName(apiFootballName);
  if (!target) return null;

  const fullNameMatches = candidates.filter(
    (c) =>
      c.first_name && c.second_name && normalizeName(`${c.first_name} ${c.second_name}`) === target,
  );
  if (fullNameMatches.length === 1) return fullNameMatches[0]!.id;
  if (fullNameMatches.length > 1) return null;

  const webNameMatches = candidates.filter((c) => normalizeName(c.web_name) === target);
  if (webNameMatches.length === 1) return webNameMatches[0]!.id;
  return null;
}

/** Formats one stored appearance into the compact `europeNote` text
 * (`ShortlistEntry.europeNote`, src/ai/prompts.ts), e.g. `subbed 61' vs
 * Milan (UEL)` or `played 90' vs Milan (UEL)`. Kept to a handful of tokens
 * -- see prompts.ts's own token-density doc comments -- by never spelling
 * out the date or the full competition name. */
export function formatEuropeNote(appearance: {
  competition: string;
  opponent: string;
  subbedOffMinute: number | null;
  minutesPlayed: number;
}): string {
  const played =
    appearance.subbedOffMinute != null
      ? `subbed ${appearance.subbedOffMinute}'`
      : `played ${appearance.minutesPlayed}'`;
  return `${played} vs ${appearance.opponent} (${appearance.competition})`;
}

/**
 * Refreshes `uefa_appearances` for the clubs present in the current owned
 * squad. Never throws -- any failure at any stage (missing key, a club's
 * fixture/substitution fetch failing, a D1 read/write failing) degrades to
 * "less signal this cycle", same contract as `fetchRegions`/`apiFootball.ts`
 * elsewhere in this codebase; a failure processing one club never aborts
 * the others.
 *
 * Steps, per DISTINCT club (by `short_name`) among `ownedElements` that
 * `apiFootballTeamId` resolves:
 *   1. `getRecentFinishedFixturesForTeam` since `sinceIso`.
 *   2. For each fixture NOT already fully covered (`hasUefaAppearances`) for
 *      every one of this club's owned elements, `getFixtureSubstitutions`
 *      -- so a fixture already ingested for this whole club roster is never
 *      re-fetched.
 *   3. Each returned appearance's `playerName` is matched via
 *      `matchElementByName` against ONLY this club's owned elements (never
 *      the whole squad -- a name match is far safer scoped to one club's
 *      handful of players than the whole 15). Unmatched names are
 *      collected, never guessed.
 *   4. Matched rows are upserted.
 */
export async function refreshUefaAppearances(deps: {
  db: D1Database;
  /** `Env.API_FOOTBALL_KEY` -- absent is normal (no key provisioned yet),
   * not an error. Skips entirely, returning zero counts, without touching
   * D1 or the network at all. */
  apiKey: string | undefined;
  ownedElements: readonly Element[];
  teams: readonly TeamRow[];
  /** ISO lower bound for "recent" fixtures. Caller's choice of window --
   * see `refreshUefaAppearancesStep` in src/workflows/decideCommit.ts for
   * what it actually passes and why. */
  sinceIso: string;
}): Promise<{ fetched: number; matched: number; unmatched: string[] }> {
  const zero = { fetched: 0, matched: 0, unmatched: [] as string[] };
  if (!deps.apiKey) return zero;
  const apiKey = deps.apiKey;

  const teamById = new Map(deps.teams.map((t) => [t.id, t] as const));
  const elementsByClub = new Map<string, Element[]>();
  for (const element of deps.ownedElements) {
    const team = teamById.get(element.team);
    if (!team) continue;
    const list = elementsByClub.get(team.short_name);
    if (list) {
      list.push(element);
    } else {
      elementsByClub.set(team.short_name, [element]);
    }
  }

  let fetched = 0;
  let matched = 0;
  const unmatched: string[] = [];

  for (const [shortName, clubElements] of elementsByClub) {
    const apiTeamId = apiFootballTeamId(shortName);
    if (apiTeamId === undefined) continue;

    // Each club's processing is independently best-effort: a thrown D1
    // error (or anything else unexpected) for one club must never discard
    // another club's already-accumulated results.
    try {
      const fixtures = await getRecentFinishedFixturesForTeam(apiKey, apiTeamId, deps.sinceIso);
      if (fixtures.length === 0) continue;

      const elementIds = clubElements.map((e) => e.id);
      const fixtureIds = fixtures.map((f) => f.fixtureId);
      const cached = await hasUefaAppearances(deps.db, elementIds, fixtureIds);

      for (const fixture of fixtures) {
        const alreadyCovered = elementIds.every((id) => cached.has(`${id}:${fixture.fixtureId}`));
        if (alreadyCovered) continue;

        fetched++;
        const appearances: ApiFootballAppearance[] = await getFixtureSubstitutions(
          apiKey,
          fixture.fixtureId,
        );

        const rows: UefaAppearanceRow[] = [];
        const fetchedAt = new Date().toISOString();
        for (const appearance of appearances) {
          const elementId = matchElementByName(clubElements, appearance.playerName);
          if (elementId === null) {
            unmatched.push(appearance.playerName);
            continue;
          }
          matched++;
          rows.push({
            elementId,
            fixtureId: fixture.fixtureId,
            competition: fixture.competition,
            opponent: fixture.opponent,
            kickoffTime: fixture.kickoffTime,
            started: appearance.started,
            subbedOffMinute: appearance.subbedOffMinute,
            minutesPlayed: appearance.minutesPlayed,
            fetchedAt,
          });
        }
        if (rows.length > 0) await upsertUefaAppearances(deps.db, rows);
      }
    } catch {
      continue;
    }
  }

  return { fetched, matched, unmatched };
}

/**
 * Reads back the single most-recent UEFA appearance per element (issue
 * #51), formatted for `ShortlistEntry.europeNote`. `getUefaAppearancesForElements`
 * already orders most-recent kickoff first, so the first row seen per
 * `elementId` is kept and any later ones for that element are ignored.
 * Never throws -- an unreadable D1 row set degrades to an empty map, i.e.
 * no `europe:` notes this cycle, never a blocked decision.
 */
export async function buildEuropeNotes(
  db: D1Database,
  elementIds: readonly number[],
): Promise<Map<number, string>> {
  const notes = new Map<number, string>();
  if (elementIds.length === 0) return notes;

  try {
    const rows = await getUefaAppearancesForElements(db, elementIds);
    for (const row of rows) {
      if (notes.has(row.elementId)) continue;
      notes.set(row.elementId, formatEuropeNote(row));
    }
    return notes;
  } catch {
    return new Map();
  }
}
