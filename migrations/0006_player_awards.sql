CREATE TABLE IF NOT EXISTS player_awards (
  element_id INTEGER NOT NULL,
  award_type TEXT NOT NULL,
  period_key TEXT NOT NULL,
  fixture_id INTEGER,
  source_player_name TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (award_type, period_key, element_id)
);

CREATE INDEX IF NOT EXISTS idx_player_awards_element ON player_awards(element_id);
