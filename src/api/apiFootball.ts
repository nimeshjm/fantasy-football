/**
 * Best-effort, optional client for api-football.com (v3), used only to
 * derive the UEFA rotation-risk signal (issue #51 -- see
 * migrations/0005_uefa_appearances.sql and Env.API_FOOTBALL_KEY's doc
 * comment in src/env.ts). Auth is a single header, `x-apisports-key`.
 *
 * DORMANT (issue #58): kept in the tree, unwired, as an escape hatch. The
 * free plan only exposes seasons 2022-2024 ("Free plans do not have access
 * to this season, try from 2022 to 2024."), so it cannot serve the current
 * season. The live rotation-risk signal now runs on src/api/espn.ts. A
 * second, independent blocker if this is ever revived: `/fixtures/lineups`
 * returns abbreviated names (e.g. "A. Trubin"), which the exact matcher in
 * src/uefaRotation.ts cannot match -- ESPN returns full names, which is why
 * it replaced this client. Usable again the moment a paid plan is in place.
 *
 * Contract, mirrored from `DecisionCoreDeps.fetchRegions` in
 * src/workflows/decideCommit.ts: this is an OPTIONAL port that must never
 * throw past its own boundary. Every exported function returns `null`/`[]`
 * on ANY failure -- network error, non-200, unparseable/non-JSON body, or a
 * 200 that carries API-Football's own `errors` payload (bad key, quota
 * exceeded) instead of real data. A caller iterating several clubs' fixtures
 * must be able to treat one club's failure as "no signal for this club",
 * never as a reason to abort the others.
 *
 * Each exported call costs one or more subrequests against the Workers
 * per-invocation subrequest cap (see endpoints.ts's `getEventLive` doc
 * comment for why that cap matters here too):
 *   - getRecentFinishedFixturesForTeam: 3 subrequests per club (one per
 *     UEFA competition), so N clubs costs 3N.
 *   - getFixtureSubstitutions: 2 subrequests per fixture (events + lineups).
 * Budget accordingly in whatever workflow step calls these in a loop. The
 * free tier is also rate-limited per minute -- API-Football's own docs
 * quote 10 req/min on the free plan -- so a caller fanning this out over
 * many clubs/fixtures in one tick should expect to serialize or throttle,
 * not fire everything in parallel.
 */

const BASE_URL = 'https://v3.football.api-sports.io';

/**
 * Per-request timeout, mirrored from `REQUEST_TIMEOUT_MS` in src/api/
 * client.ts: without a deadline, a hung socket would never resolve at all,
 * which breaks the "never throws, always returns null/[]" contract just as
 * badly as an actual throw would -- a caller iterating several clubs'
 * fixtures needs every call to SETTLE, not merely to settle safely when it
 * does. Unlike client.ts, a timeout here is NOT retried: this client has no
 * retry loop at all, so a timeout is just another best-effort miss, handled
 * by the same catch block as any other network failure.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * UEFA club competition league ids, as api-football.com defines them.
 *
 * Confirmed live via a keyed `/leagues?search=UEFA` call on 2026-09-18:
 * 2 = UEFA Champions League, 3 = UEFA Europa League, 848 = UEFA Europa
 * Conference League.
 */
export const UEFA_LEAGUE_IDS = {
  UCL: 2,
  UEL: 3,
  UECL: 848,
} as const;

export interface ApiFootballFixture {
  fixtureId: number;
  competition: 'UCL' | 'UEL' | 'UECL';
  /** Opponent's team name, as returned by the API. */
  opponent: string;
  /** ISO kickoff time, as returned by the API's `fixture.date`. */
  kickoffTime: string;
}

export interface ApiFootballAppearance {
  /** As returned by the API -- matching to our element_id happens
   * elsewhere, not this client's job. */
  playerName: string;
  started: boolean;
  /** `null` if the player was not subbed off (played to the final whistle,
   * or never started). Never 0 for "not subbed off" -- 0 would misread as
   * "subbed off in minute zero". */
  subbedOffMinute: number | null;
  minutesPlayed: number;
}

/** The generic envelope every api-football.com v3 endpoint returns. A 200
 * response can still carry an `errors` payload instead of real data (bad
 * key, quota exceeded, invalid parameter) -- that is treated as a failure,
 * same as a non-200 status or a network error. `errors` is documented as an
 * object keyed by parameter name, but has been seen returned as an empty
 * array on success, so both shapes are checked for actual content. */
interface ApiFootballEnvelope<T> {
  response: T[];
  errors?: unknown[] | Record<string, unknown>;
}

function hasErrors(errors: ApiFootballEnvelope<unknown>['errors']): boolean {
  if (!errors) return false;
  if (Array.isArray(errors)) return errors.length > 0;
  return Object.keys(errors).length > 0;
}

/** Single low-level GET, shared by both exported calls. Never throws --
 * returns `null` for a network error, a non-2xx status, a body that isn't
 * valid JSON, a body whose `errors` carries content, or a `response` that
 * isn't the array every real success response returns it as. */
async function apiFootballGet<T>(
  apiKey: string,
  path: string,
  query: Record<string, string | number>,
): Promise<T[] | null> {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { 'x-apisports-key': apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let body: ApiFootballEnvelope<T>;
  try {
    body = (await response.json()) as ApiFootballEnvelope<T>;
  } catch {
    return null;
  }

  if (hasErrors(body?.errors)) return null;
  if (!Array.isArray(body?.response)) return null;
  return body.response;
}

interface RawFixtureStatus {
  short: string;
}

interface RawFixtureTeam {
  id: number;
  name: string;
}

interface RawFixtureItem {
  fixture: { id: number; date: string; status: RawFixtureStatus };
  teams: { home: RawFixtureTeam; away: RawFixtureTeam };
}

/**
 * Finished (`status=FT`) fixtures for one club across all three UEFA club
 * competitions since `sinceIso`, merged into one list. Three subrequests
 * (one per competition in UEFA_LEAGUE_IDS) -- see this module's doc comment
 * for the budgeting implication of calling this per club.
 *
 * `status=FT` is passed to the API AND re-checked on every returned row:
 * an in-progress or postponed match has no final substitution picture yet,
 * and defending against the API ignoring/loosening the filter costs
 * nothing.
 */
export async function getRecentFinishedFixturesForTeam(
  apiKey: string,
  apiFootballTeamId: number,
  sinceIso: string,
): Promise<ApiFootballFixture[]> {
  const from = sinceIso.slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  // API-Football requires `season`, the campaign's start year: a European
  // season runs July-May, so a month >= 7 belongs to the campaign starting
  // that year, and a month < 7 belongs to the one that started the year
  // before. Derived from `sinceIso`, not a fresh clock read, so it stays
  // consistent with the window being queried.
  const sinceDate = new Date(sinceIso);
  const season =
    sinceDate.getUTCMonth() + 1 >= 7 ? sinceDate.getUTCFullYear() : sinceDate.getUTCFullYear() - 1;

  const perCompetition = await Promise.all(
    (Object.entries(UEFA_LEAGUE_IDS) as [ApiFootballFixture['competition'], number][]).map(
      async ([competition, leagueId]) => {
        const items = await apiFootballGet<RawFixtureItem>(apiKey, '/fixtures', {
          team: apiFootballTeamId,
          league: leagueId,
          season,
          from,
          to,
          status: 'FT',
        });
        if (!items) return [];

        const fixtures: ApiFootballFixture[] = [];
        for (const item of items) {
          if (item.fixture?.status?.short !== 'FT') continue;
          const opponent =
            item.teams.home.id === apiFootballTeamId ? item.teams.away.name : item.teams.home.name;
          fixtures.push({
            fixtureId: item.fixture.id,
            competition,
            opponent,
            kickoffTime: item.fixture.date,
          });
        }
        return fixtures;
      },
    ),
  );

  // Dedupe by fixtureId: a fixture is only ever queried under its own
  // competition's league id, so a collision isn't expected in practice, but
  // never returning the same fixture twice is a cheap invariant to hold.
  const merged = new Map<number, ApiFootballFixture>();
  for (const fixtures of perCompetition) {
    for (const fixture of fixtures) merged.set(fixture.fixtureId, fixture);
  }
  return [...merged.values()];
}

interface RawEventPlayerRef {
  id: number | null;
  name: string | null;
}

interface RawFixtureEvent {
  time: { elapsed: number; extra: number | null };
  type: string;
  player: RawEventPlayerRef;
  assist: RawEventPlayerRef | null;
}

interface RawLineupPlayer {
  player: { id: number; name: string };
}

interface RawFixtureLineup {
  team: { id: number };
  startXI: RawLineupPlayer[];
  substitutes: RawLineupPlayer[];
}

/** Minute a player is treated as having played when they finish the match
 * without being subbed off. UEFA league-phase matches are round-robin (no
 * extra time), so 90 is the ceiling in practice; `time.extra` on any event
 * is otherwise ignored rather than added on top of `elapsed`, matching this
 * cap. */
const FULL_MATCH_MINUTES = 90;

/** One player's tracked state while folding substitution events onto the
 * starting lineups. `subbedOnMinute` is tracked internally to compute
 * `minutesPlayed` but is not part of the exported `ApiFootballAppearance`
 * shape. */
interface AppearanceState {
  name: string;
  started: boolean;
  subbedOnMinute: number | null;
  subbedOffMinute: number | null;
}

function eventPlayerKey(ref: RawEventPlayerRef | { id: number; name: string }): number | string {
  return ref.id ?? ref.name ?? '';
}

/**
 * Every player who appeared (started or came on as a substitute) in one
 * fixture, with who was subbed off and when. Two subrequests: `/fixtures/
 * lineups` for who started (the events feed alone only ever tells you WHO
 * was subbed, never who started), and `/fixtures/events` for the
 * substitution minutes.
 *
 * Direction of a `type === "subst"` event (who came OFF vs who came ON) is
 * derived structurally rather than trusted from field names alone --
 * community reports on which of `player`/`assist` is which are genuinely
 * split, and getting this backwards would flag the wrong player as
 * fatigued. For each subst event, whichever of `player`/`assist` matches a
 * name in the starting lineups is the one coming OFF (a starter cannot come
 * ON as a substitute); the other came ON. Only when neither/both match a
 * starter -- a "sub for a sub", swapping two players who already came on
 * earlier in the same match -- does this fall back to API-Football's
 * documented convention (`player` = off, `assist` = on). That fallback
 * branch is the one part of this mapping NOT independently verified here.
 */
export async function getFixtureSubstitutions(
  apiKey: string,
  fixtureId: number,
): Promise<ApiFootballAppearance[]> {
  const [events, lineups] = await Promise.all([
    apiFootballGet<RawFixtureEvent>(apiKey, '/fixtures/events', { fixture: fixtureId }),
    apiFootballGet<RawFixtureLineup>(apiKey, '/fixtures/lineups', { fixture: fixtureId }),
  ]);

  // No starting lineups means no basis for who started at all -- nothing
  // to safely report. A failed `events` fetch is not fatal on its own (see
  // below): it degrades to "no known substitutions", not to an empty result.
  if (!lineups || lineups.length === 0) return [];

  const appearances = new Map<number | string, AppearanceState>();
  for (const lineup of lineups) {
    for (const entry of lineup.startXI ?? []) {
      const key = eventPlayerKey(entry.player);
      appearances.set(key, {
        name: entry.player.name,
        started: true,
        subbedOnMinute: null,
        subbedOffMinute: null,
      });
    }
  }
  const starterKeys = new Set(appearances.keys());

  const substEvents = (events ?? [])
    .filter((event) => event.type === 'subst')
    .sort((a, b) => (a.time?.elapsed ?? 0) - (b.time?.elapsed ?? 0));

  for (const event of substEvents) {
    const minute = event.time?.elapsed ?? 0;
    const playerKey = event.player ? eventPlayerKey(event.player) : undefined;
    const assistKey = event.assist ? eventPlayerKey(event.assist) : undefined;
    const playerIsStarter = playerKey !== undefined && starterKeys.has(playerKey);
    const assistIsStarter = assistKey !== undefined && starterKeys.has(assistKey);

    let off: RawEventPlayerRef | undefined;
    let on: RawEventPlayerRef | undefined;
    if (playerIsStarter && !assistIsStarter) {
      off = event.player;
      on = event.assist ?? undefined;
    } else if (assistIsStarter && !playerIsStarter) {
      off = event.assist ?? undefined;
      on = event.player;
    } else {
      // Sub-for-sub (or a malformed event): fall back to the documented,
      // unverified convention.
      off = event.player;
      on = event.assist ?? undefined;
    }

    // A ref with neither id nor name is unidentifiable -- skip rather than
    // fabricate an "Unknown" row that would collide with every other such
    // ref on the same empty map key.
    if (off?.id == null && off?.name == null) off = undefined;
    if (on?.id == null && on?.name == null) on = undefined;

    if (off) {
      const key = eventPlayerKey(off);
      const existing = appearances.get(key);
      if (existing) {
        existing.subbedOffMinute = minute;
      } else {
        appearances.set(key, {
          name: off.name ?? String(off.id),
          started: false,
          subbedOnMinute: null,
          subbedOffMinute: minute,
        });
      }
    }

    if (on) {
      const key = eventPlayerKey(on);
      const existing = appearances.get(key);
      if (existing) {
        if (existing.subbedOnMinute === null) existing.subbedOnMinute = minute;
      } else {
        appearances.set(key, {
          name: on.name ?? String(on.id),
          started: false,
          subbedOnMinute: minute,
          subbedOffMinute: null,
        });
      }
    }
  }

  return [...appearances.values()].map((state) => {
    const minutesPlayed = state.started
      ? (state.subbedOffMinute ?? FULL_MATCH_MINUTES)
      : (state.subbedOffMinute ?? FULL_MATCH_MINUTES) - (state.subbedOnMinute ?? 0);
    return {
      playerName: state.name,
      started: state.started,
      subbedOffMinute: state.subbedOffMinute,
      minutesPlayed,
    };
  });
}
