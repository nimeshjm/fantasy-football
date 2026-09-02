/**
 * Shared domain types for the Fantasy Liga Portugal Betclic agent.
 *
 * This file is the integration contract between workstreams. Treat it as
 * append-only during implementation: if a field is missing, add it rather than
 * reshaping what is already here.
 *
 * Money convention: the API expresses cost in tenths of a million
 * (`ui_currency_multiplier: 10`), so `now_cost: 55` is €5.5m and the
 * `squad_total_spend: 1000` budget is €100.0m. All integers in this codebase
 * stay in API units — never pre-divide.
 */

/** element_type ids as returned by bootstrap-static. */
export enum Position {
  GK = 1,
  DEF = 2,
  MID = 3,
  FWD = 4,
}

export const POSITION_SHORT: Record<Position, string> = {
  [Position.GK]: 'GR',
  [Position.DEF]: 'DEF',
  [Position.MID]: 'MED',
  [Position.FWD]: 'AVA',
};

/** Squad composition, from game_config.rules. Verified against the live API. */
export const RULES = {
  budget: 1000,
  squadSize: 15,
  squadPlay: 11,
  teamLimit: 3,
  /** Total picks required per position across the 15-man squad. */
  squadSelect: { [Position.GK]: 2, [Position.DEF]: 5, [Position.MID]: 5, [Position.FWD]: 3 },
  /** Min/max of each position allowed in the starting XI. */
  play: {
    [Position.GK]: { min: 1, max: 1 },
    [Position.DEF]: { min: 3, max: 5 },
    [Position.MID]: { min: 2, max: 5 },
    [Position.FWD]: { min: 1, max: 3 },
  },
  sellOnFee: 0.5,
  transfersCap: 20,
  maxExtraFreeTransfers: 4,
} as const;

/** The 18 raw stat counters the game tracks, keyed as the API keys them. */
export interface RawStats {
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  penalties_saved: number;
  penalties_missed: number;
  yellow_cards: number;
  red_cards: number;
  saves: number;
  own_goals: number;
  attacking_bonus: number;
  defending_bonus: number;
  winning_goals: number;
  key_passes: number;
  clearances_blocks_interceptions: number;
  recoveries: number;
  shots_on_target: number;
}

export interface Team {
  id: number;
  code: number;
  name: string;
  short_name: string;
}

export interface Element {
  id: number;
  code: number;
  web_name: string;
  first_name: string;
  second_name: string;
  team: number;
  element_type: Position;
  now_cost: number;
  /** 'a' available, 'i' injured, 'd' doubtful, 's' suspended, 'u' unavailable. */
  status: string;
  /** Free-text Portuguese injury/suspension note. Empty string when clear. */
  news: string;
  news_added: string | null;
  chance_of_playing_this_round: number | null;
  chance_of_playing_next_round: number | null;
  total_points: number;
  event_points: number;
  points_per_game: string;
  form: string;
  /** The site's own expected points for the next gameweek. */
  ep_next: string | null;
  ep_this: string | null;
  selected_by_percent: string;
  minutes: number;
  removed: boolean;
  can_select: boolean;
  can_transact: boolean;
}

export interface GameEvent {
  id: number;
  name: string;
  deadline_time: string;
  is_current: boolean;
  is_next: boolean;
  is_previous: boolean;
  finished: boolean;
  data_checked: boolean;
}

export interface Fixture {
  id: number;
  code: number;
  event: number | null;
  team_h: number;
  team_a: number;
  team_h_score: number | null;
  team_a_score: number | null;
  kickoff_time: string | null;
  started: boolean;
  finished: boolean;
  minutes: number;
}

/** One player's stat line for one gameweek — the fact-table row. */
export interface GwStats extends RawStats {
  element_id: number;
  event: number;
  total_points: number;
}

/** A squad slot. position 1-11 start, 12-15 bench in that order. */
export interface Pick {
  element: number;
  position: number;
  is_captain: boolean;
  is_vice_captain: boolean;
  /** Present on my-team/ responses. Authoritative — never compute this. */
  selling_price?: number;
  purchase_price?: number;
}

export interface SquadState {
  entry: number;
  event: number;
  picks: Pick[];
  chip: string | null;
  bank: number;
  value: number;
  freeTransfers: number;
  transfersMade: number;
}

export interface Projection {
  element_id: number;
  event: number;
  xmins: number;
  xpts: number;
}

export type DecisionKind = 'squad' | 'lineup' | 'transfer';

/** How a committed decision was actually arrived at. Always logged. */
export type DecisionSource = 'llm' | 'llm-repaired' | 'deterministic-gate' | 'deterministic-fallback';

export interface Decision {
  kind: DecisionKind;
  source: DecisionSource;
  picks?: Pick[];
  transfers?: TransferMove[];
  reasoning: string;
  /** Populated when the sanity gate or a repair changed the model's answer. */
  overrideReason?: string;
}

export interface TransferMove {
  element_in: number;
  element_out: number;
  /** now_cost of the incoming player, at commit time. */
  purchase_price: number;
  /** selling_price of the outgoing player, read from my-team/. */
  selling_price: number;
}

export interface ValidationError {
  rule: string;
  detail: string;
}
