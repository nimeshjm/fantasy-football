/**
 * Tests for src/uefaRotation.ts (issue #58): the UEFA rotation-risk signal's
 * name-matching, note-formatting and orchestration logic. No real D1 or
 * network involved -- `../src/api/espn` is mocked wholesale (its fetch
 * bodies are someone else's stub) and D1 is a small in-memory fake
 * purpose-built for the two `uefa_appearances` query shapes this module
 * actually issues.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api/espn', () => ({
  getRecentFinishedFixturesForTeam: vi.fn(),
  getFixtureAppearances: vi.fn(),
}));

import { getFixtureAppearances, getRecentFinishedFixturesForTeam } from '../src/api/espn';
import type { UefaFixture } from '../src/api/espn';
import {
  buildEuropeNotes,
  formatEuropeNote,
  matchElementByName,
  refreshUefaAppearances,
} from '../src/uefaRotation';
import type { Element } from '../src/types';
import type { TeamRow } from '../src/db';

const fixturesMock = vi.mocked(getRecentFinishedFixturesForTeam);
const appearancesMock = vi.mocked(getFixtureAppearances);

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
    // ESPN's `playerLastName` fallback (uefaRotation.ts) is what actually
    // triggers this in production, but the function itself just sees a
    // short/display name here -- doesn't match Rafael Camacho's full name,
    // but does match his web_name.
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

function fixture(overrides: Partial<UefaFixture> = {}): UefaFixture {
  return {
    fixtureId: 5001,
    competition: 'UEL',
    opponent: 'AC Milan',
    kickoffTime: '2026-09-16T19:00:00Z',
    ...overrides,
  };
}

describe('refreshUefaAppearances', () => {
  beforeEach(() => {
    fixturesMock.mockReset();
    appearancesMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
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
  const trubin = makeElement({
    id: 102,
    team: 2,
    web_name: 'Trubin',
    first_name: 'Anatolii',
    second_name: 'Trubin',
  });

  it('fetches, matches by name, and upserts a new fixture', async () => {
    fixturesMock.mockResolvedValue([fixture()]);
    appearancesMock.mockResolvedValue([
      {
        playerName: 'Vangelis Pavlidis',
        playerLastName: 'Pavlidis',
        started: false,
        subbedOffMinute: 61,
        minutesPlayed: 61,
      },
      {
        playerName: 'Unmatched Player',
        playerLastName: 'Player',
        started: true,
        subbedOffMinute: null,
        minutesPlayed: 90,
      },
    ]);

    const { db, rows } = makeFakeDb();
    const result = await refreshUefaAppearances({
      db,
      ownedElements: [pavlidis, dahl],
      teams: TEAMS,
      sinceIso: '2026-09-01T00:00:00Z',
    });

    expect(result.fetched).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.unmatched).toEqual(['Unmatched Player']);
    expect(appearancesMock).toHaveBeenCalledWith(fixture(), 1929);

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

  it('matches ESPN "Anatoliy Trubin" to our element via the last-name probe', async () => {
    fixturesMock.mockResolvedValue([fixture()]);
    appearancesMock.mockResolvedValue([
      {
        playerName: 'Anatoliy Trubin',
        playerLastName: 'Trubin',
        started: true,
        subbedOffMinute: null,
        minutesPlayed: 90,
      },
    ]);

    const { db } = makeFakeDb();
    const result = await refreshUefaAppearances({
      db,
      ownedElements: [trubin],
      teams: TEAMS,
      sinceIso: '2026-09-01T00:00:00Z',
    });

    expect(result.matched).toBe(1);
    expect(result.unmatched).toEqual([]);
  });

  it('never matches by last name when playerLastName is null -- the wrong-player guard', async () => {
    // ESPN sent `null` because it could not disambiguate on its side; the
    // last name it withheld would have matched this element's `web_name`
    // exactly. That null must never be treated as a usable last name.
    fixturesMock.mockResolvedValue([fixture()]);
    appearancesMock.mockResolvedValue([
      {
        playerName: 'Rafa Silva',
        playerLastName: null,
        started: true,
        subbedOffMinute: null,
        minutesPlayed: 90,
      },
    ]);

    const silva = makeElement({
      id: 103,
      team: 2,
      web_name: 'Silva',
      first_name: 'Some',
      second_name: 'One',
    });
    const { db } = makeFakeDb();
    const result = await refreshUefaAppearances({
      db,
      ownedElements: [silva],
      teams: TEAMS,
      sinceIso: '2026-09-01T00:00:00Z',
    });

    expect(result.matched).toBe(0);
    expect(result.unmatched).toEqual(['Rafa Silva']);
  });

  it('never re-fetches a covered fixture', async () => {
    fixturesMock.mockResolvedValue([fixture()]);

    const { db, rows } = makeFakeDb([
      {
        element_id: pavlidis.id,
        fixture_id: 5001,
        competition: 'UEL',
        opponent: 'AC Milan',
        kickoff_time: '2026-09-16T19:00:00Z',
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
        kickoff_time: '2026-09-16T19:00:00Z',
        started: 1,
        subbed_off_minute: null,
        minutes_played: 90,
        fetched_at: '2026-09-16T21:00:00Z',
      },
    ]);

    const result = await refreshUefaAppearances({
      db,
      ownedElements: [pavlidis, dahl],
      teams: TEAMS,
      sinceIso: '2026-09-01T00:00:00Z',
    });

    expect(result).toEqual({ fetched: 0, matched: 0, unmatched: [] });
    expect(appearancesMock).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
  });

  it('respects MAX_SUMMARY_FETCHES_PER_RUN -- 10 uncovered fixtures produce exactly 8 summary calls', async () => {
    const fixtures = Array.from({ length: 10 }, (_, i) => fixture({ fixtureId: 6000 + i }));
    fixturesMock.mockResolvedValue(fixtures);
    appearancesMock.mockResolvedValue([]);

    const { db } = makeFakeDb();
    const result = await refreshUefaAppearances({
      db,
      ownedElements: [pavlidis],
      teams: TEAMS,
      sinceIso: '2026-09-01T00:00:00Z',
    });

    expect(appearancesMock).toHaveBeenCalledTimes(8);
    expect(result.fetched).toBe(8);
  });

  it("one club's failure does not abort the others", async () => {
    const teams: TeamRow[] = [...TEAMS, { id: 3, code: 3, name: 'SC Braga', short_name: 'SCB' }];
    const braga = makeElement({ id: 200, team: 3, web_name: 'Bruma' });

    fixturesMock.mockImplementation(async (espnId: number) => {
      if (espnId === 1929) throw new Error('ESPN unavailable for Benfica');
      return [fixture({ fixtureId: 7001, opponent: 'PSV' })];
    });
    appearancesMock.mockResolvedValue([
      {
        playerName: 'Bruma',
        playerLastName: 'Bruma',
        started: true,
        subbedOffMinute: null,
        minutesPlayed: 90,
      },
    ]);

    const { db, rows } = makeFakeDb();
    const result = await refreshUefaAppearances({
      db,
      ownedElements: [pavlidis, braga],
      teams,
      sinceIso: '2026-09-01T00:00:00Z',
    });

    expect(result.fetched).toBe(1);
    expect(result.matched).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it('skips a club with no ESPN team mapping without a provider call', async () => {
    const unmappedClubElement = makeElement({ id: 200, team: 99, web_name: 'Someone' });
    const { db, rows } = makeFakeDb();
    const teamsWithUnmapped: TeamRow[] = [
      ...TEAMS,
      { id: 99, code: 99, name: 'Unmapped FC', short_name: 'UFC' },
    ];

    const result = await refreshUefaAppearances({
      db,
      ownedElements: [unmappedClubElement],
      teams: teamsWithUnmapped,
      sinceIso: '2026-09-01T00:00:00Z',
    });

    expect(result).toEqual({ fetched: 0, matched: 0, unmatched: [] });
    expect(fixturesMock).not.toHaveBeenCalled();
    expect(appearancesMock).not.toHaveBeenCalled();
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
