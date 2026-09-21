/**
 * Tests for src/opponentNote.ts (issue #69): the opponent-visibility note
 * ("`opp:`" prompt fragment) formatting/orchestration logic. No D1 or
 * Workflow plumbing involved -- everything here is pure.
 */
import { describe, expect, it } from 'vitest';

import { buildOpponentNotesByTeam } from '../src/opponentNote';
import type { UpcomingFixtureInfo } from '../src/model/projection';
import type { RatingsModel } from '../src/model/ratings';
import type { TeamRow } from '../src/db';

const TEAMS: TeamRow[] = [
  { id: 1, code: 1, name: 'Sport Lisboa e Benfica', short_name: 'SLB' },
  { id: 2, code: 2, name: 'Vitória SC', short_name: 'VSC' },
  { id: 3, code: 3, name: 'CD Santa Clara', short_name: 'CDSC' },
];

function ratings(entries: [number, { attack: number; defence: number }][]): RatingsModel {
  return {
    ratings: new Map(entries),
    leagueAvgGoals: 1.4,
    homeAdvantage: 1.1,
  };
}

describe('buildOpponentNotesByTeam', () => {
  it('returns an empty map when ratings is undefined (ep-next strategy)', () => {
    const fixturesByTeam = new Map<number, UpcomingFixtureInfo[]>([
      [1, [{ opponent: 2, isHome: true }]],
    ]);
    expect(buildOpponentNotesByTeam(TEAMS, fixturesByTeam, undefined).size).toBe(0);
  });

  it('returns an empty map when fixturesByTeam is undefined (ep-next strategy)', () => {
    expect(buildOpponentNotesByTeam(TEAMS, undefined, ratings([])).size).toBe(0);
  });

  it('formats a home fixture as "vs <OPP> (H) att<n> concede<n>"', () => {
    const fixturesByTeam = new Map<number, UpcomingFixtureInfo[]>([
      [1, [{ opponent: 2, isHome: true }]],
    ]);
    const model = ratings([[2, { attack: 1.35, defence: 0.78 }]]);

    const notes = buildOpponentNotesByTeam(TEAMS, fixturesByTeam, model);

    expect(notes.get(1)).toBe('vs VSC (H) att1.35 concede0.78');
  });

  it('formats an away fixture as "vs <OPP> (A) att<n> concede<n>"', () => {
    const fixturesByTeam = new Map<number, UpcomingFixtureInfo[]>([
      [1, [{ opponent: 2, isHome: false }]],
    ]);
    const model = ratings([[2, { attack: 0.92, defence: 1.1 }]]);

    const notes = buildOpponentNotesByTeam(TEAMS, fixturesByTeam, model);

    expect(notes.get(1)).toBe('vs VSC (A) att0.92 concede1.10');
  });

  it('joins a double gameweek\'s fixtures with ", "', () => {
    const fixturesByTeam = new Map<number, UpcomingFixtureInfo[]>([
      [
        1,
        [
          { opponent: 2, isHome: false },
          { opponent: 3, isHome: true },
        ],
      ],
    ]);
    const model = ratings([
      [2, { attack: 0.92, defence: 1.1 }],
      [3, { attack: 1.01, defence: 0.95 }],
    ]);

    const notes = buildOpponentNotesByTeam(TEAMS, fixturesByTeam, model);

    expect(notes.get(1)).toBe('vs VSC (A) att0.92 concede1.10, vs CDSC (H) att1.01 concede0.95');
  });

  it('renders "no fixture" for a team absent from fixturesByTeam', () => {
    const fixturesByTeam = new Map<number, UpcomingFixtureInfo[]>();
    const model = ratings([]);

    const notes = buildOpponentNotesByTeam(TEAMS, fixturesByTeam, model);

    expect(notes.get(1)).toBe('no fixture');
  });

  it('renders "no fixture" for a team present with an empty fixture list', () => {
    const fixturesByTeam = new Map<number, UpcomingFixtureInfo[]>([[1, []]]);
    const model = ratings([]);

    const notes = buildOpponentNotesByTeam(TEAMS, fixturesByTeam, model);

    expect(notes.get(1)).toBe('no fixture');
  });

  it('falls back to neutral 1.00/1.00 when the opponent is missing from ratings.ratings', () => {
    const fixturesByTeam = new Map<number, UpcomingFixtureInfo[]>([
      [1, [{ opponent: 2, isHome: true }]],
    ]);
    // Model has no rating at all for team 2 (e.g. newly promoted).
    const model = ratings([]);

    const notes = buildOpponentNotesByTeam(TEAMS, fixturesByTeam, model);

    expect(notes.get(1)).toBe('vs VSC (H) att1.00 concede1.00');
  });

  it('falls back to "#<id>" for an opponent team id missing from teams', () => {
    const fixturesByTeam = new Map<number, UpcomingFixtureInfo[]>([
      [1, [{ opponent: 99, isHome: true }]],
    ]);
    const model = ratings([[99, { attack: 1.2, defence: 0.85 }]]);

    const notes = buildOpponentNotesByTeam(TEAMS, fixturesByTeam, model);

    expect(notes.get(1)).toBe('vs #99 (H) att1.20 concede0.85');
  });

  it('produces one entry per team in `teams`, regardless of fixturesByTeam contents', () => {
    const fixturesByTeam = new Map<number, UpcomingFixtureInfo[]>([
      [1, [{ opponent: 2, isHome: true }]],
    ]);
    const model = ratings([[2, { attack: 1, defence: 1 }]]);

    const notes = buildOpponentNotesByTeam(TEAMS, fixturesByTeam, model);

    expect(notes.size).toBe(TEAMS.length);
    expect(notes.get(2)).toBe('no fixture');
    expect(notes.get(3)).toBe('no fixture');
  });
});
