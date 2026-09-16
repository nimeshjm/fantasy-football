/**
 * Tests for src/uefaRotation.ts (issue #51): the UEFA rotation-risk signal's
 * name-matching, note-formatting and orchestration logic. No real D1 or
 * network involved -- `fetch` is stubbed (same pattern as
 * test/apiFootball.test.ts) and D1 is a small in-memory fake purpose-built
 * for the two `uefa_appearances` query shapes this module actually issues.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildEuropeNotes,
  formatEuropeNote,
  matchElementByName,
  refreshUefaAppearances,
} from '../src/uefaRotation';
import type { Element } from '../src/types';
import type { TeamRow } from '../src/db';

// ---------------------------------------------------------------------------
// matchElementByName
// ---------------------------------------------------------------------------

interface Candidate {
  id: number;
  web_name: string;
  first_name?: string;
  second_name?: string;
}

describe('matchElementByName', () => {
  const candidates: Candidate[] = [
    { id: 1, web_name: 'Pavlidis', first_name: 'Vangelis', second_name: 'Pavlidis' },
    { id: 2, web_name: 'J. Mário', first_name: 'João', second_name: 'Mário' },
    { id: 3, web_name: 'Rafa', first_name: 'Rafael', second_name: 'Camacho' },
  ];

  it('matches on exact normalized full name', () => {
    expect(matchElementByName(candidates, 'Vangelis Pavlidis')).toBe(1);
  });

  it('matches through diacritics -- "Joao Mario" normalizes the same as "João Mário"', () => {
    expect(matchElementByName(candidates, 'Joao Mario')).toBe(2);
  });

  it('strips punctuation before comparing (e.g. a hyphenated or apostrophed name)', () => {
    const withPunctuation: Candidate[] = [
      { id: 4, web_name: "N'Golo", first_name: "N'Golo", second_name: 'Kanté' },
    ];
    expect(matchElementByName(withPunctuation, 'NGolo Kante')).toBe(4);
  });

  it('falls back to web_name equality when the full name does not match', () => {
    // API-Football reports just the short display name "Rafa" -- doesn't
    // match Rafael Camacho's full name, but does match his web_name.
    expect(matchElementByName(candidates, 'Rafa')).toBe(3);
  });

  it('returns null, never a guess, when nothing matches', () => {
    expect(matchElementByName(candidates, 'Someone Else Entirely')).toBeNull();
  });

  it('returns null on an ambiguous full-name match rather than picking one', () => {
    const ambiguous: Candidate[] = [
      { id: 10, web_name: 'A. Silva', first_name: 'André', second_name: 'Silva' },
      { id: 11, web_name: 'A. Silva 2', first_name: 'André', second_name: 'Silva' },
    ];
    expect(matchElementByName(ambiguous, 'Andre Silva')).toBeNull();
  });

  it('returns null on an ambiguous web_name match rather than picking one', () => {
    const ambiguous: Candidate[] = [
      { id: 20, web_name: 'Rafa', first_name: 'Rafael', second_name: 'One' },
      { id: 21, web_name: 'Rafa', first_name: 'Rafael', second_name: 'Two' },
    ];
    expect(matchElementByName(ambiguous, 'Rafa')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatEuropeNote
// ---------------------------------------------------------------------------

describe('formatEuropeNote', () => {
  it('formats a subbed-off appearance', () => {
    expect(
      formatEuropeNote({
        competition: 'UEL',
        opponent: 'Milan',
        subbedOffMinute: 61,
        minutesPlayed: 61,
      }),
    ).toBe("subbed 61' vs Milan (UEL)");
  });

  it('formats a full-match appearance', () => {
    expect(
      formatEuropeNote({
        competition: 'UEL',
        opponent: 'Milan',
        subbedOffMinute: null,
        minutesPlayed: 90,
      }),
    ).toBe("played 90' vs Milan (UEL)");
  });
});

// ---------------------------------------------------------------------------
// A tiny in-memory D1 fake, purpose-built for uefa_appearances's two query
// shapes (src/db/uefaAppearances.ts) -- not a general SQL engine.
// ---------------------------------------------------------------------------

interface StoredRow {
  element_id: number;
  fixture_id: number;
  competition: string;
  opponent: string;
  kickoff_time: string;
  started: number;
  subbed_off_minute: number | null;
  minutes_played: number;
  fetched_at: string;
}

function makeFakeDb(initialRows: StoredRow[] = []): { db: D1Database; rows: () => StoredRow[] } {
  const table = new Map<string, StoredRow>();
  for (const row of initialRows) table.set(`${row.element_id}:${row.fixture_id}`, row);

  function prepare(sql: string) {
    return {
      bind(...args: unknown[]) {
        return {
          sql,
          args,
          async all() {
            if (sql.includes('SELECT element_id, fixture_id FROM uefa_appearances')) {
              // hasUefaAppearances: WHERE element_id IN (?, ...) AND fixture_id IN (?, ...)
              const inClauses = [...sql.matchAll(/IN \(([^)]*)\)/g)];
              const n1 = (inClauses[0]?.[1]?.match(/\?/g) ?? []).length;
              const elementIds = args.slice(0, n1) as number[];
              const fixtureIds = args.slice(n1) as number[];
              const results = [...table.values()]
                .filter(
                  (r) => elementIds.includes(r.element_id) && fixtureIds.includes(r.fixture_id),
                )
                .map((r) => ({ element_id: r.element_id, fixture_id: r.fixture_id }));
              return { results };
            }
            // getUefaAppearancesForElements: WHERE element_id IN (?, ...) ORDER BY kickoff_time DESC
            const elementIds = args as number[];
            const results = [...table.values()]
              .filter((r) => elementIds.includes(r.element_id))
              .sort((a, b) => (a.kickoff_time < b.kickoff_time ? 1 : -1));
            return { results };
          },
        };
      },
    };
  }

  async function batch(statements: { sql: string; args: unknown[] }[]) {
    for (const stmt of statements) {
      if (stmt.sql.includes('INSERT INTO uefa_appearances')) {
        const rows = JSON.parse(stmt.args[0] as string) as StoredRow[];
        for (const row of rows) {
          table.set(`${row.element_id}:${row.fixture_id}`, row);
        }
      }
    }
    return [];
  }

  return { db: { prepare, batch } as unknown as D1Database, rows: () => [...table.values()] };
}

// ---------------------------------------------------------------------------
// refreshUefaAppearances
// ---------------------------------------------------------------------------

function makeElement(overrides: Partial<Element> & { id: number }): Element {
  return {
    code: overrides.id,
    web_name: `Player${overrides.id}`,
    first_name: 'First',
    second_name: 'Last',
    team: 1,
    element_type: 3,
    now_cost: 50,
    status: 'a',
    news: '',
    news_added: null,
    chance_of_playing_this_round: null,
    chance_of_playing_next_round: null,
    total_points: 0,
    event_points: 0,
    points_per_game: '0.0',
    form: '0.0',
    ep_next: null,
    ep_this: null,
    selected_by_percent: '0.0',
    minutes: 900,
    removed: false,
    can_select: true,
    can_transact: true,
    ...overrides,
  };
}

const TEAMS: TeamRow[] = [{ id: 2, code: 2, name: 'SL Benfica', short_name: 'SLB' }];

function jsonResponse(body: unknown): Response {
  return { status: 200, ok: true, json: async () => body } as unknown as Response;
}

describe('refreshUefaAppearances', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const pavlidis = makeElement({
    id: 100,
    team: 2,
    web_name: 'Pavlidis',
    first_name: 'Vangelis',
    second_name: 'Pavlidis',
  });
  const dahl = makeElement({
    id: 101,
    team: 2,
    web_name: 'Dahl',
    first_name: 'Alexander',
    second_name: 'Dahl',
  });

  function mockEmptyFixturesEverywhere() {
    fetchMock.mockResolvedValue(jsonResponse({ response: [] }));
  }

  it('skips entirely when apiKey is unset -- no fetch, no D1 read/write', async () => {
    const { db, rows } = makeFakeDb();
    const result = await refreshUefaAppearances({
      db,
      apiKey: undefined,
      ownedElements: [pavlidis, dahl],
      teams: TEAMS,
      sinceIso: '2026-09-01T00:00:00Z',
    });

    expect(result).toEqual({ fetched: 0, matched: 0, unmatched: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it('fetches, matches by name, and upserts a new fixture', async () => {
    // getRecentFinishedFixturesForTeam: 3 calls (UCL, UEL, UECL). Only UEL
    // has a finished fixture.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ response: [] })) // UCL
      .mockResolvedValueOnce(
        jsonResponse({
          response: [
            {
              fixture: { id: 5001, date: '2026-09-16T19:00:00+00:00', status: { short: 'FT' } },
              teams: { home: { id: 211, name: 'SL Benfica' }, away: { id: 489, name: 'AC Milan' } },
            },
          ],
        }),
      ) // UEL
      .mockResolvedValueOnce(jsonResponse({ response: [] })) // UECL
      // getFixtureSubstitutions: events then lineups.
      .mockResolvedValueOnce(
        jsonResponse({
          response: [
            {
              time: { elapsed: 61, extra: null },
              type: 'subst',
              player: { id: 9001, name: 'Vangelis Pavlidis' },
              assist: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          response: [
            {
              team: { id: 211 },
              startXI: [
                { player: { id: 9001, name: 'Vangelis Pavlidis' } },
                { player: { id: 9003, name: 'Unmatched Player' } },
              ],
              substitutes: [],
            },
          ],
        }),
      );

    const { db, rows } = makeFakeDb();
    const result = await refreshUefaAppearances({
      db,
      apiKey: 'test-key',
      ownedElements: [pavlidis, dahl],
      teams: TEAMS,
      sinceIso: '2026-09-01T00:00:00Z',
    });

    expect(result.fetched).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.unmatched).toEqual(['Unmatched Player']);

    const stored = rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      element_id: pavlidis.id,
      fixture_id: 5001,
      competition: 'UEL',
      opponent: 'AC Milan',
      subbed_off_minute: 61,
    });
  });

  it('never re-fetches substitutions for a fixture already fully covered', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ response: [] })) // UCL
      .mockResolvedValueOnce(
        jsonResponse({
          response: [
            {
              fixture: { id: 5001, date: '2026-09-16T19:00:00+00:00', status: { short: 'FT' } },
              teams: { home: { id: 211, name: 'SL Benfica' }, away: { id: 489, name: 'AC Milan' } },
            },
          ],
        }),
      ) // UEL
      .mockResolvedValueOnce(jsonResponse({ response: [] })); // UECL

    const { db, rows } = makeFakeDb([
      {
        element_id: pavlidis.id,
        fixture_id: 5001,
        competition: 'UEL',
        opponent: 'AC Milan',
        kickoff_time: '2026-09-16T19:00:00+00:00',
        started: 1,
        subbed_off_minute: 61,
        minutes_played: 61,
        fetched_at: '2026-09-16T21:00:00Z',
      },
      {
        element_id: dahl.id,
        fixture_id: 5001,
        competition: 'UEL',
        opponent: 'AC Milan',
        kickoff_time: '2026-09-16T19:00:00+00:00',
        started: 1,
        subbed_off_minute: null,
        minutes_played: 90,
        fetched_at: '2026-09-16T21:00:00Z',
      },
    ]);

    const result = await refreshUefaAppearances({
      db,
      apiKey: 'test-key',
      ownedElements: [pavlidis, dahl],
      teams: TEAMS,
      sinceIso: '2026-09-01T00:00:00Z',
    });

    expect(result).toEqual({ fetched: 0, matched: 0, unmatched: [] });
    // Only the 3 fixture-list calls (UCL/UEL/UECL) -- never events/lineups.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rows()).toHaveLength(2);
  });

  it('skips a club with no API-Football mapping without error', async () => {
    mockEmptyFixturesEverywhere();
    const unmappedClubElement = makeElement({ id: 200, team: 99, web_name: 'Someone' });
    const { db, rows } = makeFakeDb();
    const teamsWithUnmapped: TeamRow[] = [
      ...TEAMS,
      { id: 99, code: 99, name: 'Unmapped FC', short_name: 'UFC' },
    ];

    const result = await refreshUefaAppearances({
      db,
      apiKey: 'test-key',
      ownedElements: [unmappedClubElement],
      teams: teamsWithUnmapped,
      sinceIso: '2026-09-01T00:00:00Z',
    });

    expect(result).toEqual({ fetched: 0, matched: 0, unmatched: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildEuropeNotes
// ---------------------------------------------------------------------------

describe('buildEuropeNotes', () => {
  it('keeps only the most recent appearance per element', async () => {
    const { db } = makeFakeDb([
      {
        element_id: 1,
        fixture_id: 100,
        competition: 'UEL',
        opponent: 'Older Opponent',
        kickoff_time: '2026-09-01T19:00:00Z',
        started: 1,
        subbed_off_minute: null,
        minutes_played: 90,
        fetched_at: '2026-09-01T21:00:00Z',
      },
      {
        element_id: 1,
        fixture_id: 101,
        competition: 'UEL',
        opponent: 'Milan',
        kickoff_time: '2026-09-16T19:00:00Z',
        started: 1,
        subbed_off_minute: 61,
        minutes_played: 61,
        fetched_at: '2026-09-16T21:00:00Z',
      },
    ]);

    const notes = await buildEuropeNotes(db, [1]);
    expect(notes.get(1)).toBe("subbed 61' vs Milan (UEL)");
  });

  it('returns an empty map for element ids with no stored appearances', async () => {
    const { db } = makeFakeDb();
    const notes = await buildEuropeNotes(db, [999]);
    expect(notes.size).toBe(0);
  });

  it('returns an empty map (never throws) when D1 read fails', async () => {
    const throwingDb = {
      prepare() {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;

    const notes = await buildEuropeNotes(throwingDb, [1]);
    expect(notes.size).toBe(0);
  });
});
