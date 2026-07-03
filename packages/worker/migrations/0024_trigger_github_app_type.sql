-- Allow a new trigger type 'github-app' (fires from the org GitHub App event
-- stream, no per-workflow webhook to configure). The triggers.type column has a
-- CHECK(type IN ('webhook','schedule','manual')) from 0001; SQLite can't ALTER a
-- CHECK, so we recreate the table with the expanded set. Columns + indexes are
-- preserved exactly (webhook_token added in 0020; the two partial unique indexes
-- on webhook_token and config.path; the COLLATE NOCASE user/name unique index).

-- 1. Drop named indexes (recreated after the swap).
DROP INDEX IF EXISTS idx_triggers_user;
DROP INDEX IF EXISTS idx_triggers_workflow;
DROP INDEX IF EXISTS idx_triggers_type;
DROP INDEX IF EXISTS idx_triggers_enabled;
DROP INDEX IF EXISTS idx_triggers_user_name;
DROP INDEX IF EXISTS idx_triggers_webhook_token;
DROP INDEX IF EXISTS idx_triggers_webhook_path_unique;

-- 2. Recreate with 'github-app' added to the type CHECK.
CREATE TABLE triggers_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'schedule', 'manual', 'github-app')),
  config TEXT NOT NULL,
  variable_mapping TEXT,
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  webhook_token TEXT
);

-- 3. Copy data (explicit column list — order matches the table above).
INSERT INTO triggers_new (
  id, user_id, workflow_id, name, enabled, type, config,
  variable_mapping, last_run_at, created_at, updated_at, webhook_token
)
SELECT
  id, user_id, workflow_id, name, enabled, type, config,
  variable_mapping, last_run_at, created_at, updated_at, webhook_token
FROM triggers;

-- 4. Swap.
DROP TABLE triggers;
ALTER TABLE triggers_new RENAME TO triggers;

-- 5. Recreate every index exactly as it was.
CREATE INDEX idx_triggers_user ON triggers(user_id);
CREATE INDEX idx_triggers_workflow ON triggers(workflow_id);
CREATE INDEX idx_triggers_type ON triggers(type);
CREATE INDEX idx_triggers_enabled ON triggers(enabled);
CREATE UNIQUE INDEX idx_triggers_user_name ON triggers(user_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX idx_triggers_webhook_token
  ON triggers(webhook_token)
  WHERE webhook_token IS NOT NULL;
CREATE UNIQUE INDEX idx_triggers_webhook_path_unique
  ON triggers(json_extract(config, '$.path'))
  WHERE type = 'webhook';
