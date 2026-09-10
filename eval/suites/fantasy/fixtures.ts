/**
 * Shared point-in-time fixtures for the fantasy eval suite and
 * `test/backtest.test.ts`.
 *
 * `test/fixtures/bootstrap-static.json` is a single snapshot taken after
 * GW4 -- there is no per-gameweek history of `ep_next` anywhere, so any use
 * of this data must reconstruct "as of just before gameweek g" state by
 * hand rather than trust a field that already knows the future.
 * `pointInTimeState(g)` restricts every one of its inputs to `event < g`;
 * `ep_next` is forced to null on every element so the one leak big enough
 * to matter (the site's own forecast) cannot round-trip through. Two
 * smaller leaks are unavoidable with one snapshot and left in on purpose:
 * `status` / `chance_of_playing_next_round` and `now_cost` both carry a
 * little GW1-4 hindsight, but they pull in opposite directions and each
 * perturbs one factor in a model with several independent inputs -- see
 * `test/backtest.test.ts`'s module docstring for the full argument.
 * `realizedPoints`/`appearedInEvent` are the exception: they deliberately
 * read gameweek `g` itself, because they exist to score a prediction
 * against it, not to feed one. Never pass their output into a model as an
 * input -- that would be exactly the leak this file exists to prevent.
 */
import { fitTeamRatings, type FitRatingsOptions } from '../../../src/model/ratings';
import {
  projectAll,
  STRATEGY_MODEL_V2,
  groupFixturesByTeam,
  type UpcomingFixtureInfo,
} from '../../../src/model/projection';
import { deriveGwStatsFromLive } from '../../../src/workflows/ingest';
import type { EventLive, LiveExplainStat } from '../../../src/api/endpoints';
import {
  Position,
  type Element,
  type Fixture,
  type GwStats,
  type Projection,
} from '../../../src/types';

import bootstrapStatic from '../../../test/fixtures/bootstrap-static.json';
import fixtures1to4 from '../../../test/fixtures/fixtures-1-4.json';
import live1 from '../../../test/fixtures/live-1.json';
import live2 from '../../../test/fixtures/live-2.json';
import live3 from '../../../test/fixtures/live-3.json';
import live4 from '../../../test/fixtures/live-4.json';

/** `bootstrap-static.json`'s per-element shape -- a reduced projection of
 * `Element`, not the full API shape (see `toElement` for what's filled in). */
export interface BootstrapElement {
  id: number;
  web_name: string;
  team: number;
  element_type: number;
  now_cost: number;
  status: string;
  news: string;
  ep_next: string | null;
  total_points: number;
  minutes: number;
  chance_of_playing_next_round: number | null;
  selected_by_percent: string;
  form: string;
}

export const bootstrapElements = bootstrapStatic.elements as unknown as BootstrapElement[];

/** Converts one `bootstrap-static.json` row into a full `Element`. Fields
 * with no source in the reduced fixture get an inert default -- none of
 * those feed `projectModelV2`'s arithmetic. `ep_next` is force-nulled: see
 * this file's module doc for why that field must never round-trip through. */
export function toElement(b: BootstrapElement): Element {
  return {
    id: b.id,
    code: b.id,
    web_name: b.web_name,
    first_name: '',
    second_name: '',
    team: b.team,
    element_type: b.element_type as Position,
    now_cost: b.now_cost,
    status: b.status,
    news: b.news,
    news_added: null,
    chance_of_playing_this_round: b.chance_of_playing_next_round,
    chance_of_playing_next_round: b.chance_of_playing_next_round,
    total_points: b.total_points,
    event_points: 0,
    points_per_game: '0.0',
    form: b.form,
    ep_next: null,
    ep_this: null,
    selected_by_percent: b.selected_by_percent,
    minutes: b.minutes,
    removed: false,
    can_select: true,
    can_transact: true,
  };
}

export const elements: Element[] = bootstrapElements.map(toElement);

export const fixtures = fixtures1to4 as unknown as Fixture[];

/** One row of a `live-N.json` file's `elements` array:
 * `[elementId, totalPoints, [[fixtureId, fixturePoints, statsInStatKeysOrder], ...]]`
 * -- see the file's own `format` field. This is a hand-compacted test
 * fixture, NOT the shape `getEventLive` returns, so it has to be converted
 * before `deriveGwStatsFromLive` (which expects the real `EventLive` shape)
 * can run on it -- `liveFileToEventLive` does that. */
export type LiveFixtureRow = [number, number, number[]];
export type LiveElementRow = [number, number, LiveFixtureRow[]];
export interface LiveFile {
  event: number;
  statKeys: string[];
  elements: LiveElementRow[];
}

export const liveFiles: readonly LiveFile[] = [live1, live2, live3, live4] as unknown as LiveFile[];
export const liveFileByEvent = new Map<number, LiveFile>(liveFiles.map((f) => [f.event, f]));

/** Converts one compact `live-N.json` file into the `EventLive` shape
 * `deriveGwStatsFromLive` consumes. Per-stat `points`/`points_modification`
 * are set to 0 rather than reconstructed from the file's per-fixture total:
 * `projectModelV2` never reads `GwStats.total_points`, so reconstructing an
 * accurate points breakdown here would be extra complexity spent on a field
 * this eval never uses. Actual scored points are instead read directly off
 * each file's own per-element `totalPoints` (see `actualPointsByElement`) --
 * the authoritative number, not a value recomputed here. */
export function liveFileToEventLive(file: LiveFile): EventLive {
  return {
    elements: file.elements.map(([id, , fixtureRows]) => ({
      id,
      stats: {},
      explain: fixtureRows.map(([fixtureId, , statsArray]) => ({
        fixture: fixtureId,
        stats: file.statKeys.map((identifier, i): LiveExplainStat => ({
          identifier,
          value: statsArray[i] ?? 0,
          points: 0,
          points_modification: 0,
        })),
      })),
    })),
  };
}

/** Every element's actual scored points for one gameweek, straight off the
 * file's own per-element total -- see `liveFileToEventLive`'s doc for why
 * this is read here rather than summed from derived `GwStats` rows. */
export function actualPointsByElement(file: LiveFile): Map<number, number> {
  return new Map(file.elements.map(([id, totalPoints]) => [id, totalPoints] as const));
}

/** Total minutes played by each element in one gameweek, derived the same
 * way production code would (via `deriveGwStatsFromLive`) so the appearance
 * filter is consistent with what the real pipeline sees. */
export function minutesByElement(gwStats: readonly GwStats[]): Map<number, number> {
  const minutes = new Map<number, number>();
  for (const row of gwStats) {
    minutes.set(row.element_id, (minutes.get(row.element_id) ?? 0) + row.minutes);
  }
  return minutes;
}

/** Every element's actual scored points for gameweek `event`, or an empty
 * map if there's no live fixture loaded for it. */
export function realizedPoints(event: number): Map<number, number> {
  const file = liveFileByEvent.get(event);
  return file ? actualPointsByElement(file) : new Map<number, number>();
}

/** Elements with nonzero minutes in gameweek `event` -- players who
 * actually appeared, as opposed to unused subs. */
export function appearedInEvent(event: number): Set<number> {
  const file = liveFileByEvent.get(event);
  if (!file) return new Set<number>();
  const minutes = minutesByElement(deriveGwStatsFromLive(liveFileToEventLive(file), event));
  return new Set([...minutes.entries()].filter(([, mins]) => mins > 0).map(([id]) => id));
}

export interface PointInTimeState {
  event: number;
  elements: Element[];
  ratings: ReturnType<typeof fitTeamRatings>;
  fixturesByTeam: Map<number, UpcomingFixtureInfo[]>;
  trailingStatsByElement: Map<number, GwStats[]>;
  projections: Projection[];
}

/** The point-in-time inputs for gameweek `g`: every input restricted to
 * `event < g` (see this file's module doc).
 *
 * `ratingsOpts` is the A/B seam for the ratings fit: pass
 * `{ estimator: RATINGS_EMPIRICAL_BAYES }` to build the same
 * point-in-time state under the other arm. Defaults to `{}`, i.e.
 * whatever `fitTeamRatings` defaults to, so every existing caller and
 * recorded snapshot is unaffected. */
export function pointInTimeState(g: number, ratingsOpts: FitRatingsOptions = {}): PointInTimeState {
  const ratings = fitTeamRatings(
    fixtures.filter((f) => f.event !== null && f.event < g),
    ratingsOpts,
  );

  const fixturesByTeam = groupFixturesByTeam(fixtures.filter((f) => f.event === g));

  const trailingStatsByElement = new Map<number, GwStats[]>();
  for (let priorGw = 1; priorGw < g; priorGw++) {
    const file = liveFileByEvent.get(priorGw);
    if (!file) continue;
    for (const row of deriveGwStatsFromLive(liveFileToEventLive(file), priorGw)) {
      const list = trailingStatsByElement.get(row.element_id);
      if (list) list.push(row);
      else trailingStatsByElement.set(row.element_id, [row]);
    }
  }

  const projections = projectAll(elements, g, {
    strategy: STRATEGY_MODEL_V2,
    ratings,
    fixturesByTeam,
    trailingStatsByElement,
  });

  return { event: g, elements, ratings, fixturesByTeam, trailingStatsByElement, projections };
}
