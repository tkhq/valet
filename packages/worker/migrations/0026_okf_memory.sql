-- OKF-native memory: metadata columns, link graph, FTS rebuild.
-- DEPLOY ORDER: apply this migration BEFORE deploying the new worker.

ALTER TABLE orchestrator_memory_files ADD COLUMN type TEXT NOT NULL DEFAULT '';
ALTER TABLE orchestrator_memory_files ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE orchestrator_memory_files ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE orchestrator_memory_files ADD COLUMN resource TEXT NOT NULL DEFAULT '';
ALTER TABLE orchestrator_memory_files ADD COLUMN extras TEXT NOT NULL DEFAULT '{}';
ALTER TABLE orchestrator_memory_files ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'private';
ALTER TABLE orchestrator_memory_files ADD COLUMN origin TEXT NOT NULL DEFAULT '';
ALTER TABLE orchestrator_memory_files ADD COLUMN source_session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE orchestrator_memory_files ADD COLUMN expires TEXT;

ALTER TABLE orchestrator_identities ADD COLUMN links_indexed_at TEXT;

CREATE TABLE memory_links (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, from_path, to_path)
);
CREATE INDEX idx_memory_links_to ON memory_links(user_id, to_path);

CREATE INDEX idx_memory_files_resource ON orchestrator_memory_files(user_id, resource);

-- Reserved-name amnesty. Plain rename where the target is free; id-suffixed
-- rename for collisions. Inbound body links to renamed paths are NOT rewritten
-- (link machinery doesn't exist yet) — they surface later as phantoms.
UPDATE orchestrator_memory_files
SET path = substr(path, 1, length(path) - length('index.md')) || 'index-notes.md'
WHERE (path = 'index.md' OR path LIKE '%/index.md')
  AND NOT EXISTS (
    SELECT 1 FROM orchestrator_memory_files o2
    WHERE o2.user_id = orchestrator_memory_files.user_id
      AND o2.path = substr(orchestrator_memory_files.path, 1, length(orchestrator_memory_files.path) - length('index.md')) || 'index-notes.md');
UPDATE orchestrator_memory_files
SET path = substr(path, 1, length(path) - length('index.md')) || 'index-notes-' || substr(id, 1, 8) || '.md'
WHERE path = 'index.md' OR path LIKE '%/index.md';
UPDATE orchestrator_memory_files
SET path = substr(path, 1, length(path) - length('log.md')) || 'log-notes.md'
WHERE (path = 'log.md' OR path LIKE '%/log.md')
  AND NOT EXISTS (
    SELECT 1 FROM orchestrator_memory_files o2
    WHERE o2.user_id = orchestrator_memory_files.user_id
      AND o2.path = substr(orchestrator_memory_files.path, 1, length(orchestrator_memory_files.path) - length('log.md')) || 'log-notes.md');
UPDATE orchestrator_memory_files
SET path = substr(path, 1, length(path) - length('log.md')) || 'log-notes-' || substr(id, 1, 8) || '.md'
WHERE path = 'log.md' OR path LIKE '%/log.md';
UPDATE orchestrator_memory_files SET path = 'imported-' || path
WHERE path LIKE 'lib/%'
  AND NOT EXISTS (
    SELECT 1 FROM orchestrator_memory_files o2
    WHERE o2.user_id = orchestrator_memory_files.user_id AND o2.path = 'imported-' || orchestrator_memory_files.path);
UPDATE orchestrator_memory_files
SET path = 'imported-lib/' || substr(id, 1, 8) || '-' || substr(path, 5)
WHERE path LIKE 'lib/%';

-- Type backfill from directory defaults.
UPDATE orchestrator_memory_files SET type = CASE
  WHEN path LIKE 'preferences/%' THEN 'preference'
  WHEN path LIKE 'projects/%'    THEN 'project-note'
  WHEN path LIKE 'workflows/%'   THEN 'workflow'
  WHEN path LIKE 'journal/%'     THEN 'journal-entry'
  WHEN path LIKE 'people/%'      THEN 'person'
  ELSE 'note' END
WHERE type = '';

-- FTS rebuild with new columns. Repopulated from the base table (amnesty
-- renames above are therefore reflected). FTS description/tags derivation for
-- existing rows happens in the link-backfill pass (Task 9), which walks every
-- file anyway; here description indexes the (empty) authored column.
DROP TABLE orchestrator_memory_files_fts;
CREATE VIRTUAL TABLE orchestrator_memory_files_fts USING fts5(
  path, title, description, tags, content,
  tokenize='porter unicode61'
);
INSERT INTO orchestrator_memory_files_fts(rowid, path, title, description, tags, content)
SELECT rowid, path, title, description,
       (SELECT COALESCE(group_concat(value, ' '), '') FROM json_each(tags)),
       content
FROM orchestrator_memory_files;

-- Legacy dead table. Pre-deploy runbook: verify empty in prod
-- (SELECT COUNT(*) FROM agent_memories) — export to R2 or rename if not.
DROP TABLE agent_memories;
