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

DROP INDEX IF EXISTS idx_session_active_intervals_window;
CREATE INDEX idx_session_active_intervals_window
  ON session_active_intervals(source, started_at, ended_at, session_id);

-- Normalize rows from an earlier version of this migration before reports use
-- direct string comparisons.
UPDATE session_active_intervals
SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at),
    ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', ended_at)
WHERE source = 'legacy_session_total';

-- The NOT EXISTS guard makes a migration replay safe even if a previous
-- backfill used a different row id.
INSERT INTO session_active_intervals
  (id, session_id, started_at, ended_at, active_seconds, source)
SELECT
  'legacy:' || s.id,
  s.id,
  strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at),
  strftime('%Y-%m-%dT%H:%M:%fZ', s.created_at),
  s.active_seconds,
  'legacy_session_total'
FROM sessions s
WHERE s.active_seconds > 0
  AND NOT EXISTS (
    SELECT 1
    FROM session_active_intervals sai
    WHERE sai.session_id = s.id
      AND sai.source = 'legacy_session_total'
  );

-- Record every positive lifetime-counter increment. This trigger supports both
-- worker versions during deployment: old workers update only the counter, and
-- new workers use the same update path. If code deploys before this migration,
-- the backfill preserves those increments as legacy session-start usage.
CREATE TRIGGER IF NOT EXISTS trg_sessions_record_active_interval
AFTER UPDATE OF active_seconds ON sessions
WHEN NEW.active_seconds > OLD.active_seconds
BEGIN
  INSERT INTO session_active_intervals
    (id, session_id, started_at, ended_at, active_seconds, source)
  VALUES (
    'active:' || NEW.id || ':' || lower(hex(randomblob(16))),
    NEW.id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d seconds', NEW.active_seconds - OLD.active_seconds)),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NEW.active_seconds - OLD.active_seconds,
    'recorded'
  );
END;
