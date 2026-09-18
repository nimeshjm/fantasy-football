/**
 * Best-effort, keyless client for ESPN's public soccer API, the source of the
 * UEFA rotation-risk signal (issue #58, replacing the api-football client
 * whose free plan serves no season after 2024 -- see issue #51).
 *
 * Contract, unchanged from the client this replaces: never throw past this
 * boundary. Every export returns `[]` on ANY failure -- network error,
 * non-200, unparseable body, or a 200 whose shape is not what we expect. A
 * caller iterating several clubs must treat one club's failure as "no signal
 * for this club", never as a reason to abort the others.
 *
 * Everything below was verified against live responses on 2026-09-18, using
 * Benfica (1929) and event 401915586 (Milan 0-2 Benfica, UEL, 2026-09-16).
 * The API is undocumented and carries no stability guarantee, so re-run those
 * two calls before trusting a change to this file.
 */

/** ESPN answers 403 to a browser User-Agent and to no User-Agent at all, and
 * 200 to a non-browser one. Verified from a Worker on the real Cloudflare
 * edge, where the egress address differs from a laptop's -- a local curl
 * proves nothing here. Do not impersonate a browser: that is the one shape
 * that fails. */
export const ESPN_USER_AGENT =
  'fantasy-football-agent/1.0 (+https://github.com/nimeshjm/fantasy-football)';

const BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

/** Mirrors `REQUEST_TIMEOUT_MS` in src/api/client.ts: a hung socket breaks the
 * "always settles" half of the contract as badly as a throw. Not retried. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Minute credited to a player who finishes the match. Knockout ties run to
 * 120, so both minute fields are clamped to this -- `formatEuropeNote` must
 * never print `subbed 113'`. */
export const FULL_MATCH_MINUTES = 90;

export type UefaCompetition = 'UCL' | 'UEL' | 'UECL';

/**
 * The competition label stored in `uefa_appearances.competition` (NOT NULL) is
 * this record's KEY, never a value parsed out of a response body: a fixture is
 * labelled by the slug whose call returned it.
 *
 * This matters more than it looks. A summary fetched under the WRONG slug
 * returns 200 with a body, not an error, so a "try each slug until one works"
 * loop cannot detect its own mistake.
 */
export const ESPN_LEAGUE_SLUGS: Readonly<Record<UefaCompetition, string>> = {
  UCL: 'uefa.champions',
  UEL: 'uefa.europa',
  UECL: 'uefa.europa.conf',
};

export interface UefaFixture {
  /** ESPN's event id, parsed to a number for `fixture_id INTEGER NOT NULL`.
   * A non-numeric id skips the event rather than storing NaN. */
  fixtureId: number;
  competition: UefaCompetition;
  /** Taken from `competitions[0].competitors[]`, as the entry whose `team.id`
   * is not ours -- never parsed out of the `name` string. */
  opponent: string;
  kickoffTime: string;
}

export interface UefaAppearance {
  /** `athlete.fullName`. ESPN sends full names, which is why this provider
   * works with `matchElementByName` at all where api-football did not. */
  playerName: string;
  /**
   * `athlete.lastName`, or `null` when that last name is NOT unique within
   * this club's roster for this fixture.
   *
   * The null case is a safety guard, not an absence of data. Benfica's own
   * roster carries both `Rafa Silva` and `Manu Silva`. If we own one Silva, a
   * bare last-name probe matches the other, because OUR candidate list holds
   * exactly one -- so `matchElementByName`'s ambiguity guard cannot fire. The
   * ambiguity lives on the provider side, so it is resolved here.
   */
  playerLastName: string | null;
  started: boolean;
  /** `null` when the player was not substituted off. Never 0. */
  subbedOffMinute: number | null;
  minutesPlayed: number;
}

/**
 * Finished UEFA fixtures for one club since `sinceIso`, across all three
 * competitions. Three subrequests, one per slug.
 *
 * ESPN's schedule endpoint has no date filter and returns the current season
 * only, so `sinceIso` is applied here rather than by the API. A club that does
 * not play in a given competition returns 0 events, not an error.
 */
export async function getRecentFinishedFixturesForTeam(
  _espnTeamId: number,
  _sinceIso: string,
): Promise<UefaFixture[]> {
  // TODO(#58): implemented in this branch.
  return [];
}

/**
 * Every player from `espnTeamId`'s own roster who appeared in one fixture,
 * with who came off and when. One subrequest.
 *
 * Takes the fixture's competition because the summary URL is per slug, and
 * takes the club id because the response carries both teams.
 *
 * Minutes are derived -- ESPN has no minutes-played field:
 *   starter, stayed on        -> 90
 *   starter, off at M         -> M
 *   on at N, stayed on        -> 90 - N
 *   on at N, off at M         -> M - N
 */
export async function getFixtureAppearances(
  _fixture: Pick<UefaFixture, 'fixtureId' | 'competition'>,
  _espnTeamId: number,
): Promise<UefaAppearance[]> {
  // TODO(#58): implemented in this branch.
  return [];
}

/** Shared low-level GET. Never throws: `null` for a network error, a non-2xx
 * status, or a body that is not valid JSON. Workers' `fetch` handles gzip
 * transparently, so no `Accept-Encoding` header is set by hand. */
export async function espnGet<T>(path: string): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: { 'User-Agent': ESPN_USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
