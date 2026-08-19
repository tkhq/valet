-- One live orchestrator session per user. Concurrent onboard/restart both
-- inserted UUID rows; keep the newest live row (routing uses created_at DESC)
-- and reject later inserts.
-- Extra nested SELECT so SQLite allows UPDATE ... FROM the same table.
UPDATE sessions
SET status = 'terminated'
WHERE is_orchestrator = 1
  AND status NOT IN ('terminated', 'archived', 'error')
  AND id IN (
    SELECT id FROM (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY user_id
                 ORDER BY created_at DESC, id DESC
               ) AS rn
        FROM sessions
        WHERE is_orchestrator = 1
          AND status NOT IN ('terminated', 'archived', 'error')
      )
      WHERE rn > 1
    )
  );

CREATE UNIQUE INDEX idx_sessions_one_live_orchestrator
ON sessions(user_id)
WHERE is_orchestrator = 1 AND status NOT IN ('terminated', 'archived', 'error');
