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

interface RawScheduleEvent {
  id?: string;
  date?: string;
  competitions?: Array<{
    status?: { type?: { name?: string } };
    competitors?: Array<{ team?: { id?: string; displayName?: string } }>;
  }>;
}

interface RawSchedule {
  events?: RawScheduleEvent[];
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
  espnTeamId: number,
  sinceIso: string,
): Promise<UefaFixture[]> {
  const sinceMs = Date.parse(sinceIso);

  const perSlug = await Promise.all(
    (Object.entries(ESPN_LEAGUE_SLUGS) as [UefaCompetition, string][]).map(
      async ([competition, slug]) => {
        try {
          const body = await espnGet<RawSchedule>(`/${slug}/teams/${espnTeamId}/schedule`);
          const events = body?.events;
          if (!Array.isArray(events)) return [];

          const fixtures: UefaFixture[] = [];
          for (const event of events) {
            if (event?.competitions?.[0]?.status?.type?.name !== 'STATUS_FULL_TIME') continue;

            // A NaN sinceMs (unparseable sinceIso) must keep NOTHING: NaN
            // fails every comparison, so this filters everything out rather
            // than nothing, which is what a naive "kickoffMs >= sinceMs"
            // would do if kickoffMs happened to be NaN too.
            const kickoffMs = Date.parse(event?.date ?? '');
            if (!Number.isFinite(kickoffMs) || !Number.isFinite(sinceMs)) continue;
            if (kickoffMs < sinceMs) continue;

            const fixtureId = Number(event?.id);
            if (!Number.isFinite(fixtureId) || !Number.isInteger(fixtureId)) continue;

            const competitors = event.competitions[0]?.competitors;
            const opponentEntry = Array.isArray(competitors)
              ? competitors.find((c) => String(c?.team?.id) !== String(espnTeamId))
              : undefined;
            const opponent = opponentEntry?.team?.displayName;
            if (!opponent) continue;

            fixtures.push({ fixtureId, competition, opponent, kickoffTime: event.date ?? '' });
          }
          return fixtures;
        } catch {
          return [];
        }
      },
    ),
  );

  const merged = new Map<number, UefaFixture>();
  for (const fixtures of perSlug) {
    for (const fixture of fixtures) merged.set(fixture.fixtureId, fixture);
  }
  return [...merged.values()];
}

interface RawAthlete {
  id?: string;
  fullName?: string;
  lastName?: string;
}

interface RawRosterEntry {
  starter?: boolean;
  subbedIn?: boolean;
  subbedOut?: boolean;
  athlete?: RawAthlete;
}

interface RawRosterTeam {
  team?: { id?: string };
  roster?: RawRosterEntry[];
}

interface RawKeyEvent {
  type?: { type?: string };
  clock?: { value?: number; displayValue?: string };
  participants?: Array<{ athlete?: { id?: string } }>;
}

interface RawSummary {
  rosters?: RawRosterTeam[];
  keyEvents?: RawKeyEvent[];
}

/** `clock.value` is in seconds; ESPN has no whole-minutes field. Falls back
 * to the digits in `clock.displayValue` (e.g. "70'") on the rare event that
 * carries a display string but no numeric clock. `null` when neither yields
 * a number, so the caller omits rather than fabricates. */
function parseEventMinute(clock: RawKeyEvent['clock']): number | null {
  if (typeof clock?.value === 'number' && Number.isFinite(clock.value)) {
    return Math.ceil(clock.value / 60);
  }
  const match = clock?.displayValue?.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

/** League-phase matches don't go to extra time, so minutes are clamped to
 * `FULL_MATCH_MINUTES` rather than the 120 a knockout tie could reach --
 * stoppage time (e.g. clock 90'+5') must never surface as "subbed 95'". */
function clampMinute(minute: number): number {
  return Math.min(FULL_MATCH_MINUTES, Math.max(0, minute));
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
/** Key for the last-name collision count below. It must be at least as
 * aggressive as `matchElementByName`'s own normalization in
 * src/uefaRotation.ts -- that matcher strips diacritics, so two roster names
 * differing only by an accent WOULD both match one owned element while
 * looking distinct here, which is precisely the wrong-attribution the count
 * exists to prevent. */
function collisionKey(name: string | undefined): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getFixtureAppearances(
  fixture: Pick<UefaFixture, 'fixtureId' | 'competition'>,
  espnTeamId: number,
): Promise<UefaAppearance[]> {
  try {
    const slug = ESPN_LEAGUE_SLUGS[fixture.competition];
    if (!slug) return [];

    const body = await espnGet<RawSummary>(`/${slug}/summary?event=${fixture.fixtureId}`);
    const rosters = body?.rosters;
    if (!Array.isArray(rosters)) return [];

    const teamRoster = rosters.find((r) => String(r?.team?.id) === String(espnTeamId));
    const roster = teamRoster?.roster;
    if (!Array.isArray(roster)) return [];

    // Substitution minutes, keyed by the athlete.id of whoever came ON
    // (participants[0]) or OFF (participants[1]) in that event -- the join
    // key everywhere below. Never matched by name: the same payload has been
    // seen spelling one player differently in its own free-text fields.
    const onMinuteByAthleteId = new Map<string, number>();
    const offMinuteByAthleteId = new Map<string, number>();
    const keyEvents = Array.isArray(body?.keyEvents) ? body.keyEvents : [];
    for (const event of keyEvents) {
      if (event?.type?.type !== 'substitution') continue;
      const minute = parseEventMinute(event.clock);
      if (minute === null) continue;

      const onId = event.participants?.[0]?.athlete?.id;
      const offId = event.participants?.[1]?.athlete?.id;
      if (onId != null && !onMinuteByAthleteId.has(onId)) onMinuteByAthleteId.set(onId, minute);
      if (offId != null && !offMinuteByAthleteId.has(offId))
        offMinuteByAthleteId.set(offId, minute);
    }

    // Last-name collision guard, counted across the WHOLE roster (starters,
    // used subs, and unused subs alike) -- Benfica's real squad carries both
    // "Rafa Silva" and "Manu Silva".
    const lastNameCounts = new Map<string, number>();
    for (const entry of roster) {
      const lastName = collisionKey(entry?.athlete?.lastName);
      if (!lastName) continue;
      lastNameCounts.set(lastName, (lastNameCounts.get(lastName) ?? 0) + 1);
    }

    const appearances: UefaAppearance[] = [];
    for (const entry of roster) {
      const athlete = entry?.athlete;
      const athleteId = athlete?.id;
      if (!athlete?.fullName || athleteId == null) continue;

      const starter = entry?.starter === true;
      const subbedIn = entry?.subbedIn === true;
      const subbedOut = entry?.subbedOut === true;
      if (!starter && !subbedIn) continue; // unused substitute

      let onMinute: number | null = null;
      if (subbedIn) {
        onMinute = onMinuteByAthleteId.get(athleteId) ?? null;
        if (onMinute === null) continue; // claimed subbedIn, no matching event -- omit
      }

      let offMinute: number | null = null;
      if (subbedOut) {
        offMinute = offMinuteByAthleteId.get(athleteId) ?? null;
        if (offMinute === null) continue; // claimed subbedOut, no matching event -- omit
      }

      let minutesPlayed: number;
      if (subbedIn && subbedOut) {
        minutesPlayed = offMinute! - onMinute!;
      } else if (subbedIn) {
        minutesPlayed = FULL_MATCH_MINUTES - onMinute!;
      } else if (subbedOut) {
        minutesPlayed = offMinute!;
      } else {
        minutesPlayed = FULL_MATCH_MINUTES;
      }

      const lastNameKey = collisionKey(athlete.lastName);
      const playerLastName =
        athlete.lastName && lastNameKey && (lastNameCounts.get(lastNameKey) ?? 0) <= 1
          ? athlete.lastName
          : null;

      appearances.push({
        playerName: athlete.fullName,
        playerLastName,
        started: starter,
        subbedOffMinute: subbedOut ? clampMinute(offMinute!) : null,
        minutesPlayed: clampMinute(minutesPlayed),
      });
    }

    return appearances;
  } catch {
    return [];
  }
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
