-- Rotation bumps this so an in-flight /start for a previous live row
-- can see that its claim is no longer valid.
ALTER TABLE orchestrator_identities ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN orchestrator_generation INTEGER;

UPDATE sessions
SET orchestrator_generation = COALESCE((
  SELECT session_generation FROM orchestrator_identities oi
  WHERE oi.user_id = sessions.user_id
  LIMIT 1
), 0)
WHERE is_orchestrator = 1;
