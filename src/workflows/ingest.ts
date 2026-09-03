/**
 * `IngestWorkflow`: pulls one or more gameweeks' final stats into D1.
 *
 * One `step.do` PER GAMEWEEK -- `event/{n}/live/` (up to ~656 players) plus
 * `fixtures/?event={n}` (a handful of rows) are both small enough to fetch,
 * parse and upsert inside one step's 10ms CPU budget: `event/{n}/live/` is
 * the only large payload (~0.7ms to JSON.parse per the task brief's
 * reference measurement), `fixtures/?event={n}` is tiny. A final step
 * refits team ratings from every fixture played so far.
 *
 * `params.events` supports both a GW1-4 backfill (`[1, 2, 3, 4]`) and
 * steady-state single-gameweek ingestion (`[n]`) -- the loop is the same
 * either way, just with a different-length list.
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

import type { Env } from '../env';
import { FantasyApiClient } from '../api/client';
import {
  getEventLive,
  getFixtures,
  type EventLive,
  type LiveExplainFixture,
} from '../api/endpoints';
import { getAllFixtures, saveRatingsModel, upsertFixtures, upsertGwStats } from '../db';
import { fitTeamRatings } from '../model/ratings';
import type { GwStats, RawStats } from '../types';

export interface IngestWorkflowParams {
  /** Gameweek numbers to ingest, in order. `[1, 2, 3, 4]` for a backfill,
   * `[n]` for steady-state single-gameweek ingestion. */
  events: number[];
}

/** Every key `GwStats` needs off `RawStats`, for validating
 * `explain[].stats[].identifier` against. Kept as its own list (rather than
 * importing db/gwStats.ts's internal column list) since this is a distinct
 * concern: this module maps API identifiers to `RawStats` keys, db/gwStats.ts
 * maps `RawStats` keys to D1 columns. Must track `RawStats` in src/types.ts. */
const RAW_STAT_KEYS: ReadonlySet<string> = new Set<keyof RawStats>([
  'minutes',
  'goals_scored',
  'assists',
  'clean_sheets',
  'goals_conceded',
  'penalties_saved',
  'penalties_missed',
  'yellow_cards',
  'red_cards',
  'saves',
  'own_goals',
  'attacking_bonus',
  'defending_bonus',
  'winning_goals',
  'key_passes',
  'clearances_blocks_interceptions',
  'recoveries',
  'shots_on_target',
]);

function isRawStatKey(identifier: string): identifier is keyof RawStats {
  return RAW_STAT_KEYS.has(identifier);
}

function zeroRawStats(): RawStats {
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
  };
}

/** One fixture's stat line -> one `GwStats` row. Unknown identifiers are
 * ignored rather than throwing (see the task brief: the identifier set is
 * whatever the live API sends, and a forward-compatible ingest should not
 * hard-fail on one this project doesn't score). `total_points` is the sum of
 * `points + points_modification` across the fixture's stats, matching what
 * the live API itself attributes to that fixture -- `scoreFixture` in
 * src/scoring.ts is available as an independent cross-check of this figure,
 * not the source of it. */
function explainFixtureToGwStats(
  elementId: number,
  event: number,
  fx: LiveExplainFixture,
): GwStats {
  const raw = zeroRawStats();
  let totalPoints = 0;
  for (const stat of fx.stats) {
    if (isRawStatKey(stat.identifier)) {
      raw[stat.identifier] = stat.value;
    }
    totalPoints += stat.points + (stat.points_modification ?? 0);
  }
  return {
    ...raw,
    element_id: elementId,
    event,
    fixture_id: fx.fixture,
    total_points: totalPoints,
  };
}

/** Every per-fixture `GwStats` row for one gameweek's `event/{n}/live/`
 * response. A player with no `explain` entries (unused all gameweek)
 * contributes no rows -- there is no fixture to key them against. */
export function deriveGwStatsFromLive(live: EventLive, event: number): GwStats[] {
  const rows: GwStats[] = [];
  for (const el of live.elements) {
    for (const fx of el.explain) {
      rows.push(explainFixtureToGwStats(el.id, event, fx));
    }
  }
  return rows;
}

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestWorkflowParams> {
  override async run(
    workflowEvent: Readonly<WorkflowEvent<IngestWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ events: number[]; teamsRated: number }> {
    const env = this.env;
    const events = workflowEvent.payload.events;

    for (const gw of events) {
      await step.do(`ingest-gw-${gw}`, async () => {
        const client = new FantasyApiClient(env.FANTASY_BASE_URL);
        // One large payload (event/{n}/live/) plus one small one
        // (fixtures/?event=n) -- within the "one large parse per step" CPU
        // budget from the task brief.
        const [live, fixtures] = await Promise.all([
          getEventLive(client, gw),
          getFixtures(client, gw),
        ]);

        const rows = deriveGwStatsFromLive(live, gw);
        await upsertGwStats(env.DB, rows);
        await upsertFixtures(env.DB, fixtures);

        return { event: gw, rows: rows.length, fixtures: fixtures.length };
      });
    }

    const rated = await step.do('refit-team-ratings', async () => {
      const fixtures = await getAllFixtures(env.DB);
      const model = fitTeamRatings(fixtures);
      // Persist the WHOLE model, not just the per-team attack/defence rows.
      // `expectedGoals` (src/model/ratings.ts) multiplies by `leagueAvgGoals`
      // and `homeAdvantage`, two league-wide scalars that live outside the
      // per-team `team_ratings` table -- see `saveRatingsModel`'s own doc in
      // src/db/teamRatings.ts. Persisting only the per-team rows (the old
      // behaviour here) would let `loadRatingsModel` reconstruct a model
      // that is wrong by a constant multiplicative factor on every expected
      // goals figure, with no error raised anywhere.
      await saveRatingsModel(env.DB, model, new Date().toISOString());
      return model.ratings.size;
    });

    return { events, teamsRated: rated };
  }
}
