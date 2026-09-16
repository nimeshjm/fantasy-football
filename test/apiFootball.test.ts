import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  UEFA_LEAGUE_IDS,
  getFixtureSubstitutions,
  getRecentFinishedFixturesForTeam,
} from '../src/api/apiFootball';
import { API_FOOTBALL_TEAM_IDS, apiFootballTeamId } from '../src/api/apiFootballTeams';

const API_KEY = 'test-key';
const BENFICA_ID = 211;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function malformedJsonResponse(status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  } as unknown as Response;
}

describe('apiFootballTeamId', () => {
  it('resolves a mapped club', () => {
    expect(apiFootballTeamId('SLB')).toBe(API_FOOTBALL_TEAM_IDS.SLB);
    expect(apiFootballTeamId('SLB')).toBe(211);
  });

  it('is undefined, not an error, for an unmapped club', () => {
    expect(apiFootballTeamId('FCA')).toBeUndefined();
  });
});

describe('getRecentFinishedFixturesForTeam', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges finished fixtures across all three competitions, filtering non-FT and sending the auth header', async () => {
    // UCL: one finished fixture (Benfica away) plus one not-yet-played fixture.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        response: [
          {
            fixture: { id: 1001, date: '2026-09-15T19:00:00+00:00', status: { short: 'FT' } },
            teams: {
              home: { id: 489, name: 'AC Milan' },
              away: { id: BENFICA_ID, name: 'SL Benfica' },
            },
          },
          {
            fixture: { id: 1002, date: '2026-10-01T19:00:00+00:00', status: { short: 'NS' } },
            teams: {
              home: { id: BENFICA_ID, name: 'SL Benfica' },
              away: { id: 999, name: 'Some Other Club' },
            },
          },
        ],
      }),
    );
    // UEL: one finished fixture (Benfica home).
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        response: [
          {
            fixture: { id: 2001, date: '2026-09-20T19:00:00+00:00', status: { short: 'FT' } },
            teams: {
              home: { id: BENFICA_ID, name: 'SL Benfica' },
              away: { id: 500, name: 'Ferencvaros' },
            },
          },
        ],
      }),
    );
    // UECL: nothing for this club.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { response: [] }));

    const result = await getRecentFinishedFixturesForTeam(
      API_KEY,
      BENFICA_ID,
      '2026-08-01T00:00:00Z',
    );

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        {
          fixtureId: 1001,
          competition: 'UCL',
          opponent: 'AC Milan',
          kickoffTime: '2026-09-15T19:00:00+00:00',
        },
        {
          fixtureId: 2001,
          competition: 'UEL',
          opponent: 'Ferencvaros',
          kickoffTime: '2026-09-20T19:00:00+00:00',
        },
      ]),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/fixtures?');
    expect(url).toContain(`team=${BENFICA_ID}`);
    expect(url).toContain(`league=${UEFA_LEAGUE_IDS.UCL}`);
    expect(url).toContain('from=2026-08-01');
    expect(url).toContain('status=FT');
    expect((init.headers as Record<string, string>)['x-apisports-key']).toBe(API_KEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns an empty list, never throws, on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network connection lost.'));

    const result = await getRecentFinishedFixturesForTeam(
      API_KEY,
      BENFICA_ID,
      '2026-08-01T00:00:00Z',
    );

    expect(result).toEqual([]);
  });

  it('returns an empty list, never throws, on a non-200 status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { message: 'internal error' }));

    const result = await getRecentFinishedFixturesForTeam(
      API_KEY,
      BENFICA_ID,
      '2026-08-01T00:00:00Z',
    );

    expect(result).toEqual([]);
  });

  it('returns an empty list, never throws, on an unparseable body', async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse());

    const result = await getRecentFinishedFixturesForTeam(
      API_KEY,
      BENFICA_ID,
      '2026-08-01T00:00:00Z',
    );

    expect(result).toEqual([]);
  });

  it('returns an empty list, never throws, on a 200 response carrying API-Football errors', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { errors: { token: 'Invalid API token' }, response: [] }),
    );

    const result = await getRecentFinishedFixturesForTeam(
      API_KEY,
      BENFICA_ID,
      '2026-08-01T00:00:00Z',
    );

    expect(result).toEqual([]);
  });
});

describe('getFixtureSubstitutions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const lineupsBody = {
    response: [
      {
        team: { id: BENFICA_ID },
        startXI: [
          { player: { id: 1, name: 'Trubin' } },
          { player: { id: 2, name: 'Otamendi' } },
          { player: { id: 3, name: 'Fredrik' } },
        ],
        substitutes: [{ player: { id: 4, name: 'Kokcu' } }, { player: { id: 5, name: 'Unused' } }],
      },
      {
        team: { id: 489 },
        startXI: [{ player: { id: 10, name: 'Maignan' } }, { player: { id: 11, name: 'Pulisic' } }],
        substitutes: [{ player: { id: 12, name: 'Leao' } }],
      },
    ],
  };

  it('produces one row per starter and substitute who appeared, correctly derives subst direction (including a field-order-reversed event and a sub-for-sub), and excludes an unused substitute', async () => {
    const eventsBody = {
      response: [
        {
          time: { elapsed: 61, extra: null },
          type: 'subst',
          // Documented-convention order: player=off (a starter), assist=on.
          player: { id: 3, name: 'Fredrik' },
          assist: { id: 4, name: 'Kokcu' },
        },
        {
          time: { elapsed: 70, extra: null },
          type: 'subst',
          // Field order reversed vs. the documented convention: `player` is
          // the substitute coming ON, `assist` is the starter going OFF.
          // Only the structural (startXI-membership) rule gets this right.
          player: { id: 12, name: 'Leao' },
          assist: { id: 11, name: 'Pulisic' },
        },
        {
          time: { elapsed: 80, extra: null },
          type: 'subst',
          // Sub-for-sub: neither side is an original starter. Falls back to
          // the documented convention (player=off, assist=on).
          player: { id: 4, name: 'Kokcu' },
          assist: { id: 6, name: 'NewSub' },
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, eventsBody));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, lineupsBody));

    const result = await getFixtureSubstitutions(API_KEY, 1001);

    const byName = new Map(result.map((a) => [a.playerName, a]));
    expect(byName.size).toBe(8);
    expect(byName.has('Unused')).toBe(false);

    expect(byName.get('Trubin')).toEqual({
      playerName: 'Trubin',
      started: true,
      subbedOffMinute: null,
      minutesPlayed: 90,
    });
    expect(byName.get('Fredrik')).toEqual({
      playerName: 'Fredrik',
      started: true,
      subbedOffMinute: 61,
      minutesPlayed: 61,
    });
    expect(byName.get('Kokcu')).toEqual({
      playerName: 'Kokcu',
      started: false,
      subbedOffMinute: 80,
      minutesPlayed: 19, // on at 61, off at 80
    });
    // Reversed-field event: Pulisic (a starter) is the one who actually went
    // off, even though it rode in on the `assist` field.
    expect(byName.get('Pulisic')).toEqual({
      playerName: 'Pulisic',
      started: true,
      subbedOffMinute: 70,
      minutesPlayed: 70,
    });
    // Leao (a substitute) is the one who came on, even though it rode in on
    // the `player` field.
    expect(byName.get('Leao')).toEqual({
      playerName: 'Leao',
      started: false,
      subbedOffMinute: null,
      minutesPlayed: 20, // on at 70, never subbed off -> 90 - 70
    });
    expect(byName.get('NewSub')).toEqual({
      playerName: 'NewSub',
      started: false,
      subbedOffMinute: null,
      minutesPlayed: 10, // on at 80, never subbed off -> 90 - 80
    });
  });

  it('returns everyone who started at 90 minutes when there are no substitution events', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { response: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, lineupsBody));

    const result = await getFixtureSubstitutions(API_KEY, 1001);

    expect(result).toHaveLength(5); // all 5 starters across both teams
    for (const appearance of result) {
      expect(appearance.started).toBe(true);
      expect(appearance.subbedOffMinute).toBeNull();
      expect(appearance.minutesPlayed).toBe(90);
    }
  });

  it('returns an empty list, never throws, on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network connection lost.'));

    const result = await getFixtureSubstitutions(API_KEY, 1001);

    expect(result).toEqual([]);
  });

  it('returns an empty list, never throws, on a non-200 status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { message: 'unavailable' }));

    const result = await getFixtureSubstitutions(API_KEY, 1001);

    expect(result).toEqual([]);
  });

  it('returns an empty list, never throws, on an unparseable body', async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse());

    const result = await getFixtureSubstitutions(API_KEY, 1001);

    expect(result).toEqual([]);
  });

  it('returns an empty list, never throws, on a 200 response carrying API-Football errors', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { errors: { rateLimit: 'Too many requests' }, response: [] }),
    );

    const result = await getFixtureSubstitutions(API_KEY, 1001);

    expect(result).toEqual([]);
  });

  it('returns an empty list, never throws, when lineups are missing but events succeed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { response: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { response: [] }));

    const result = await getFixtureSubstitutions(API_KEY, 1001);

    expect(result).toEqual([]);
  });
});
