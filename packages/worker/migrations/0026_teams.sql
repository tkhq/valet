-- 0026_teams.sql
-- Teams & team orchestrators — the full schema for the teams feature, squashed
-- into one migration (see docs/specs/2026-07-05-teams-design.md). Sections, in
-- dependency order:
--   1. Principal ownership columns (owner_type/owner_id) + backfills
--   2. Canonical orchestrator session IDs (orchestrator:{userId} → :user:)
--   3. Owner indexes
--   4. teams + team_members
--   5. Memory owner-scope: drop the stale (user_id, path) unique index
--   6. Channel binding trigger_mode + created_by
--   7. Rename mailbox_messages → notifications (agent mailbox retired)
--   8. Team sourced credentials: sourced_from_user_id + status; workflows owner index
--
-- The mailbox_messages session-ID rewrites in §2 run BEFORE the rename in §7,
-- so they target the table under its original name.

PRAGMA defer_foreign_keys = on;

-- ── 1. Owner columns (backfilled as user-owned) ─────────────────────────────
ALTER TABLE sessions ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE sessions ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE sessions SET owner_id = user_id WHERE owner_id = '';

ALTER TABLE orchestrator_identities ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE orchestrator_identities ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE orchestrator_identities SET owner_id = user_id WHERE owner_id = '' AND user_id IS NOT NULL;

ALTER TABLE orchestrator_memory_files ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE orchestrator_memory_files ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE orchestrator_memory_files SET owner_id = user_id WHERE owner_id = '';

ALTER TABLE channel_bindings ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE channel_bindings ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE channel_bindings SET owner_id = user_id WHERE owner_id = '' AND user_id IS NOT NULL;

ALTER TABLE channel_thread_mappings ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE channel_thread_mappings ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE channel_thread_mappings SET owner_id = user_id WHERE owner_id = '';

ALTER TABLE workflows ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE workflows ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
UPDATE workflows SET owner_id = user_id WHERE owner_id = '';

-- ── 2. Canonical orchestrator session IDs ───────────────────────────────────
-- orchestrator:<rest> → orchestrator:user:<rest>  ('orchestrator:' is 13 chars)
-- NOTE: this is a hard cutover for orchestrator workspace volumes — the volume
-- name is derived from the session ID, so renamed sessions get fresh volumes.
-- Durable state (memory, identity, tasks) lives in D1; old volumes are orphaned.
UPDATE sessions SET id = 'orchestrator:user:' || substr(id, 14)
  WHERE id LIKE 'orchestrator:%' AND id NOT LIKE 'orchestrator:user:%';
UPDATE sessions SET parent_session_id = 'orchestrator:user:' || substr(parent_session_id, 14)
  WHERE parent_session_id LIKE 'orchestrator:%' AND parent_session_id NOT LIKE 'orchestrator:user:%';
UPDATE messages SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE screenshots SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_git_state SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_files_changed SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_participants SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_share_links SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_threads SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE channel_bindings SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE channel_thread_mappings SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE analytics_events SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE runtime_grants SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE action_invocations SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_tasks SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE session_tasks SET orchestrator_session_id = 'orchestrator:user:' || substr(orchestrator_session_id, 14)
  WHERE orchestrator_session_id LIKE 'orchestrator:%' AND orchestrator_session_id NOT LIKE 'orchestrator:user:%';
UPDATE workflow_spawned_sessions SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';
UPDATE mailbox_messages SET from_session_id = 'orchestrator:user:' || substr(from_session_id, 14)
  WHERE from_session_id LIKE 'orchestrator:%' AND from_session_id NOT LIKE 'orchestrator:user:%';
UPDATE mailbox_messages SET to_session_id = 'orchestrator:user:' || substr(to_session_id, 14)
  WHERE to_session_id LIKE 'orchestrator:%' AND to_session_id NOT LIKE 'orchestrator:user:%';
UPDATE mailbox_messages SET context_session_id = 'orchestrator:user:' || substr(context_session_id, 14)
  WHERE context_session_id LIKE 'orchestrator:%' AND context_session_id NOT LIKE 'orchestrator:user:%';
UPDATE agent_memories SET session_id = 'orchestrator:user:' || substr(session_id, 14)
  WHERE session_id LIKE 'orchestrator:%' AND session_id NOT LIKE 'orchestrator:user:%';

-- ── 3. Owner indexes ─────────────────────────────────────────────────────────
CREATE INDEX idx_sessions_owner ON sessions(owner_type, owner_id);
-- Partial: user_id is nullable, so legacy rows without one backfill to owner_id=''
-- and must not collide with each other.
CREATE UNIQUE INDEX idx_orch_identity_owner ON orchestrator_identities(org_id, owner_type, owner_id) WHERE owner_id != '';
CREATE INDEX idx_memory_files_owner ON orchestrator_memory_files(owner_type, owner_id);
CREATE UNIQUE INDEX idx_memory_files_owner_path ON orchestrator_memory_files(owner_type, owner_id, path);
CREATE INDEX idx_channel_bindings_owner ON channel_bindings(owner_type, owner_id);

-- ── 4. Teams + membership ────────────────────────────────────────────────────
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  avatar TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_teams_org_name ON teams(org_id, name);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON team_members(user_id);

-- ── 5. Memory owner-scope ────────────────────────────────────────────────────
-- user_id becomes creator/actor provenance; team rows carry the acting user
-- there, so the old (user_id, path) uniqueness is wrong. Ownership uniqueness
-- is idx_memory_files_owner_path (created in §3).
DROP INDEX idx_memory_files_user_path;

-- ── 6. Channel binding trigger mode + creator audit ──────────────────────────
-- 'mention' = respond only when mentioned (or in an active thread); 'all' =
-- passive listening (batched via collect debounce). DM bindings ignore it.
ALTER TABLE channel_bindings ADD COLUMN trigger_mode TEXT NOT NULL DEFAULT 'mention';
ALTER TABLE channel_bindings ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- ── 7. Mailbox → notifications ───────────────────────────────────────────────
-- The agent-to-agent mailbox is retired; the table survives only as the
-- notification queue behind the attention router. Indexes follow in SQLite.
ALTER TABLE mailbox_messages RENAME TO notifications;

-- ── 8. Team sourced credentials ──────────────────────────────────────────────
-- A team credential REFERENCES the sourcing member's live credential
-- (sourced_from_user_id); status flips to 'broken' when that member revokes or
-- leaves. (credentials.last_failure_reason/last_failure_at come from an earlier
-- migration and are orthogonal.)
ALTER TABLE credentials ADD COLUMN sourced_from_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE credentials ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

CREATE INDEX idx_workflows_owner ON workflows(owner_type, owner_id);
