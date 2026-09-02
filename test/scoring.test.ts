/**
 * Independent tests for `scoreFixture` / `scoreGameweek`, written from
 * `src/types.ts` and the golden fixtures alone — the arithmetic here is
 * NOT derived from reading `src/scoring.ts`'s implementation, so a bug there
 * has a real chance of being caught rather than re-derived and rubber-stamped.
 */
import { describe, expect, it } from 'vitest';
import { scoreFixture, scoreGameweek } from '../src/scoring';
import { Position, type RawStats } from '../src/types';
import bootstrapStatic from './fixtures/bootstrap-static.json';
import live1 from './fixtures/live-1.json';
import live2 from './fixtures/live-2.json';
import live3 from './fixtures/live-3.json';
import live4 from './fixtures/live-4.json';

// ---------------------------------------------------------------------------
// Fixture shapes / loading helpers
// ---------------------------------------------------------------------------

/** One row of `live-N.json`'s `elements` array: [fixtureId, fixturePoints, statsArray]. */
type LiveFixtureRow = [number, number, number[]];

/** One row of `live-N.json`'s `elements` array: [elementId, totalPoints, fixtures]. */
type LiveElementRow = [number, number, LiveFixtureRow[]];

interface LiveFile {
  event: number;
  statKeys: string[];
  format: string;
  elements: LiveElementRow[];
}

const liveFiles: LiveFile[] = [live1, live2, live3, live4] as unknown as LiveFile[];

interface BootstrapElement {
  id: number;
  element_type: number;
}

const bootstrapElements = bootstrapStatic.elements as unknown as BootstrapElement[];

const positionByElementId = new Map<number, Position>();
for (const el of bootstrapElements) {
  positionByElementId.set(el.id, el.element_type as Position);
}

/** Rebuild a `RawStats` object from a positional stats array using the file's own statKeys order. */
function toRawStats(statKeys: readonly string[], values: readonly number[]): RawStats {
  if (values.length !== statKeys.length) {
    throw new Error(`stats array length ${values.length} does not match statKeys length ${statKeys.length}`);
  }
  const record: Record<string, number> = {};
  statKeys.forEach((key, index) => {
    record[key] = values[index]!;
  });
  return record as unknown as RawStats;
}

// ---------------------------------------------------------------------------
// 1. Golden replay across all four gameweeks
// ---------------------------------------------------------------------------

describe('golden replay against live-N.json (GW1-4)', () => {
  // Computed independently of the replay loop below, straight from the raw
  // fixture data, so the final assertion cannot be satisfied by a loop that
  // silently iterates zero times.
  const expectedFixtureRowCount = liveFiles.reduce(
    (sum, file) => sum + file.elements.reduce((s, [, , fixtures]) => s + fixtures.length, 0),
    0,
  );

  it(`replays all ${expectedFixtureRowCount} fixture rows across GW1-4 exactly`, () => {
    expect(expectedFixtureRowCount).toBeGreaterThan(2000);

    let checkedFixtureRows = 0;
    let checkedElements = 0;

    for (const file of liveFiles) {
      for (const [elementId, totalPoints, fixtures] of file.elements) {
        const position = positionByElementId.get(elementId);
        if (position === undefined) {
          throw new Error(`GW${file.event} element ${elementId}: no element_type in bootstrap-static.json`);
        }

        const perFixtureStats: RawStats[] = [];
        for (const [fixtureId, fixturePoints, statsArray] of fixtures) {
          const stats = toRawStats(file.statKeys, statsArray);
          perFixtureStats.push(stats);

          const computed = scoreFixture(stats, position);
          expect(
            computed,
            `GW${file.event} element ${elementId} fixture ${fixtureId}: expected ${fixturePoints}, got ${computed}`,
          ).toBe(fixturePoints);
          checkedFixtureRows++;
        }

        const gwTotal = scoreGameweek(perFixtureStats, position);
        expect(
          gwTotal,
          `GW${file.event} element ${elementId}: gameweek total expected ${totalPoints}, got ${gwTotal}`,
        ).toBe(totalPoints);
        checkedElements++;
      }
    }

    expect(checkedElements).toBeGreaterThan(0);
    expect(checkedFixtureRows).toBe(expectedFixtureRowCount);
  });
});

// ---------------------------------------------------------------------------
// 2. Divisor guards
// ---------------------------------------------------------------------------

/** A stat line with everything zeroed out, so a test can set only the fields it cares about. */
function blankStats(overrides: Partial<RawStats> = {}): RawStats {
  return {
    minutes: 0,
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
    ...overrides,
  };
}

describe('divisor guards', () => {
  describe('saves: floor(n / 2), independent of position', () => {
    it.each([
      [2, 1],
      [4, 2],
      [6, 3],
      [8, 4],
    ])('%d saves -> %d points', (saves, expectedPoints) => {
      for (const position of [Position.GK, Position.DEF, Position.MID, Position.FWD]) {
        const stats = blankStats({ saves });
        expect(scoreFixture(stats, position), `position ${position}`).toBe(expectedPoints);
      }
    });
  });

  describe('shots_on_target: floor(n / 2), independent of position', () => {
    it.each([
      [2, 1],
      [3, 1],
    ])('%d shots on target -> %d points', (shots, expectedPoints) => {
      for (const position of [Position.GK, Position.DEF, Position.MID, Position.FWD]) {
        const stats = blankStats({ shots_on_target: shots });
        expect(scoreFixture(stats, position), `position ${position}`).toBe(expectedPoints);
      }
    });
  });

  describe('goals_conceded: -floor(n / 2) for GK/DEF only, 0 for MID/FWD', () => {
    it.each([
      [2, -1],
      [3, -1],
      [4, -2],
      [7, -3],
    ])('%d goals conceded -> %d points for GK/DEF, 0 for MID/FWD', (conceded, expectedPenalty) => {
      const stats = blankStats({ goals_conceded: conceded });
      expect(scoreFixture(stats, Position.GK), 'GK').toBe(expectedPenalty);
      expect(scoreFixture(stats, Position.DEF), 'DEF').toBe(expectedPenalty);
      expect(scoreFixture(stats, Position.MID), 'MID').toBe(0);
      expect(scoreFixture(stats, Position.FWD), 'FWD').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Appearance rule guards
// ---------------------------------------------------------------------------

describe('appearance rule guards', () => {
  it.each([
    [0, 0],
    [1, 1],
    [59, 1],
    [60, 2],
    [90, 2],
  ])('%d minutes -> %d appearance points', (minutes, expectedPoints) => {
    const stats = blankStats({ minutes });
    // Use FWD, a position with no other points-bearing default fields, so the
    // fixture score is purely the appearance contribution.
    expect(scoreFixture(stats, Position.FWD)).toBe(expectedPoints);
  });

  it('a benched GK (0 minutes) with a yellow card still scores -1: cards score without an appearance', () => {
    // Regression for FPL-329 (GW4 element 329): a goalkeeper with 0 minutes
    // and 1 yellow card has total_points -1. An early `return 0` on
    // minutes <= 0 would silently drop the card penalty.
    const stats = blankStats({ minutes: 0, yellow_cards: 1 });
    expect(scoreFixture(stats, Position.GK)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 4. Non-distributivity: fixture boundary matters for a double gameweek
// ---------------------------------------------------------------------------

describe('non-distributivity across fixtures (double gameweek trap)', () => {
  it('two fixtures of 3 saves each score less than one fixture of 6 saves', () => {
    const threeSaves = blankStats({ saves: 3 });
    const sixSaves = blankStats({ saves: 6 });

    const doubleGameweekTotal = scoreGameweek([threeSaves, threeSaves], Position.GK);
    const singleFixtureTotal = scoreFixture(sixSaves, Position.GK);

    // floor(3/2)*2 = 2, not floor(6/2) = 3. The divisor must NOT distribute
    // over fixture-summed stats.
    expect(doubleGameweekTotal).toBe(2);
    expect(singleFixtureTotal).toBe(3);
    expect(doubleGameweekTotal).not.toBe(singleFixtureTotal);
  });

  it('two fixtures of 30 minutes each earn two short appearances, not one long one', () => {
    const shortSpell = blankStats({ minutes: 30 });
    const oneLongSpell = blankStats({ minutes: 60 });

    const doubleGameweekTotal = scoreGameweek([shortSpell, shortSpell], Position.MID);
    const singleFixtureTotal = scoreFixture(oneLongSpell, Position.MID);

    expect(doubleGameweekTotal).toBe(2); // 1 + 1
    expect(singleFixtureTotal).toBe(2); // both happen to equal 2 here...
    // ...but arrived at differently: confirm the double gameweek is really
    // two separate short-appearance awards, not a merged long one.
    expect(scoreFixture(shortSpell, Position.MID)).toBe(1);
  });
});
