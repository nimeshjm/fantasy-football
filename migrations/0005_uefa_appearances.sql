-- Issue #51: UEFA rotation-risk signal.
--
-- One row per (owned player, UEFA fixture they appeared in). Populated from
-- API-Football, independently of the Liga Portugal `fixtures`/`gw_stats`
-- tables (those only ever cover domestic Primeira Liga matches -- see
-- src/workflows/ingest.ts). `element_id` is this project's own id (matched
-- by name+club against API-Football's separate id space -- there is no
-- shared id here, see the matching helper this issue adds), never an
-- API-Football player id.
--
-- `subbed_off_minute` is NULL for a player who was NOT substituted (played
-- until the final whistle, or never started) -- absence of a value, not 0,
-- since 0 would misread as "subbed off in minute zero".
CREATE TABLE uefa_appearances (
  element_id INTEGER NOT NULL,
  fixture_id INTEGER NOT NULL,
  competition TEXT NOT NULL, -- 'UCL' | 'UEL' | 'UECL'
  opponent TEXT NOT NULL,
  kickoff_time TEXT NOT NULL,
  started INTEGER NOT NULL, -- 0/1
  subbed_off_minute INTEGER,
  minutes_played INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (element_id, fixture_id)
);

CREATE INDEX idx_uefa_appearances_kickoff ON uefa_appearances(kickoff_time);
