-- Fantasy Liga Portugal agent -- initial D1 schema.
--
-- Booleans are stored as INTEGER 0/1 (SQLite has no native boolean); readers
-- in src/db coerce these back to real booleans before they cross the
-- src/db boundary into the rest of the app.
--
-- Timestamps are ISO 8601 TEXT throughout, matching the shape of the strings
-- the upstream API already returns (see src/types.ts).

-- One row per gameweek. is_current/is_next/is_previous mirror the flags the
-- upstream bootstrap-static endpoint returns on GameEvent.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  deadline_time TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  is_next INTEGER NOT NULL DEFAULT 0,
  is_previous INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  data_checked INTEGER NOT NULL DEFAULT 0
);

-- Used by getCurrentAndNextEvent() to avoid a full scan of the events table.
CREATE INDEX idx_events_current_next ON events (is_current, is_next);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  code INTEGER NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL
);

-- Daily upsert of ~656 rows. Maps onto the `Element` interface in
-- src/types.ts field-for-field (plus `updated_at`, which is ours).
CREATE TABLE elements (
  id INTEGER PRIMARY KEY,
  code INTEGER NOT NULL,
  web_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  second_name TEXT NOT NULL,
  team INTEGER NOT NULL,
  element_type INTEGER NOT NULL,
  now_cost INTEGER NOT NULL,
  status TEXT NOT NULL,
  news TEXT NOT NULL DEFAULT '',
  news_added TEXT,
  chance_of_playing_this_round INTEGER,
  chance_of_playing_next_round INTEGER,
  ep_next TEXT,
  ep_this TEXT,
  total_points INTEGER NOT NULL DEFAULT 0,
  event_points INTEGER NOT NULL DEFAULT 0,
  form TEXT NOT NULL DEFAULT '0.0',
  points_per_game TEXT NOT NULL DEFAULT '0.0',
  selected_by_percent TEXT NOT NULL DEFAULT '0.0',
  minutes INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  can_select INTEGER NOT NULL DEFAULT 1,
  can_transact INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- Used by team-scoped and position-scoped element reads (lineup/transfer
-- candidate generation joins elements to teams and filters by element_type).
CREATE INDEX idx_elements_team ON elements (team);
CREATE INDEX idx_elements_element_type ON elements (element_type);

-- The fact table. PK includes fixture_id (not just element_id, event)
-- because a gameweek can contain a rescheduled second fixture, and the
-- scoring divisors in src/scoring.ts are computed per fixture, not per
-- gameweek -- see scoreFixture()'s doc comment.
CREATE TABLE element_gw_stats (
  element_id INTEGER NOT NULL,
  event INTEGER NOT NULL,
  fixture_id INTEGER NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  goals_scored INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  clean_sheets INTEGER NOT NULL DEFAULT 0,
  goals_conceded INTEGER NOT NULL DEFAULT 0,
  penalties_saved INTEGER NOT NULL DEFAULT 0,
  penalties_missed INTEGER NOT NULL DEFAULT 0,
  yellow_cards INTEGER NOT NULL DEFAULT 0,
  red_cards INTEGER NOT NULL DEFAULT 0,
  saves INTEGER NOT NULL DEFAULT 0,
  own_goals INTEGER NOT NULL DEFAULT 0,
  attacking_bonus INTEGER NOT NULL DEFAULT 0,
  defending_bonus INTEGER NOT NULL DEFAULT 0,
  winning_goals INTEGER NOT NULL DEFAULT 0,
  key_passes INTEGER NOT NULL DEFAULT 0,
  clearances_blocks_interceptions INTEGER NOT NULL DEFAULT 0,
  recoveries INTEGER NOT NULL DEFAULT 0,
  shots_on_target INTEGER NOT NULL DEFAULT 0,
  total_points INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (element_id, event, fixture_id)
);

-- Used by getGwStatsForEvent() to pull every stat line for one gameweek
-- (the PK already serves per-element lookups since element_id leads it).
CREATE INDEX idx_gw_stats_event ON element_gw_stats (event);

-- Prior-season aggregates, keyed by element_code (stable across seasons,
-- unlike element id) and season_name.
CREATE TABLE element_history_past (
  element_code INTEGER NOT NULL,
  season_name TEXT NOT NULL,
  total_points INTEGER NOT NULL DEFAULT 0,
  minutes INTEGER NOT NULL DEFAULT 0,
  goals_scored INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  clean_sheets INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (element_code, season_name)
);

CREATE TABLE fixtures (
  id INTEGER PRIMARY KEY,
  code INTEGER NOT NULL,
  event INTEGER,
  team_h INTEGER NOT NULL,
  team_a INTEGER NOT NULL,
  team_h_score INTEGER,
  team_a_score INTEGER,
  kickoff_time TEXT,
  started INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  minutes INTEGER NOT NULL DEFAULT 0
);

-- Used by getFixturesForEvent() to list one gameweek's fixtures.
CREATE INDEX idx_fixtures_event ON fixtures (event);

CREATE TABLE team_ratings (
  team_id INTEGER PRIMARY KEY,
  attack REAL NOT NULL,
  defence REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projections (
  element_id INTEGER NOT NULL,
  event INTEGER NOT NULL,
  xmins REAL NOT NULL,
  xpts REAL NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (element_id, event)
);

-- Used by getProjectionsForEvent() to read every player's projection for
-- one gameweek (the PK alone would require scanning all events per element).
CREATE INDEX idx_projections_event ON projections (event);

-- picks is stored as a JSON TEXT blob (array of Pick); read helpers parse it.
CREATE TABLE squad_state (
  entry INTEGER NOT NULL,
  event INTEGER NOT NULL,
  picks TEXT NOT NULL,
  chip TEXT,
  bank INTEGER NOT NULL,
  value INTEGER NOT NULL,
  free_transfers INTEGER NOT NULL,
  transfers_made INTEGER NOT NULL,
  cumulative_transfers INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry, event)
);

-- Used by getLatestSquadState() to find the most recent state for an entry.
CREATE INDEX idx_squad_state_entry_event ON squad_state (entry, event DESC);

CREATE TABLE actions_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  intent TEXT NOT NULL,
  response TEXT,
  dry_run INTEGER NOT NULL,
  source TEXT NOT NULL,
  ok INTEGER NOT NULL
);

-- Used by any recent-actions read, which orders by time.
CREATE INDEX idx_actions_log_ts ON actions_log (ts);

CREATE TABLE ai_calls (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  decision_kind TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  raw_response TEXT,
  schema_valid INTEGER,
  validation_outcome TEXT,
  repaired INTEGER NOT NULL DEFAULT 0,
  gate_verdict TEXT,
  est_neurons_in INTEGER NOT NULL DEFAULT 0,
  est_neurons_out INTEGER NOT NULL DEFAULT 0
);

-- Used by any recent-calls read, which orders by time.
CREATE INDEX idx_ai_calls_ts ON ai_calls (ts);

-- One row per UTC day. neurons_spent is incremented in place by addNeurons()
-- so the 8000/day Workers AI cap can be checked with a single-row read.
CREATE TABLE ai_budget (
  day TEXT PRIMARY KEY,
  neurons_spent INTEGER NOT NULL DEFAULT 0
);

-- Single-row table (the CHECK enforces it) holding the fantasy site session.
CREATE TABLE session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cookie TEXT,
  expires_at TEXT,
  last_ok_at TEXT
);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES ('enabled', '1');
INSERT INTO config (key, value) VALUES ('dry_run', '1');
