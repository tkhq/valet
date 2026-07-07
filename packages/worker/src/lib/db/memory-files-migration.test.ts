/**
 * Smoke test for migration 0026_okf_memory.sql.
 *
 * Strategy: because createTestDb() applies ALL migrations at once (no seeded
 * pre-0026 rows exist when the amnesty UPDATEs run), we build a second
 * incremental harness that:
 *   1. Applies migrations 0001–0025 to establish the pre-0026 schema.
 *   2. Seeds rows with reserved paths (index.md, log.md, lib/*) and a normal
 *      projects/* row.
 *   3. Applies migration 0026 and asserts all expected outcomes.
 *
 * A separate set of assertions uses the standard createTestDb() (all
 * migrations) to verify the final schema shape.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../../../migrations');

function allMigrationFiles(): string[] {
  return fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Apply a subset of migration files to a fresh in-memory DB. */
function createPartialDb(upToExclusive: string): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  for (const file of allMigrationFiles()) {
    if (file >= upToExclusive) break;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    sqlite.exec(sql);
  }
  return sqlite;
}

/** Apply a single named migration file to an existing DB. */
function applyMigration(sqlite: Database.Database, fileName: string): void {
  const sql = fs.readFileSync(path.join(migrationsDir, fileName), 'utf-8');
  sqlite.exec(sql);
}

/** Apply all migrations to get the final schema. */
function createFullDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  for (const file of allMigrationFiles()) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    sqlite.exec(sql);
  }
  return sqlite;
}

const USER_ID = 'user-mig-test';
const MIGRATION_FILE = '0026_okf_memory.sql';

describe('migration 0026 smoke test (incremental harness)', () => {
  function buildSeededDb() {
    const sqlite = createPartialDb(MIGRATION_FILE);
    sqlite
      .prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')")
      .run(USER_ID, `${USER_ID}@test.com`);

    const insert = sqlite.prepare(
      `INSERT INTO orchestrator_memory_files
         (id, user_id, path, content, title)
       VALUES (?, ?, ?, ?, ?)`
    );
    // Normal path — expects type backfill to 'project-note'
    insert.run('id-proj', USER_ID, 'projects/x.md', '# X\n\nProject content.', 'X');
    // Reserved name — expects path amnesty rename to notes/index-notes.md
    insert.run('id-idx', USER_ID, 'notes/index.md', '# Index\n\nSome index.', 'Index');
    // Reserved name — expects path amnesty rename to notes/log-notes.md
    insert.run('id-log', USER_ID, 'notes/log.md', '# Log\n\nSome log.', 'Log');
    // lib/ prefix — expects rename to imported-lib/a.md
    insert.run('id-lib', USER_ID, 'lib/a.md', '# Lib\n\nA library note.', 'Lib');

    applyMigration(sqlite, MIGRATION_FILE);
    return sqlite;
  }

  it('type backfill: projects/* row gets type = project-note', () => {
    const sqlite = buildSeededDb();
    const row = sqlite
      .prepare('SELECT type FROM orchestrator_memory_files WHERE id = ?')
      .get('id-proj') as { type: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.type).toBe('project-note');
  });

  it('amnesty: notes/index.md is renamed to notes/index-notes.md', () => {
    const sqlite = buildSeededDb();
    const row = sqlite
      .prepare('SELECT path FROM orchestrator_memory_files WHERE id = ?')
      .get('id-idx') as { path: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.path).toBe('notes/index-notes.md');
  });

  it('amnesty: notes/log.md is renamed to notes/log-notes.md', () => {
    const sqlite = buildSeededDb();
    const row = sqlite
      .prepare('SELECT path FROM orchestrator_memory_files WHERE id = ?')
      .get('id-log') as { path: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.path).toBe('notes/log-notes.md');
  });

  it('amnesty: lib/a.md is renamed to imported-lib/a.md', () => {
    const sqlite = buildSeededDb();
    const row = sqlite
      .prepare('SELECT path FROM orchestrator_memory_files WHERE id = ?')
      .get('id-lib') as { path: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.path).toBe('imported-lib/a.md');
  });

  it('FTS MATCH still finds content seeded before 0026', () => {
    const sqlite = buildSeededDb();
    const rows = sqlite
      .prepare(
        "SELECT path FROM orchestrator_memory_files_fts WHERE orchestrator_memory_files_fts MATCH ? ORDER BY rank"
      )
      .all('content') as { path: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.path === 'projects/x.md')).toBe(true);
  });

  it('agent_memories table is dropped', () => {
    const sqlite = buildSeededDb();
    expect(() =>
      sqlite.prepare('SELECT COUNT(*) FROM agent_memories').get()
    ).toThrow();
  });
});

describe('migration 0026 schema shape (full migrations harness)', () => {
  let sqlite: Database.Database;

  // Run once — schema is read-only
  sqlite = createFullDb();

  it('orchestrator_memory_files has new OKF metadata columns', () => {
    // PRAGMA table_info returns one row per column
    const cols = sqlite
      .prepare('PRAGMA table_info(orchestrator_memory_files)')
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    for (const expected of [
      'type', 'description', 'tags', 'resource', 'extras',
      'sensitivity', 'origin', 'source_session_id', 'expires',
    ]) {
      expect(names, `column ${expected} should exist`).toContain(expected);
    }
  });

  it('memory_links table exists with correct columns', () => {
    const cols = sqlite
      .prepare('PRAGMA table_info(memory_links)')
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('user_id');
    expect(names).toContain('from_path');
    expect(names).toContain('to_path');
    expect(names).toContain('context');
    expect(names).toContain('created_at');
  });

  it('orchestrator_identities has links_indexed_at column', () => {
    const cols = sqlite
      .prepare('PRAGMA table_info(orchestrator_identities)')
      .all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('links_indexed_at');
  });

  it('FTS table has 5 columns (path, title, description, tags, content)', () => {
    // fts5 content columns appear in fts_config
    // The 'content' key in fts5 config stores the column list or base table name.
    // A simpler check: query an empty MATCH to validate the table accepts the shape.
    expect(() =>
      sqlite
        .prepare(
          "SELECT path, title, description, tags, content FROM orchestrator_memory_files_fts LIMIT 0"
        )
        .all()
    ).not.toThrow();
  });

  it('agent_memories table does not exist', () => {
    expect(() =>
      sqlite.prepare('SELECT COUNT(*) FROM agent_memories').get()
    ).toThrow();
  });
});
