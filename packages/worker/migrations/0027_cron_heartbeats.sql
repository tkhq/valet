-- Cron sweep heartbeats: one row per scheduled-handler job, upserted on every
-- run. Before this table every sweep failed silently into console.error — a
-- dead credential-refresh or retention sweep could rot for weeks with no
-- queryable record. /api/analytics/health reads these rows and flags a job
-- stale when now - last_success_at exceeds 3x its expected interval.
--
-- Numbering note: 0027 (not 0026) because 0026_okf_memory.sql already occupies
-- 0026 on main, and the unmerged teams PR also claims 0026_teams.sql — that PR
-- must renumber when it lands; skipping ahead here avoids a three-way collision.
CREATE TABLE cron_heartbeats (
  job_name TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  last_duration_ms INTEGER,
  last_items INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
