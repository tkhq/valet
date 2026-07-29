-- Per-user override for the concurrent workflow execution cap, mirroring
-- users.max_active_sessions. NULL means "use the platform default"
-- (PER_USER_EXECUTION_CONCURRENCY_CAP in lib/db/constants.ts), so existing
-- rows keep the default without a backfill.
--
-- The override raises only the PER-USER ceiling. The per-worker global cap
-- (GLOBAL_EXECUTION_CONCURRENCY_CAP) still applies on top, so a single
-- tenant with a large override cannot starve the worker.
ALTER TABLE users ADD COLUMN max_workflow_executions INTEGER;
