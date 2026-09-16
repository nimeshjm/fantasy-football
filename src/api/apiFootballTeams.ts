/**
 * Static map from this project's own `teams.id` (the D1 `teams` table,
 * matching the Liga Portugal Fantasy bootstrap ids -- see src/db/teams.ts
 * and test/fixtures/bootstrap-static.json) to API-Football's own numeric
 * team id, keyed by our `short_name` for readability.
 *
 * Scope (issue #51): only clubs actually in a UEFA club competition this
 * season. Verified against the live 2025-26 Primeira Liga final standings
 * and each competition's league-phase entrant list (Wikipedia, cross-checked
 * across the Champions/Europa/Conference League pages, 2026-09-16):
 *   - FC Porto (1st)      -> Champions League league phase
 *   - Sporting CP (2nd)   -> Champions League league phase
 *   - SL Benfica (3rd)    -> Europa League league phase
 *   - SC Braga (4th)      -> Conference League league phase
 * Vitória SC, Gil Vicente and Santa Clara are NOT in Europe this season --
 * Braga took the 4th UEFA spot, not Santa Clara, despite that being an
 * earlier, less careful search result. Torreense (Taça de Portugal winners,
 * also in the Europa League league phase) is intentionally absent: they are
 * not a Primeira Liga club and have no row in our `teams` table at all, so
 * they already hit the normal "unmapped club" skip path everywhere this map
 * is consulted.
 *
 * The four API-Football ids below were NOT confirmed via a live, keyed API
 * call (no key exists yet) or via api-football.com's own docs/dashboard --
 * both 403 to automated fetches (see UEFA_LEAGUE_IDS in ./apiFootball.ts for
 * the same problem on the competition-id side). They WERE cross-checked
 * against API-Football's public, unauthenticated crest CDN
 * (`https://media.api-sports.io/football/teams/<id>.png`, the same host
 * their `logo` field points to) -- each id below returned the correct
 * club's crest image, not a 403 or an unrelated badge. That is good
 * evidence the id is real and correctly assigned, but it is still not the
 * same as reading the id back out of a genuine `/teams?search=` JSON
 * response. Spot-check that once a real API-Football key exists, before
 * leaning on this harder than "best-effort, silently-skippable signal".
 *
 * An unmapped club (missing from this record, or a `short_name` that
 * doesn't match one of these keys) is a normal, silent "skip" case
 * everywhere this map is read -- never an error.
 */
export const API_FOOTBALL_TEAM_IDS: Readonly<Record<string, number>> = {
  SLB: 211, // teams.id 2, SL Benfica -- crest-verified
  SCB: 217, // teams.id 12, SC Braga -- crest-verified
  SCP: 228, // teams.id 13, Sporting CP -- crest-verified
  FCP: 212, // teams.id 15, FC Porto -- crest-verified
};

/** `undefined` for any club not in `API_FOOTBALL_TEAM_IDS` -- e.g. every
 * Primeira Liga club without European football this season. Callers treat
 * that exactly like any other best-effort miss: skip the club, never throw
 * or log it as an error. */
export function apiFootballTeamId(shortName: string): number | undefined {
  return API_FOOTBALL_TEAM_IDS[shortName];
}
