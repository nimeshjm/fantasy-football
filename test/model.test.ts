/**
 * Tests for src/model/ratings.ts and src/model/projection.ts.
 */
import { describe, expect, it } from 'vitest';
import { expectedGoals, fitTeamRatings } from '../src/model/ratings';
import {
  poissonFloorDivExpectation,
  projectAll,
  projectPlayer,
  STRATEGY_EP_NEXT,
  STRATEGY_MODEL_V2,
} from '../src/model/projection';
import { Position, type Element, type Fixture, type GwStats } from '../src/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFixture(
  overrides: Partial<Fixture> & Pick<Fixture, 'id' | 'team_h' | 'team_a'>,
): Fixture {
  return {
    code: overrides.id,
    event: 1,
    team_h_score: null,
    team_a_score: null,
    kickoff_time: null,
    started: true,
    finished: true,
    minutes: 90,
    ...overrides,
  };
}

let nextElementId = 1;
function makeElement(overrides: Partial<Element> = {}): Element {
  const id = overrides.id ?? nextElementId++;
  return {
    id,
    code: id,
    web_name: `Player${id}`,
    first_name: 'First',
    second_name: 'Last',
    team: 1,
    element_type: Position.MID,
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
    minutes: 0,
    removed: false,
    can_select: true,
    can_transact: true,
    ...overrides,
  };
}

function makeGwStats(
  overrides: Partial<GwStats> & Pick<GwStats, 'element_id' | 'event' | 'fixture_id'>,
): GwStats {
  return {
    minutes: 90,
    goals_scored: 0,
    assists: 0,
    clean_sheets: 0,
    goals_conceded: 0,
    penalties_saved: 0,
    penalties_missed: 0,
    yellow_cards: 0,
    red_cards: 0,
    saves: 0,
    own_goals: 0,
    attacking_bonus: 0,
    defending_bonus: 0,
    winning_goals: 0,
    key_passes: 0,
    clearances_blocks_interceptions: 0,
    recoveries: 0,
    shots_on_target: 0,
    total_points: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ratings.ts
// ---------------------------------------------------------------------------

describe('fitTeamRatings', () => {
  it('returns the neutral rating and prior home advantage with no finished fixtures', () => {
    const model = fitTeamRatings([]);
    expect(model.ratings.size).toBe(0);
    const eg = expectedGoals(model, 1, 2);
    // Neutral attack/defence (1,1) for both sides -> home = leagueAvgGoals * homeAdvantage.
    expect(eg.home).toBeCloseTo(model.leagueAvgGoals * model.homeAdvantage, 10);
    expect(eg.away).toBeCloseTo(model.leagueAvgGoals, 10);
  });

  it('rates a team that scores heavily and concedes little above the league mean', () => {
    // Team 1 beats everyone 4-0, home and away; the rest draw 1-1 among
    // themselves. Team 1 should end up with attack > 1 and defence < 1
    // (concedes less than average) relative to the rest.
    const fixtures: Fixture[] = [];
    let id = 1;
    for (const opponent of [2, 3, 4, 5]) {
      fixtures.push(
        makeFixture({ id: id++, team_h: 1, team_a: opponent, team_h_score: 4, team_a_score: 0 }),
      );
      fixtures.push(
        makeFixture({ id: id++, team_h: opponent, team_a: 1, team_h_score: 0, team_a_score: 4 }),
      );
    }
    // Filler draws among the "average" teams so they have their own evidence.
    fixtures.push(
      makeFixture({ id: id++, team_h: 2, team_a: 3, team_h_score: 1, team_a_score: 1 }),
    );
    fixtures.push(
      makeFixture({ id: id++, team_h: 4, team_a: 5, team_h_score: 1, team_a_score: 1 }),
    );

    const model = fitTeamRatings(fixtures, { shrinkage: 2 });
    const team1 = model.ratings.get(1)!;
    const team2 = model.ratings.get(2)!;
    expect(team1.attack).toBeGreaterThan(team2.attack);
    expect(team1.defence).toBeLessThan(team2.defence);
  });

  it('shrinks a single-game sample hard toward the league mean', () => {
    // Team 1 has exactly one game (a 5-0 win). With heavy shrinkage its
    // rating should stay much closer to 1 than a raw MLE fit would put it.
    const fixtures: Fixture[] = [
      makeFixture({ id: 1, team_h: 1, team_a: 2, team_h_score: 5, team_a_score: 0 }),
    ];
    const heavilyShrunk = fitTeamRatings(fixtures, { shrinkage: 50 });
    const lightlyShrunk = fitTeamRatings(fixtures, { shrinkage: 1 });
    const heavy = heavilyShrunk.ratings.get(1)!;
    const light = lightlyShrunk.ratings.get(1)!;
    expect(Math.abs(heavy.attack - 1)).toBeLessThan(Math.abs(light.attack - 1));
  });

  it('home advantage multiplier is > 1 when home teams outscore away teams', () => {
    const fixtures: Fixture[] = [
      makeFixture({ id: 1, team_h: 1, team_a: 2, team_h_score: 2, team_a_score: 0 }),
      makeFixture({ id: 2, team_h: 3, team_a: 4, team_h_score: 2, team_a_score: 0 }),
      makeFixture({ id: 3, team_h: 2, team_a: 1, team_h_score: 2, team_a_score: 0 }),
      makeFixture({ id: 4, team_h: 4, team_a: 3, team_h_score: 2, team_a_score: 0 }),
    ];
    const model = fitTeamRatings(fixtures);
    expect(model.homeAdvantage).toBeGreaterThan(1);
  });

  it('falls back to the neutral rating for a team absent from the fit (e.g. promoted club)', () => {
    const fixtures: Fixture[] = [
      makeFixture({ id: 1, team_h: 1, team_a: 2, team_h_score: 1, team_a_score: 1 }),
    ];
    const model = fitTeamRatings(fixtures);
    const eg = expectedGoals(model, 99, 1); // team 99 never played
    expect(Number.isFinite(eg.home)).toBe(true);
    expect(Number.isFinite(eg.away)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// projection.ts -- the critical floor(n/2) expectation
// ---------------------------------------------------------------------------

describe('poissonFloorDivExpectation', () => {
  it('differs from floor(mean / 2) at lambda = 3.5 (the critical correctness requirement)', () => {
    const lambda = 3.5;
    const naive = Math.floor(lambda / 2); // WRONG approach: floor(E[X]/2) = floor(1.75) = 1
    const correct = poissonFloorDivExpectation(lambda, 2);
    expect(naive).toBe(1);
    expect(correct).not.toBeCloseTo(naive, 5);
    // Sanity: the true expectation should be noticeably higher than the
    // naive floor-of-mean value for this lambda.
    expect(correct).toBeGreaterThan(naive);
  });

  it('converges to the closed-form analytic value for divisor 2', () => {
    // floor(X/2) = (X - (X mod 2)) / 2, and for X ~ Poisson(lambda),
    // P(X odd) = (1 - e^(-2*lambda)) / 2 (from the Poisson pgf at -1).
    // So E[floor(X/2)] = (lambda - (1 - e^(-2*lambda))/2) / 2 exactly.
    // A generous kMax=60 is used here on purpose, to test the summation
    // formula's convergence in isolation from the (much smaller, and
    // separately-tested-as-negligible) truncation error the default kMax
    // introduces at larger lambdas.
    for (const lambda of [0.5, 1.2, 3.5, 6.0, 9.3]) {
      const analytic = (lambda - (1 - Math.exp(-2 * lambda)) / 2) / 2;
      const computed = poissonFloorDivExpectation(lambda, 2, 60);
      expect(computed).toBeCloseTo(analytic, 8);
    }
  });

  it('is 0 for lambda <= 0', () => {
    expect(poissonFloorDivExpectation(0, 2)).toBe(0);
    expect(poissonFloorDivExpectation(-1, 2)).toBe(0);
  });

  it('truncation at a small kMax still closely matches the analytic value for modest lambda', () => {
    const lambda = 4;
    const analytic = (lambda - (1 - Math.exp(-2 * lambda)) / 2) / 2;
    const computed = poissonFloorDivExpectation(lambda, 2, 25);
    expect(computed).toBeCloseTo(analytic, 6);
  });
});

describe('projectPlayer (ep-next strategy)', () => {
  it('uses ep_next verbatim as xpts', () => {
    const el = makeElement({ ep_next: '5.3', status: 'a', chance_of_playing_next_round: null });
    const proj = projectPlayer(el, 5, { strategy: STRATEGY_EP_NEXT });
    expect(proj.xpts).toBeCloseTo(5.3, 6);
    expect(proj.element_id).toBe(el.id);
    expect(proj.event).toBe(5);
  });

  it('defaults to 0 xpts when ep_next is null or unparsable', () => {
    const el = makeElement({ ep_next: null });
    expect(projectPlayer(el, 1, { strategy: STRATEGY_EP_NEXT }).xpts).toBe(0);
  });

  it('is the default strategy when none is specified', () => {
    const el = makeElement({ ep_next: '2.0' });
    const proj = projectPlayer(el, 1);
    expect(proj.xpts).toBeCloseTo(2.0, 6);
  });

  it('projects 0 xmins for an unavailable player', () => {
    const el = makeElement({ status: 'u', ep_next: '4.0' });
    const proj = projectPlayer(el, 1, { strategy: STRATEGY_EP_NEXT });
    expect(proj.xmins).toBe(0);
  });
});

describe('projectPlayer / projectAll (model-v2 strategy)', () => {
  it('projects 0 for a team with a blank gameweek (absent from fixturesByTeam)', () => {
    const el = makeElement({ team: 1 });
    const proj = projectPlayer(el, 5, {
      strategy: STRATEGY_MODEL_V2,
      fixturesByTeam: new Map(), // team 1 has no fixture this gameweek
    });
    expect(proj.xmins).toBe(0);
    expect(proj.xpts).toBe(0);
  });

  it('gives a nailed-on, in-form forward a materially positive projection', () => {
    const el = makeElement({
      id: 100,
      team: 1,
      element_type: Position.FWD,
      now_cost: 80,
      status: 'a',
    });
    const trailing: GwStats[] = [1, 2, 3, 4].map((event) =>
      makeGwStats({
        element_id: 100,
        event,
        fixture_id: event,
        minutes: 90,
        goals_scored: 1,
        shots_on_target: 3,
      }),
    );
    const proj = projectPlayer(el, 5, {
      strategy: STRATEGY_MODEL_V2,
      fixturesByTeam: new Map([[1, { opponent: 2, isHome: true }]]),
      trailingStatsByElement: new Map([[100, trailing]]),
    });
    expect(proj.xmins).toBeGreaterThan(0);
    expect(proj.xpts).toBeGreaterThan(2);
  });

  it('fixture-adjusts an attacker upward against a weaker defence, downward against a stronger one', () => {
    // Team 10 is the constant attacking side. Team 20 concedes heavily
    // (weak defence); team 30 concedes almost nothing (strong defence).
    // Team 10's own attack rating stays identical across both fixtures, so
    // the only thing that can move the forward's projection is the
    // opponent's defence rating feeding into `expectedGoals`.
    const fixtures: Fixture[] = [
      makeFixture({ id: 1, team_h: 10, team_a: 20, team_h_score: 4, team_a_score: 1 }),
      makeFixture({ id: 2, team_h: 20, team_a: 10, team_h_score: 1, team_a_score: 4 }),
      makeFixture({ id: 3, team_h: 30, team_a: 40, team_h_score: 0, team_a_score: 0 }),
      makeFixture({ id: 4, team_h: 40, team_a: 30, team_h_score: 0, team_a_score: 0 }),
    ];
    const ratings = fitTeamRatings(fixtures, { shrinkage: 2 });

    const forward = makeElement({ id: 300, team: 10, element_type: Position.FWD, now_cost: 80 });
    const trailing: GwStats[] = [1, 2].map((event) =>
      makeGwStats({ element_id: 300, event, fixture_id: event, minutes: 90, shots_on_target: 3 }),
    );

    const common = {
      strategy: STRATEGY_MODEL_V2,
      ratings,
      trailingStatsByElement: new Map([[300, trailing]]),
    };

    const projVsWeakDefence = projectPlayer(forward, 5, {
      ...common,
      fixturesByTeam: new Map([[10, { opponent: 20, isHome: true }]]),
    });
    const projVsStrongDefence = projectPlayer(forward, 5, {
      ...common,
      fixturesByTeam: new Map([[10, { opponent: 30, isHome: true }]]),
    });

    expect(projVsWeakDefence.xpts).toBeGreaterThan(projVsStrongDefence.xpts);
  });

  it('prices a higher shots-on-target/saves prior for a premium player than a budget one with no trailing data', () => {
    // No trailing stats at all -- the projection falls back entirely to
    // the position+price prior, which is exactly the case the brief calls
    // out (shots_on_target/saves priors must come from position and price,
    // never from the zeroed element_history_past columns).
    const cheapKeeper = makeElement({ id: 400, element_type: Position.GK, now_cost: 40, team: 1 });
    const premiumKeeper = makeElement({
      id: 401,
      element_type: Position.GK,
      now_cost: 120,
      team: 2,
    });
    const positionAvgCost = {
      [Position.GK]: 45,
      [Position.DEF]: 45,
      [Position.MID]: 55,
      [Position.FWD]: 60,
    };
    const opts = {
      strategy: STRATEGY_MODEL_V2,
      fixturesByTeam: new Map([
        [1, { opponent: 99, isHome: true }],
        [2, { opponent: 98, isHome: true }],
      ]),
    };
    const cheapProj = projectPlayer(cheapKeeper, 5, opts, positionAvgCost);
    const premiumProj = projectPlayer(premiumKeeper, 5, opts, positionAvgCost);
    expect(premiumProj.xpts).toBeGreaterThan(cheapProj.xpts);
  });

  it('projectAll returns one projection per element and never throws on an empty pool', () => {
    const elements = [makeElement({ id: 1 }), makeElement({ id: 2 })];
    const result = projectAll(elements, 3, { strategy: STRATEGY_EP_NEXT });
    expect(result).toHaveLength(2);
    expect(projectAll([], 3)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// projectAll -- issue #24 regression: projections were all zero in
// production because the upcoming gameweek's fixtures never reached D1
// ---------------------------------------------------------------------------

describe("projectAll (model-v2 strategy) -- issue #24's missing assertion", () => {
  it('produces non-zero, non-identical xpts for players on teams with a fixture and real trailing minutes', () => {
    // This is the assertion whose absence let every production projection
    // ship as `xpts: 0` for an entire event (issue #24): nothing anywhere
    // checked that the happy path -- teams WITH a fixture, players WITH
    // trailing minutes -- actually produces a real, varied spread of
    // positive values. A bare `> 0` per player would also have passed on an
    // accidental constant (e.g. every player collapsing to the same
    // appearance-points-only figure), so this also asserts the spread.
    const gk = makeElement({ team: 1, element_type: Position.GK, now_cost: 45 });
    const def = makeElement({ team: 1, element_type: Position.DEF, now_cost: 45 });
    const mid = makeElement({ team: 2, element_type: Position.MID, now_cost: 60 });
    const fwd = makeElement({ team: 2, element_type: Position.FWD, now_cost: 85 });
    const elements = [gk, def, mid, fwd];

    const trailingFor = (elementId: number, overrides: Partial<GwStats>): GwStats[] =>
      [1, 2, 3, 4].map((event) =>
        makeGwStats({
          element_id: elementId,
          event,
          fixture_id: event,
          minutes: 90,
          ...overrides,
        }),
      );
    const trailingStatsByElement = new Map([
      [gk.id, trailingFor(gk.id, { saves: 4 })],
      [def.id, trailingFor(def.id, { shots_on_target: 1 })],
      [mid.id, trailingFor(mid.id, { shots_on_target: 2, goals_scored: 1, assists: 1 })],
      [fwd.id, trailingFor(fwd.id, { shots_on_target: 4, goals_scored: 2 })],
    ]);
    const fixturesByTeam = new Map([
      [1, { opponent: 2, isHome: true }],
      [2, { opponent: 1, isHome: false }],
    ]);

    const projections = projectAll(elements, 5, {
      strategy: STRATEGY_MODEL_V2,
      fixturesByTeam,
      trailingStatsByElement,
    });

    expect(projections).toHaveLength(4);
    for (const p of projections) {
      expect(p.xmins).toBeGreaterThan(0);
      expect(p.xpts).toBeGreaterThan(0);
    }
    // A genuine spread -- guards against an accidental constant that a bare
    // per-player "> 0" check would miss entirely.
    const xptsValues = projections.map((p) => p.xpts);
    const distinctValues = new Set(xptsValues.map((x) => x.toFixed(6)));
    expect(distinctValues.size).toBeGreaterThan(1);
    expect(Math.max(...xptsValues) - Math.min(...xptsValues)).toBeGreaterThan(1);
  });

  it('projects {xmins:0, xpts:0} for a team with no fixture in the event, while a team that DOES have one in the same event projects normally', () => {
    // Pins the per-team blank-gameweek branch (projection.ts:265-269) that
    // the event-wide "abort if the whole event has zero fixtures" guard
    // (issue #24's fix, plan step 2) depends on staying team-scoped: a
    // blank gameweek for SOME teams is a normal, expected weekly occurrence
    // and must keep projecting 0 for just those teams' players -- it must
    // never be conflated with (or masked by) the whole-event failure mode
    // this issue is about.
    const blankTeamPlayer = makeElement({ team: 1, element_type: Position.MID });
    const fixturedTeamPlayer = makeElement({ team: 2, element_type: Position.MID });
    const trailingFor = (elementId: number): GwStats[] =>
      [1, 2, 3, 4].map((event) =>
        makeGwStats({
          element_id: elementId,
          event,
          fixture_id: event,
          minutes: 90,
          goals_scored: 1,
        }),
      );
    const trailingStatsByElement = new Map([
      [blankTeamPlayer.id, trailingFor(blankTeamPlayer.id)],
      [fixturedTeamPlayer.id, trailingFor(fixturedTeamPlayer.id)],
    ]);
    // Team 1 (blankTeamPlayer's team) is absent from the map -- a blank
    // gameweek for that team only. Team 2 has a fixture in the same event.
    const fixturesByTeam = new Map([[2, { opponent: 3, isHome: true }]]);

    const [blankResult, fixturedResult] = projectAll([blankTeamPlayer, fixturedTeamPlayer], 5, {
      strategy: STRATEGY_MODEL_V2,
      fixturesByTeam,
      trailingStatsByElement,
    });

    expect(blankResult).toMatchObject({ xmins: 0, xpts: 0 });
    expect(fixturedResult!.xmins).toBeGreaterThan(0);
    expect(fixturedResult!.xpts).toBeGreaterThan(0);
  });
});
