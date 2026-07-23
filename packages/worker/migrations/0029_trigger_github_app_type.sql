-- Allow a new trigger type 'github-app' (fires from the org GitHub App event
-- stream, no per-workflow webhook to configure). The triggers.type column has a
-- CHECK(type IN ('webhook','schedule','manual')) from 0001; SQLite can't ALTER a
-- CHECK, so we recreate the table with the expanded set. Columns + indexes are
-- preserved exactly (webhook_token added in 0020; the two partial unique indexes
-- on webhook_token and config.path; the COLLATE NOCASE user/name unique index).
--
-- The rebuild has to survive the foreign keys pointed at triggers(id):
--   workflow_executions.trigger_id     ON DELETE SET NULL
--   trigger_webhook_rate.trigger_id    ON DELETE CASCADE
--   workflow_schedule_ticks.trigger_id ON DELETE CASCADE
-- With foreign keys enforced, `DROP TABLE triggers` fires those actions, which
-- blanks every historical execution's trigger_id and empties the rate and
-- schedule-tick tables — data nothing afterwards can reconstruct.
--
-- PRAGMA defer_foreign_keys below is the standard SQLite 12-step guard, but it
-- holds only for the duration of one transaction, and a migration file is not
-- guaranteed to run as one. The snapshot/restore tables around the swap are
-- therefore what makes this safe: they reinstate the child rows whether or not
-- the pragma took effect. The result stays backward-compatible — an old Worker
-- reads the rebuilt table exactly as it read the old one.

PRAGMA defer_foreign_keys = on;

-- 0. Snapshot every child reference the drop could destroy.
CREATE TABLE _m0029_exec_trigger AS
  SELECT id, trigger_id FROM workflow_executions WHERE trigger_id IS NOT NULL;
CREATE TABLE _m0029_webhook_rate AS
  SELECT trigger_id, window_start_ts, count FROM trigger_webhook_rate;
CREATE TABLE _m0029_schedule_ticks AS
  SELECT id, trigger_id, tick_bucket, created_at FROM workflow_schedule_ticks;

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

-- 6. Reinstate whatever the drop's referential actions removed. Every trigger id
-- was carried over verbatim, so each restored reference still resolves. Both
-- restores are no-ops when the pragma held and nothing was lost.
UPDATE workflow_executions
SET trigger_id = (
  SELECT s.trigger_id FROM _m0029_exec_trigger s WHERE s.id = workflow_executions.id
)
WHERE trigger_id IS NULL
  AND id IN (SELECT id FROM _m0029_exec_trigger);

INSERT OR IGNORE INTO trigger_webhook_rate (trigger_id, window_start_ts, count)
  SELECT trigger_id, window_start_ts, count FROM _m0029_webhook_rate;

INSERT OR IGNORE INTO workflow_schedule_ticks (id, trigger_id, tick_bucket, created_at)
  SELECT id, trigger_id, tick_bucket, created_at FROM _m0029_schedule_ticks;

DROP TABLE _m0029_exec_trigger;
DROP TABLE _m0029_webhook_rate;
DROP TABLE _m0029_schedule_ticks;

PRAGMA defer_foreign_keys = off;
