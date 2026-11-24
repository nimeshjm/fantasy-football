/**
 * Player awards client (issue #106).
 *
 * Official Primeira Liga award APIs (POTM, POTW, Player of the Month) are
 * currently absent or unsupported in the available public endpoints.
 * This client provides the typed contract, name-matching logic, and a
 * failure-safe fetch interface that returns empty results when no source is
 * available, ensuring it never blocks or delays a decision.
 */

import type { Element, Team } from '../types';

export type AwardType = 'match' | 'week' | 'month';

export interface FetchedPlayerAward {
  awardType: AwardType;
  periodKey: string;
  fixtureId: number | null;
  playerName: string;
  teamShortName: string;
}

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
 * Matches a fetched award winner against elements using normalized name and
 * club short_name. Returns the matched element id or null if unmatched or
 * ambiguous.
 */
export function matchAwardPlayer(
  elements: readonly Element[],
  teams: readonly Team[],
  playerName: string,
  teamShortName: string,
): number | null {
  const targetName = normalizeName(playerName);
  const targetTeam = normalizeName(teamShortName);
  if (!targetName || !targetTeam) return null;

  const team = teams.find((t) => normalizeName(t.short_name) === targetTeam);
  if (!team) return null;

  const candidates = elements.filter((e) => e.team === team.id);

  const fullNameMatches = candidates.filter(
    (c) =>
      c.first_name &&
      c.second_name &&
      normalizeName(`${c.first_name} ${c.second_name}`) === targetName,
  );
  if (fullNameMatches.length === 1) return fullNameMatches[0]!.id;
  if (fullNameMatches.length > 1) return null;

  const webNameMatches = candidates.filter((c) => normalizeName(c.web_name) === targetName);
  if (webNameMatches.length === 1) return webNameMatches[0]!.id;
  return null;
}

/**
 * Fetches player awards. Currently returns an empty array as no reliable
 * public API source is confirmed. Never throws.
 */
export async function fetchPlayerAwards(): Promise<FetchedPlayerAward[]> {
  try {
    return [];
  } catch {
    return [];
  }
}
