/**
 * Map from this project's own `teams.short_name` to ESPN's numeric team id,
 * for the clubs in a UEFA competition this season (issue #58).
 *
 * Unlike the api-football ids this replaces, these were read back from a live
 * `/{slug}/teams` response on 2026-09-18, not inferred from a crest URL:
 * Benfica 1929 and Braga 2994 under `uefa.europa`/`uefa.europa.conf`, FC Porto
 * 437 and Sporting CP 2250 under `uefa.champions`.
 *
 * An unmapped club is a normal silent skip, never an error.
 */
export const ESPN_TEAM_IDS: Readonly<Record<string, number>> = {
  SLB: 1929, // SL Benfica
  SCB: 2994, // SC Braga
  SCP: 2250, // Sporting CP
  FCP: 437, // FC Porto
};

export function espnTeamId(shortName: string): number | undefined {
  return ESPN_TEAM_IDS[shortName];
}
