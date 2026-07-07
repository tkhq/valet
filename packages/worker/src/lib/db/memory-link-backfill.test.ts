import { describe, it, expect, beforeEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb } from '../../test-utils/db.js';
import { makeD1Adapter } from '../../test-utils/d1.js';
import { ensureLinksIndexed, sweepExpiredMemories, _resetBackfillCacheForTests } from './memory-link-backfill.js';
import type { MemoryScope } from './memory-derived-stores.js';

const USER_ID = 'user-backfill-test';
const scope: MemoryScope = { userId: USER_ID };

/** Insert a raw memory-files row bypassing syncDerivedStores (simulates a legacy
 * row: no memory_links, FTS description column empty). */
function insertLegacyRow(
  sqlite: DatabaseType,
  userId: string,
  path: string,
  content: string,
  opts: { expires?: string } = {},
): void {
  const id = `${path}-${Math.random().toString(36).slice(2)}`;
  sqlite
    .prepare(
      `INSERT INTO orchestrator_memory_files (id, user_id, path, content, title, type, expires)
       VALUES (?, ?, ?, ?, ?, 'note', ?)`,
    )
    .run(id, userId, path, content, path, opts.expires ?? null);
  const row = sqlite.prepare('SELECT rowid FROM orchestrator_memory_files WHERE id = ?').get(id) as { rowid: number };
  sqlite
    .prepare(
      `INSERT INTO orchestrator_memory_files_fts(rowid, path, title, description, tags, content)
       VALUES (?, ?, ?, '', '', ?)`,
    )
    .run(row.rowid, path, path, content);
}

function insertIdentity(sqlite: DatabaseType, userId: string): void {
  sqlite
    .prepare(
      `INSERT INTO orchestrator_identities (id, user_id, org_id, type, name, handle)
       VALUES (?, ?, 'default', 'personal', 'Agent', ?)`,
    )
    .run(`id-${userId}`, userId, `handle-${userId}`);
}

describe('ensureLinksIndexed', () => {
  let rawDb: D1Database;
  let sqlite: DatabaseType;
  const rawQuery = <T = Record<string, unknown>>(sql: string): T[] => sqlite.prepare(sql).all() as T[];

  beforeEach(() => {
    _resetBackfillCacheForTests();
    ({ sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);
    sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(USER_ID, `${USER_ID}@test.com`);
    insertIdentity(sqlite, USER_ID);
  });

  it('first call runs backfill (true); second call skips (false)', async () => {
    insertLegacyRow(sqlite, USER_ID, 'notes/a.md', 'Intro paragraph.\n\nSee [B](/notes/b.md).\n');

    const first = await ensureLinksIndexed(rawDb, scope);
    expect(first).toBe(true);

    // Link row was populated from the body.
    const links = rawQuery<{ from_path: string; to_path: string }>('SELECT * FROM memory_links');
    expect(links).toHaveLength(1);
    expect(links[0].to_path).toBe('notes/b.md');

    // FTS description was derived from the first paragraph for the legacy row.
    const fts = rawQuery<{ description: string }>(
      `SELECT description FROM orchestrator_memory_files_fts WHERE path = 'notes/a.md'`,
    );
    expect(fts[0].description).toContain('Intro paragraph');

    // Sentinel set.
    const idn = rawQuery<{ links_indexed_at: string | null }>('SELECT links_indexed_at FROM orchestrator_identities');
    expect(idn[0].links_indexed_at).not.toBeNull();

    const second = await ensureLinksIndexed(rawDb, scope);
    expect(second).toBe(false);
  });

  it('is idempotent on concurrent calls', async () => {
    insertLegacyRow(sqlite, USER_ID, 'notes/a.md', 'Body.\n\n[B](/notes/b.md)\n');

    const results = await Promise.all([
      ensureLinksIndexed(rawDb, scope),
      ensureLinksIndexed(rawDb, scope),
    ]);
    // At least one performed the backfill; neither throws.
    expect(results.some((r) => r === true)).toBe(true);

    // No duplicate link rows (primary key + INSERT OR REPLACE keep it single).
    const links = rawQuery<{ to_path: string }>('SELECT * FROM memory_links');
    expect(links).toHaveLength(1);
  });

  it('handles a missing orchestrator_identities row (backfills, does not throw)', async () => {
    sqlite.prepare('DELETE FROM orchestrator_identities').run();
    insertLegacyRow(sqlite, USER_ID, 'notes/a.md', 'Body.\n\n[B](/notes/b.md)\n');

    const ran = await ensureLinksIndexed(rawDb, scope);
    expect(ran).toBe(true);
    const links = rawQuery<{ to_path: string }>('SELECT * FROM memory_links');
    expect(links).toHaveLength(1);
  });

  it('caches in-isolate for a sentinel-row-less user: first call backfills, second skips without re-running', async () => {
    sqlite.prepare('DELETE FROM orchestrator_identities').run();
    insertLegacyRow(sqlite, USER_ID, 'notes/a.md', 'Body.\n\n[B](/notes/b.md)\n');

    const first = await ensureLinksIndexed(rawDb, scope);
    expect(first).toBe(true);

    // Delete the link row directly to prove the second call does NOT re-walk
    // the files (which would repopulate it) — it must short-circuit on the
    // in-isolate cache instead.
    sqlite.prepare('DELETE FROM memory_links').run();

    const second = await ensureLinksIndexed(rawDb, scope);
    expect(second).toBe(false);
    const links = rawQuery<{ to_path: string }>('SELECT * FROM memory_links');
    expect(links).toHaveLength(0);
  });
});

describe('sweepExpiredMemories', () => {
  let rawDb: D1Database;
  let sqlite: DatabaseType;
  const rawQuery = <T = Record<string, unknown>>(sql: string): T[] => sqlite.prepare(sql).all() as T[];

  beforeEach(() => {
    _resetBackfillCacheForTests();
    ({ sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);
    sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(USER_ID, `${USER_ID}@test.com`);
  });

  it('deletes expired files + FTS + links, returns count', async () => {
    // Expired file with an outgoing link and an inbound link from a live file.
    insertLegacyRow(sqlite, USER_ID, 'notes/old.md', 'gone [x](/notes/live.md)\n', { expires: '2000-01-01 00:00:00' });
    insertLegacyRow(sqlite, USER_ID, 'notes/live.md', 'still here [old](/notes/old.md)\n');
    // Seed link rows in both directions.
    sqlite.prepare("INSERT INTO memory_links (user_id, from_path, to_path) VALUES (?, 'notes/old.md', 'notes/live.md')").run(USER_ID);
    sqlite.prepare("INSERT INTO memory_links (user_id, from_path, to_path) VALUES (?, 'notes/live.md', 'notes/old.md')").run(USER_ID);

    const deleted = await sweepExpiredMemories(rawDb);
    expect(deleted).toBe(1);

    const files = rawQuery<{ path: string }>('SELECT path FROM orchestrator_memory_files');
    expect(files.map((f) => f.path)).toEqual(['notes/live.md']);

    const fts = rawQuery<{ path: string }>('SELECT path FROM orchestrator_memory_files_fts');
    expect(fts.map((f) => f.path)).toEqual(['notes/live.md']);

    // Both the outgoing and inbound link rows referencing the expired file are gone.
    const links = rawQuery<{ from_path: string; to_path: string }>('SELECT * FROM memory_links');
    expect(links).toHaveLength(0);
  });

  it('does not delete non-expired files', async () => {
    const future = '2999-01-01 00:00:00';
    insertLegacyRow(sqlite, USER_ID, 'notes/future.md', 'later', { expires: future });
    insertLegacyRow(sqlite, USER_ID, 'notes/forever.md', 'never expires');

    const deleted = await sweepExpiredMemories(rawDb);
    expect(deleted).toBe(0);
    const files = rawQuery<{ path: string }>('SELECT path FROM orchestrator_memory_files ORDER BY path');
    expect(files.map((f) => f.path)).toEqual(['notes/forever.md', 'notes/future.md']);
  });
});
