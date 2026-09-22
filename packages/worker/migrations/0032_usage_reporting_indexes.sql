-- Cover org-level LLM usage scans without reading the wider events table.
-- The partial predicate keeps non-LLM analytics out of this reporting index.
CREATE INDEX IF NOT EXISTS idx_analytics_events_usage_report
  ON analytics_events(
    created_at, user_id, model, session_id, input_tokens, output_tokens
  )
  WHERE event_type = 'llm_call';

-- New active-time flushes are stored as intervals so reports can clip usage to
-- exact period boundaries. Historical counters cannot be reconstructed. Keep
-- them as explicit legacy rows attributed to the session creation time.
CREATE TABLE IF NOT EXISTS session_active_intervals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  active_seconds INTEGER NOT NULL CHECK (active_seconds > 0),
  source TEXT NOT NULL CHECK (source IN ('recorded', 'legacy_session_total'))
);

CREATE INDEX IF NOT EXISTS idx_session_active_intervals_window
  ON session_active_intervals(started_at, ended_at, session_id);

INSERT OR IGNORE INTO session_active_intervals
  (id, session_id, started_at, ended_at, active_seconds, source)
SELECT
  'legacy:' || id,
  id,
  created_at,
  created_at,
  active_seconds,
  'legacy_session_total'
FROM sessions
WHERE active_seconds > 0;
