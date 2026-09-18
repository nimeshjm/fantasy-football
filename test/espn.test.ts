import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ESPN_LEAGUE_SLUGS,
  ESPN_USER_AGENT,
  FULL_MATCH_MINUTES,
  getFixtureAppearances,
  getRecentFinishedFixturesForTeam,
} from '../src/api/espn';
import scheduleFixture from './fixtures/espn-schedule-benfica-uel.json';
import summaryFixture from './fixtures/espn-summary-milan-benfica.json';

const BENFICA_ID = 1929;
const FIXTURE_ID = 401915586;

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

function emptySchedule(): Response {
  return jsonResponse(200, { events: [] });
}

describe('getRecentFinishedFixturesForTeam', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hits all three league slugs with the User-Agent header and an abort signal, and parses the real cassette', async () => {
    fetchMock.mockResolvedValueOnce(emptySchedule()); // UCL
    fetchMock.mockResolvedValueOnce(jsonResponse(200, scheduleFixture)); // UEL
    fetchMock.mockResolvedValueOnce(emptySchedule()); // UECL

    const result = await getRecentFinishedFixturesForTeam(BENFICA_ID, '2026-01-01T00:00:00Z');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((call) => (call as [string])[0]);
    expect(urls[0]).toContain(`/${ESPN_LEAGUE_SLUGS.UCL}/teams/${BENFICA_ID}/schedule`);
    expect(urls[1]).toContain(`/${ESPN_LEAGUE_SLUGS.UEL}/teams/${BENFICA_ID}/schedule`);
    expect(urls[2]).toContain(`/${ESPN_LEAGUE_SLUGS.UECL}/teams/${BENFICA_ID}/schedule`);

    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>)['User-Agent']).toBe(ESPN_USER_AGENT);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }

    expect(result).toEqual([
      {
        fixtureId: FIXTURE_ID,
        competition: 'UEL',
        opponent: 'AC Milan',
        kickoffTime: '2026-09-16T19:00Z',
      },
    ]);
  });

  it('derives the opponent from competitors[].team.id, never from the event name, whether we are home or away', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        events: [
          {
            id: '1',
            date: '2026-09-01T19:00Z',
            name: 'Totally Unrelated Text', // must never be parsed
            competitions: [
              {
                status: { type: { name: 'STATUS_FULL_TIME' } },
                competitors: [
                  { homeAway: 'away', team: { id: '500', displayName: 'Away Opponent' } },
                  { homeAway: 'home', team: { id: String(BENFICA_ID), displayName: 'Benfica' } },
                ],
              },
            ],
          },
          {
            id: '2',
            date: '2026-09-08T19:00Z',
            name: 'Also Unrelated',
            competitions: [
              {
                status: { type: { name: 'STATUS_FULL_TIME' } },
                competitors: [
                  { homeAway: 'home', team: { id: String(BENFICA_ID), displayName: 'Benfica' } },
                  { homeAway: 'away', team: { id: '600', displayName: 'Home Opponent' } },
                ],
              },
            ],
          },
        ],
      }),
    );

    const result = await getRecentFinishedFixturesForTeam(BENFICA_ID, '2026-01-01T00:00:00Z');

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fixtureId: 1, opponent: 'Away Opponent' }),
        expect.objectContaining({ fixtureId: 2, opponent: 'Home Opponent' }),
      ]),
    );
  });

  it('keeps only STATUS_FULL_TIME events', async () => {
    const statuses = [
      'STATUS_SCHEDULED',
      'STATUS_IN_PROGRESS',
      'STATUS_POSTPONED',
      'STATUS_ABANDONED',
    ];
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        events: [
          ...statuses.map((name, i) => ({
            id: String(100 + i),
            date: '2026-09-01T19:00Z',
            competitions: [
              {
                status: { type: { name } },
                competitors: [
                  { team: { id: '500', displayName: 'Opponent' } },
                  { team: { id: String(BENFICA_ID), displayName: 'Benfica' } },
                ],
              },
            ],
          })),
          {
            id: '999',
            date: '2026-09-01T19:00Z',
            competitions: [
              {
                status: { type: { name: 'STATUS_FULL_TIME' } },
                competitors: [
                  { team: { id: '500', displayName: 'Opponent' } },
                  { team: { id: String(BENFICA_ID), displayName: 'Benfica' } },
                ],
              },
            ],
          },
        ],
      }),
    );

    const result = await getRecentFinishedFixturesForTeam(BENFICA_ID, '2026-01-01T00:00:00Z');

    expect(result).toHaveLength(1);
    expect(result[0]?.fixtureId).toBe(999);
  });

  function fullTimeEvent(id: string, date: string) {
    return {
      id,
      date,
      competitions: [
        {
          status: { type: { name: 'STATUS_FULL_TIME' } },
          competitors: [
            { team: { id: '500', displayName: 'Opponent' } },
            { team: { id: String(BENFICA_ID), displayName: 'Benfica' } },
          ],
        },
      ],
    };
  }

  it('drops events older than sinceIso and keeps one exactly at the bound', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        events: [
          fullTimeEvent('1', '2026-08-31T23:59:59Z'),
          fullTimeEvent('2', '2026-09-01T00:00:00Z'),
          fullTimeEvent('3', '2026-09-02T00:00:00Z'),
        ],
      }),
    );

    const result = await getRecentFinishedFixturesForTeam(BENFICA_ID, '2026-09-01T00:00:00Z');

    expect(result.map((f) => f.fixtureId).sort()).toEqual([2, 3]);
  });

  it('keeps nothing when sinceIso is unparseable, rather than treating a NaN bound as "keep everything"', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { events: [fullTimeEvent('1', '2026-09-01T00:00:00Z')] }),
    );

    const result = await getRecentFinishedFixturesForTeam(BENFICA_ID, 'not-a-date');

    expect(result).toEqual([]);
  });

  it('skips an event with a non-numeric id', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        events: [
          fullTimeEvent('not-a-number', '2026-09-01T00:00:00Z'),
          fullTimeEvent('42', '2026-09-01T00:00:00Z'),
        ],
      }),
    );

    const result = await getRecentFinishedFixturesForTeam(BENFICA_ID, '2026-01-01T00:00:00Z');

    expect(result).toEqual([
      {
        fixtureId: 42,
        competition: 'UECL',
        opponent: 'Opponent',
        kickoffTime: '2026-09-01T00:00:00Z',
      },
    ]);
  });

  it('dedupes a fixture id returned by more than one slug', async () => {
    fetchMock.mockResolvedValueOnce(emptySchedule()); // UCL
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { events: [fullTimeEvent('7', '2026-09-01T00:00:00Z')] }),
    ); // UEL
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { events: [fullTimeEvent('7', '2026-09-01T00:00:00Z')] }),
    ); // UECL

    const result = await getRecentFinishedFixturesForTeam(BENFICA_ID, '2026-01-01T00:00:00Z');

    expect(result).toHaveLength(1);
    expect(result[0]?.fixtureId).toBe(7);
  });

  it('does not let one slug returning nothing (empty events, or a hard failure) suppress fixtures from the others', async () => {
    fetchMock.mockResolvedValueOnce(emptySchedule()); // UCL: nothing to report
    fetchMock.mockRejectedValueOnce(new TypeError('network down')); // UEL: hard failure
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { events: [fullTimeEvent('9', '2026-09-01T00:00:00Z')] }),
    ); // UECL

    const result = await getRecentFinishedFixturesForTeam(BENFICA_ID, '2026-01-01T00:00:00Z');

    expect(result).toEqual([
      {
        fixtureId: 9,
        competition: 'UECL',
        opponent: 'Opponent',
        kickoffTime: '2026-09-01T00:00:00Z',
      },
    ]);
  });

  it('returns [], never throws, on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network connection lost.'));

    expect(await getRecentFinishedFixturesForTeam(BENFICA_ID, '2026-01-01T00:00:00Z')).toEqual([]);
  });

  it('returns [], never throws, on a non-200 status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { message: 'internal error' }));

    expect(await getRecentFinishedFixturesForTeam(BENFICA_ID, '2026-01-01T00:00:00Z')).toEqual([]);
  });

  it('returns [], never throws, on an unparseable body', async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse());

    expect(await getRecentFinishedFixturesForTeam(BENFICA_ID, '2026-01-01T00:00:00Z')).toEqual([]);
  });

  it('returns [], never throws, on a 200 whose shape is not a schedule at all', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { events: 'not-an-array' }));

    expect(await getRecentFinishedFixturesForTeam(BENFICA_ID, '2026-01-01T00:00:00Z')).toEqual([]);
  });
});

describe('getFixtureAppearances', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fixture = { fixtureId: FIXTURE_ID, competition: 'UEL' as const };

  function cloneFixture(): typeof summaryFixture {
    return structuredClone(summaryFixture);
  }

  function benficaRoster(body: ReturnType<typeof cloneFixture>) {
    const roster = body.rosters.find((r) => r.team.id === String(BENFICA_ID));
    if (!roster) throw new Error('fixture missing the Benfica roster');
    return roster.roster;
  }

  it("fetches the summary at the fixture competition's own slug with the User-Agent header and an abort signal", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, summaryFixture));

    await getFixtureAppearances(fixture, BENFICA_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/${ESPN_LEAGUE_SLUGS.UEL}/summary?event=${FIXTURE_ID}`);
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(ESPN_USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('builds the summary URL from the given competition, not by guessing', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, summaryFixture));

    await getFixtureAppearances({ fixtureId: FIXTURE_ID, competition: 'UCL' }, BENFICA_ID);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/${ESPN_LEAGUE_SLUGS.UCL}/summary?event=${FIXTURE_ID}`);
  });

  it('returns only players who appeared for our own club from the real cassette, excluding unused substitutes', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, summaryFixture));

    const result = await getFixtureAppearances(fixture, BENFICA_ID);

    expect(result).toHaveLength(16);
    for (const unused of [
      'Anísio Cabral',
      'Rafa Silva',
      'Clément Lenglet',
      'Samuel Soares',
      'Claudio Echeverri',
      'Enzo Barrenechea',
      'Manu Silva',
    ]) {
      expect(result.find((a) => a.playerName === unused)).toBeUndefined();
    }
    // None of AC Milan's 23 players leak into Benfica's list.
    expect(result.find((a) => a.playerName === 'Christian Pulisic')).toBeUndefined();
  });

  it('derives minutes for all five real substitution shapes', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, summaryFixture));

    const result = await getFixtureAppearances(fixture, BENFICA_ID);
    const byName = new Map(result.map((a) => [a.playerName, a]));

    expect(byName.get('Anatoliy Trubin')).toMatchObject({
      started: true,
      subbedOffMinute: null,
      minutesPlayed: FULL_MATCH_MINUTES,
    });
    expect(byName.get('Fredrik Aursnes')).toMatchObject({
      started: true,
      subbedOffMinute: 70,
      minutesPlayed: 70,
    });
    expect(byName.get('Leandro Barreiro')).toMatchObject({
      started: false,
      subbedOffMinute: null,
      minutesPlayed: 20, // on at 70, never subbed off -> 90 - 70
    });
    expect(byName.get('Vangelis Pavlidis')).toMatchObject({
      started: false,
      subbedOffMinute: null,
      minutesPlayed: 10, // on at 80, never subbed off -> 90 - 80
    });
    expect(byName.get('Samuel Dahl')).toMatchObject({
      started: false,
      subbedOffMinute: null,
      minutesPlayed: 2, // on at 88, never subbed off -> 90 - 88
    });
  });

  it('produces a synthetic sub-for-sub correctly: on at N, off at M -> M - N', async () => {
    const body = cloneFixture();
    const roster = benficaRoster(body);

    // Pavlidis (came on at 80 in the real match) is now also subbed off at
    // minute 85 by a brand-new player -- a shape the real match never
    // produced, but the join logic must handle it the same way.
    const pavlidis = roster.find((e) => e.athlete.id === '220819');
    if (!pavlidis) throw new Error('fixture missing Pavlidis');
    pavlidis.subbedOut = true;
    roster.push({
      starter: false,
      subbedIn: true,
      subbedOut: false,
      athlete: { id: '999001', fullName: 'Synthetic Sub', lastName: 'Sub' },
    });
    body.keyEvents.push({
      type: { type: 'substitution' },
      clock: { value: 5100, displayValue: "85'" },
      participants: [{ athlete: { id: '999001' } }, { athlete: { id: '220819' } }],
    });

    fetchMock.mockResolvedValue(jsonResponse(200, body));
    const result = await getFixtureAppearances(fixture, BENFICA_ID);

    const pavlidisAppearance = result.find((a) => a.playerName === 'Vangelis Pavlidis');
    expect(pavlidisAppearance).toMatchObject({ subbedOffMinute: 85, minutesPlayed: 5 }); // 85 - 80
  });

  it('clamps a stoppage-time substitution and a would-be negative duration to 0..90', async () => {
    const body = cloneFixture();

    // Replace the real 88' El Karouani-off/Dahl-on event with one at 92'
    // (stoppage time): El Karouani's subbedOffMinute must clamp to 90, and
    // Dahl's minutesPlayed (90 - 92, otherwise negative) must clamp to 0.
    body.keyEvents = body.keyEvents.filter(
      (e) => !e.participants.some((p) => p.athlete.id === '291730'),
    );
    body.keyEvents.push({
      type: { type: 'substitution' },
      clock: { value: 5520, displayValue: "92'" }, // 5520 / 60 = 92
      participants: [{ athlete: { id: '329653' } }, { athlete: { id: '291730' } }],
    });

    fetchMock.mockResolvedValue(jsonResponse(200, body));
    const result = await getFixtureAppearances(fixture, BENFICA_ID);

    expect(result.find((a) => a.playerName === 'Souffian El Karouani')).toMatchObject({
      subbedOffMinute: 90,
      minutesPlayed: 90,
    });
    expect(result.find((a) => a.playerName === 'Samuel Dahl')).toMatchObject({
      subbedOffMinute: null,
      minutesPlayed: 0, // on at 92, stays on -> 90 - 92 clamped to 0
    });
  });

  it('joins substitutions to the roster by athlete.id, not by name, even when a same-named decoy exists', async () => {
    const body = cloneFixture();
    const roster = benficaRoster(body);

    // Real Sudakov (id 308603, subbed off at 70) is renamed to the
    // transliteration ESPN's own free-text fields use elsewhere for him.
    const sudakov = roster.find((e) => e.athlete.id === '308603');
    if (!sudakov) throw new Error('fixture missing Sudakov');
    sudakov.athlete.fullName = 'Heorhiy Sudakov';

    // A decoy who owns the "expected" spelling, is NOT involved in any
    // substitution, and must be untouched by the join.
    roster.push({
      starter: true,
      subbedIn: false,
      subbedOut: false,
      athlete: { id: '000001', fullName: 'Georgiy Sudakov', lastName: 'Sudakov' },
    });

    fetchMock.mockResolvedValue(jsonResponse(200, body));
    const result = await getFixtureAppearances(fixture, BENFICA_ID);

    expect(result.find((a) => a.playerName === 'Heorhiy Sudakov')).toMatchObject({
      subbedOffMinute: 70,
      minutesPlayed: 70,
    });
    expect(result.find((a) => a.playerName === 'Georgiy Sudakov')).toMatchObject({
      started: true,
      subbedOffMinute: null,
      minutesPlayed: FULL_MATCH_MINUTES,
    });
  });

  it('omits a player flagged subbedOut or subbedIn with no matching key event, rather than reporting 90', async () => {
    const body = cloneFixture();
    // Drop the Aursnes/Barreiro substitution event entirely: Aursnes still
    // says subbedOut, Barreiro still says subbedIn, but neither can be
    // resolved to a minute.
    body.keyEvents = body.keyEvents.filter(
      (e) => !e.participants.some((p) => p.athlete.id === '212900' || p.athlete.id === '271854'),
    );

    fetchMock.mockResolvedValue(jsonResponse(200, body));
    const result = await getFixtureAppearances(fixture, BENFICA_ID);

    expect(result.find((a) => a.playerName === 'Fredrik Aursnes')).toBeUndefined();
    expect(result.find((a) => a.playerName === 'Leandro Barreiro')).toBeUndefined();
    // The rest of the roster is unaffected.
    expect(result.find((a) => a.playerName === 'Anatoliy Trubin')).toMatchObject({
      minutesPlayed: 90,
    });
  });

  it('nulls playerLastName for a last name that recurs anywhere in the whole roster, including an unused sub', async () => {
    const body = cloneFixture();
    const roster = benficaRoster(body);

    // Real Benfica roster: "Rafa Silva" is an unused sub (excluded from the
    // output entirely) and "Manu Silva" is also an unused sub. Promoting
    // Rafa Silva to a starter puts one Silva into the output while the
    // OTHER Silva stays an unused sub -- the guard must still see both when
    // counting.
    const rafaSilva = roster.find((e) => e.athlete.id === '192421');
    if (!rafaSilva) throw new Error('fixture missing Rafa Silva');
    rafaSilva.starter = true;

    fetchMock.mockResolvedValue(jsonResponse(200, body));
    const result = await getFixtureAppearances(fixture, BENFICA_ID);

    expect(result.find((a) => a.playerName === 'Rafa Silva')).toMatchObject({
      playerLastName: null,
    });
    expect(result.find((a) => a.playerName === 'Anatoliy Trubin')).toMatchObject({
      playerLastName: 'Trubin',
    });
  });

  it('returns [] when rosters is missing or not our club', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { keyEvents: [] }));
    expect(await getFixtureAppearances(fixture, BENFICA_ID)).toEqual([]);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { rosters: [{ team: { id: '999' }, roster: [] }] }),
    );
    expect(await getFixtureAppearances(fixture, BENFICA_ID)).toEqual([]);
  });

  it('returns [], never throws, on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network connection lost.'));

    expect(await getFixtureAppearances(fixture, BENFICA_ID)).toEqual([]);
  });

  it('returns [], never throws, on a non-200 status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { message: 'unavailable' }));

    expect(await getFixtureAppearances(fixture, BENFICA_ID)).toEqual([]);
  });

  it('returns [], never throws, on an unparseable body', async () => {
    fetchMock.mockResolvedValue(malformedJsonResponse());

    expect(await getFixtureAppearances(fixture, BENFICA_ID)).toEqual([]);
  });

  it('returns [], never throws, on a 200 whose shape is not a summary at all', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { rosters: [{ team: { id: String(BENFICA_ID) }, roster: 'nope' }] }),
    );

    expect(await getFixtureAppearances(fixture, BENFICA_ID)).toEqual([]);
  });
});
