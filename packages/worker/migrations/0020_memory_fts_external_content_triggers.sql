-- Convert orchestrator_memory_files_fts to an FTS5 *external-content* table kept
-- in sync by triggers, so writes no longer issue manual FTS statements. This is
-- what lets bulk memory import collapse to one upsert per file (batchable) — the
-- per-file FTS round-trips and the rowid read-after-write go away.
--
-- The trigger-into-FTS5 mechanic was validated on remote dev D1 before shipping.
-- Uppercase BEGIN/END is required on remote D1 (same as migration 0014).
-- Column order (path, title, content) is preserved so searchMemoryFiles'
-- bm25(...,5,10,1) weights still map correctly.

DROP TRIGGER IF EXISTS orchestrator_memory_files_ai;
DROP TRIGGER IF EXISTS orchestrator_memory_files_ad;
DROP TRIGGER IF EXISTS orchestrator_memory_files_au;
DROP TABLE IF EXISTS orchestrator_memory_files_fts;

CREATE VIRTUAL TABLE orchestrator_memory_files_fts USING fts5(
  path,
  title,
  content,
  content='orchestrator_memory_files',
  tokenize='porter unicode61'
);

-- content_rowid defaults to 'rowid' = the base table's implicit rowid, which is
-- exactly what searchMemoryFiles JOINs on today.
CREATE TRIGGER orchestrator_memory_files_ai AFTER INSERT ON orchestrator_memory_files BEGIN
  INSERT INTO orchestrator_memory_files_fts(rowid, path, title, content)
  VALUES (new.rowid, new.path, new.title, new.content);
END;

CREATE TRIGGER orchestrator_memory_files_ad AFTER DELETE ON orchestrator_memory_files BEGIN
  INSERT INTO orchestrator_memory_files_fts(orchestrator_memory_files_fts, rowid, path, title, content)
  VALUES('delete', old.rowid, old.path, old.title, old.content);
END;

-- WHEN guard: only re-index when an indexed column actually changes. Relevance
-- boosts on read (boostMemoryFileRelevance) update relevance/last_accessed_at
-- only, so this avoids churning the FTS index on every memory read.
CREATE TRIGGER orchestrator_memory_files_au AFTER UPDATE ON orchestrator_memory_files
WHEN old.path IS NOT new.path OR old.title IS NOT new.title OR old.content IS NOT new.content
BEGIN
  INSERT INTO orchestrator_memory_files_fts(orchestrator_memory_files_fts, rowid, path, title, content)
  VALUES('delete', old.rowid, old.path, old.title, old.content);
  INSERT INTO orchestrator_memory_files_fts(rowid, path, title, content)
  VALUES (new.rowid, new.path, new.title, new.content);
END;

-- Rebuild the index from existing rows (external-content supports 'rebuild').
INSERT INTO orchestrator_memory_files_fts(orchestrator_memory_files_fts) VALUES('rebuild');
