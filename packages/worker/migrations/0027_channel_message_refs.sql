-- Generic authorization index for externally-created channel messages.
-- This intentionally stores no message content or platform payloads.

CREATE TABLE channel_message_refs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  connection_scope TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  action_invocation_id TEXT REFERENCES action_invocations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE UNIQUE INDEX idx_channel_message_refs_external
  ON channel_message_refs (
    org_id, channel_type, connection_scope, channel_id, message_id
  );

CREATE INDEX idx_channel_message_refs_owner
  ON channel_message_refs (owner_user_id, created_at);
