/**
 * UEFA rotation-risk signal (issue #51): name-matching, note-formatting and
 * orchestration for the `europe:` prompt note. Kept out of
 * `src/workflows/decideCommit.ts` on purpose so the matching/formatting
 * logic is unit-testable without any D1/fetch/Workflow plumbing (see
 * test/uefaRotation.test.ts) -- `decideCommit.ts` only ever calls the two
 * exported orchestration functions below.
 */

import { getFixtureAppearances, getRecentFinishedFixturesForTeam } from './api/espn';
import { espnTeamId } from './api/espnTeams';
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

/** How many rest days a UEFA appearance may be behind `now` and still be
 * worth surfacing (issue #69). Roughly one gameweek cycle: past about a
 * week, whatever fatigue or rotation signal the appearance carried has
 * been overtaken by the club's next match(es), so it stops being useful
 * input to a *current* transfer/lineup decision. Deliberately well inside
 * `UEFA_LOOKBACK_DAYS` (14, decideCommit.ts) -- that constant bounds how
 * far back `refreshUefaAppearances` will still *ingest* a fixture, which is
 * a separate concern from how far back a note is worth *showing*. */
export const EUROPE_NOTE_MAX_REST_DAYS = 7;

/** Formats one stored appearance into the compact `europeNote` text
 * (`ShortlistEntry.europeNote`, src/ai/prompts.ts), e.g. `started 90' vs
 * Manchester City (UCL, 3d)` or `hooked 58' vs AC Milan (UEL, 4d)`. Kept to
 * a handful of tokens -- see prompts.ts's own token-density doc comments.
 *
 * Three shapes, driven by `started`/`subbedOffMinute` (issue #69 -- before
 * this, `subbedOffMinute === null` was used to mean "played the full 90",
 * which silently misrepresented a player who was never selected at all as
 * one who started and finished):
 *   - started and never subbed off -> `started <minutesPlayed>'`
 *   - started and subbed off       -> `hooked <subbedOffMinute>'` --
 *     "hooked" is a deliberate word choice distinct from "subbed": the
 *     prompt wording in src/ai/prompts.ts tells the model an early hook on
 *     a STARTER is a selection-risk signal (the manager didn't trust them
 *     to finish), not the same thing as ordinary fatigue from minutes
 *     played.
 *   - never started (came off the bench, or didn't play) -> `sub
 *     <minutesPlayed>'`
 *
 * Returns `null` -- no note at all, rather than a stale or malformed one --
 * when `kickoffTime` doesn't parse, or when it parses but is more than
 * `EUROPE_NOTE_MAX_REST_DAYS` days behind `now`. */
export function formatEuropeNote(
  appearance: {
    competition: string;
    opponent: string;
    started: boolean;
    subbedOffMinute: number | null;
    minutesPlayed: number;
    kickoffTime: string;
  },
  now: Date,
): string | null {
  const kickoffMs = Date.parse(appearance.kickoffTime);
  if (Number.isNaN(kickoffMs)) return null;

  // Clamp negative gaps (a kickoff in the future, or ordinary clock skew) to
  // 0 rather than rendering something like "-1d".
  const restDays = Math.max(0, Math.floor((now.getTime() - kickoffMs) / 86_400_000));
  if (restDays > EUROPE_NOTE_MAX_REST_DAYS) return null;

  let played: string;
  if (!appearance.started) {
    played = `sub ${appearance.minutesPlayed}'`;
  } else if (appearance.subbedOffMinute !== null) {
    played = `hooked ${appearance.subbedOffMinute}'`;
  } else {
    played = `started ${appearance.minutesPlayed}'`;
  }
  return `${played} vs ${appearance.opponent} (${appearance.competition}, ${restDays}d)`;
}

/** Hard ceiling on summary fetches per refresh, across all clubs. Bounds the
 * worst case against the repo's 50-subrequest budget when a backlog builds up
 * -- after the table is cleared, or after a run of provider failures. Skipped
 * fixtures are picked up on the next hourly tick. */
const MAX_SUMMARY_FETCHES_PER_RUN = 8;

/**
 * Refreshes `uefa_appearances` for the clubs present in the current owned
 * squad. Never throws -- any failure at any stage (a club's fixture/summary
 * fetch failing, a D1 read/write failing) degrades to "less signal this
 * cycle", same contract as `fetchRegions`/`espn.ts` elsewhere in this
 * codebase; a failure processing one club never aborts the others. ESPN
 * needs no credential, so there is no "skip entirely" branch.
 *
 * Steps, per DISTINCT club (by `short_name`) among `ownedElements` that
 * `espnTeamId` resolves:
 *   1. `getRecentFinishedFixturesForTeam` since `sinceIso`.
 *   2. For each fixture NOT already fully covered (`hasUefaAppearances`) for
 *      every one of this club's owned elements, `getFixtureAppearances` --
 *      so a fixture already ingested for this whole club roster is never
 *      re-fetched, and never once `MAX_SUMMARY_FETCHES_PER_RUN` summary
 *      fetches have happened this run.
 *   3. Each returned appearance's `playerName` is matched via
 *      `matchElementByName` against ONLY this club's owned elements (never
 *      the whole squad -- a name match is far safer scoped to one club's
 *      handful of players than the whole 15), falling back to
 *      `playerLastName` when the full name misses. Unmatched names are
 *      collected, never guessed.
 *   4. Matched rows are upserted.
 */
export async function refreshUefaAppearances(deps: {
  db: D1Database;
  ownedElements: readonly Element[];
  teams: readonly TeamRow[];
  /** ISO lower bound for "recent" fixtures. Caller's choice of window --
   * see `refreshUefaAppearancesStep` in src/workflows/decideCommit.ts for
   * what it actually passes and why. */
  sinceIso: string;
}): Promise<{ fetched: number; matched: number; unmatched: string[] }> {
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
    if (fetched >= MAX_SUMMARY_FETCHES_PER_RUN) break;
    const teamId = espnTeamId(shortName);
    if (teamId === undefined) continue;

    // Each club's processing is independently best-effort: a thrown D1
    // error (or anything else unexpected) for one club must never discard
    // another club's already-accumulated results.
    try {
      const fixtures = await getRecentFinishedFixturesForTeam(teamId, deps.sinceIso);
      if (fixtures.length === 0) continue;

      const elementIds = clubElements.map((e) => e.id);
      const fixtureIds = fixtures.map((f) => f.fixtureId);
      const cached = await hasUefaAppearances(deps.db, elementIds, fixtureIds);

      for (const fixture of fixtures) {
        const alreadyCovered = elementIds.every((id) => cached.has(`${id}:${fixture.fixtureId}`));
        if (alreadyCovered) continue;

        if (fetched >= MAX_SUMMARY_FETCHES_PER_RUN) break;
        fetched++;
        const appearances = await getFixtureAppearances(fixture, teamId);

        const rows: UefaAppearanceRow[] = [];
        const fetchedAt = new Date().toISOString();
        for (const appearance of appearances) {
          let elementId = matchElementByName(clubElements, appearance.playerName);
          if (elementId === null && appearance.playerLastName) {
            elementId = matchElementByName(clubElements, appearance.playerLastName);
          }
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
 *
 * `formatEuropeNote` can now return `null` (issue #69) when the most recent
 * row is older than `EUROPE_NOTE_MAX_REST_DAYS`. That element still gets NO
 * note -- it must NOT fall through to an older row for the same element,
 * which by definition would be even further past the threshold. The trap:
 * a `seen` set (rather than just checking `notes.has`) is what marks the
 * element as already handled even when nothing was added to `notes`, so a
 * later, older row for that same element can't sneak in and get formatted
 * instead.
 *
 * `now` defaults to `new Date()` so the existing two-argument call site in
 * src/workflows/decideCommit.ts keeps working unchanged.
 */
export async function buildEuropeNotes(
  db: D1Database,
  elementIds: readonly number[],
  now: Date = new Date(),
): Promise<Map<number, string>> {
  const notes = new Map<number, string>();
  if (elementIds.length === 0) return notes;

  try {
    const rows = await getUefaAppearancesForElements(db, elementIds);
    const seen = new Set<number>();
    for (const row of rows) {
      if (seen.has(row.elementId)) continue;
      seen.add(row.elementId);
      const note = formatEuropeNote(row, now);
      if (note !== null) notes.set(row.elementId, note);
    }
    return notes;
  } catch {
    return new Map();
  }
}
