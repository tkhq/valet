import { describe, it, expect, beforeEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb } from '../test-utils/db.js';
import { makeD1Adapter } from '../test-utils/d1.js';
import { loadMemorySnapshot, formatMemorySnapshot } from './memory-snapshot.js';
import { _resetBackfillCacheForTests } from './db/memory-link-backfill.js';

const USER_ID = 'user-snapshot-test';

function insertFile(
  sqlite: DatabaseType,
  path: string,
  content: string,
  opts: { pinned?: number; type?: string; description?: string; expires?: string } = {},
): void {
  const id = `${path}-${Math.random().toString(36).slice(2)}`;
  sqlite
    .prepare(
      `INSERT INTO orchestrator_memory_files (id, user_id, path, content, title, type, description, pinned, expires)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, USER_ID, path, content, path, opts.type ?? 'note', opts.description ?? '', opts.pinned ?? 0, opts.expires ?? null);
}

function seedLink(sqlite: DatabaseType, fromPath: string, toPath: string): void {
  sqlite
    .prepare('INSERT INTO memory_links (user_id, from_path, to_path) VALUES (?, ?, ?)')
    .run(USER_ID, fromPath, toPath);
}

describe('loadMemorySnapshot neighbor tier', () => {
  let rawDb: D1Database;
  let sqlite: DatabaseType;

  beforeEach(() => {
    _resetBackfillCacheForTests();
    ({ sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);
    sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(USER_ID, `${USER_ID}@test.com`);
    // Set the backfill sentinel so loadMemorySnapshot's ensureLinksIndexed is a
    // no-op and leaves the hand-seeded memory_links rows intact.
    sqlite
      .prepare(
        `INSERT INTO orchestrator_identities (id, user_id, org_id, type, name, handle, links_indexed_at)
         VALUES (?, ?, 'default', 'personal', 'Agent', ?, datetime('now'))`,
      )
      .run('id-1', USER_ID, 'h-1');
  });

  it('promotes pinned files\' 1-hop neighbors (path + description + type, no body)', async () => {
    insertFile(sqlite, 'preferences/style.md', 'Pinned body linking [deep](/notes/deep.md).', { pinned: 1 });
    insertFile(sqlite, 'notes/deep.md', 'SECRET_BODY should not appear', { type: 'note', description: 'a deep note' });
    seedLink(sqlite, 'preferences/style.md', 'notes/deep.md');

    const snapshot = await loadMemorySnapshot(rawDb, USER_ID);
    expect(snapshot.neighbors.map((n) => n.path)).toContain('notes/deep.md');

    const rendered = formatMemorySnapshot(snapshot);
    expect(rendered).toContain('## Related (neighbor files)');
    expect(rendered).toContain('- [note] notes/deep.md — a deep note');
    // Bodies of neighbors are never included.
    expect(rendered).not.toContain('SECRET_BODY');
  });

  it('excludes expired neighbors', async () => {
    insertFile(sqlite, 'preferences/style.md', 'links [gone](/notes/gone.md)', { pinned: 1 });
    insertFile(sqlite, 'notes/gone.md', 'expired body', { expires: '2000-01-01 00:00:00' });
    seedLink(sqlite, 'preferences/style.md', 'notes/gone.md');

    const snapshot = await loadMemorySnapshot(rawDb, USER_ID);
    expect(snapshot.neighbors.map((n) => n.path)).not.toContain('notes/gone.md');
  });

  it('does not re-list a neighbor already present as a pinned or journal file', async () => {
    const today = new Date().toISOString().slice(0, 10);
    insertFile(sqlite, 'preferences/a.md', 'links [b](/preferences/b.md) and [j](/journal/' + today + '.md)', { pinned: 1 });
    insertFile(sqlite, 'preferences/b.md', 'other pinned', { pinned: 1 });
    insertFile(sqlite, `journal/${today}.md`, '# journal today\n\nstuff');
    seedLink(sqlite, 'preferences/a.md', 'preferences/b.md');
    seedLink(sqlite, 'preferences/a.md', `journal/${today}.md`);

    const snapshot = await loadMemorySnapshot(rawDb, USER_ID);
    const neighborPaths = snapshot.neighbors.map((n) => n.path);
    expect(neighborPaths).not.toContain('preferences/b.md');
    expect(neighborPaths).not.toContain(`journal/${today}.md`);
  });

  it('caps total tokens (pinned+journal+neighbors) at the budget, not budget+20%', async () => {
    // Pinned (5000 tokens) + a today's journal large enough to be truncated to
    // fill the rest of the main tier — this saturates the main tier exactly at
    // its ceiling. A neighbor tier is attached on top. Pre-fix, the main tier's
    // ceiling was the full tokenBudget (8000) and the neighbor sub-budget (20%)
    // was added on top of that, so the combined total could reach 9600. Post-fix,
    // the neighbor sub-budget is carved out of tokenBudget up front, so the main
    // tier ceiling drops to tokenBudget - neighborBudget and the grand total never
    // exceeds tokenBudget.
    const tokenBudget = 8000;
    const today = new Date().toISOString().slice(0, 10);
    const pinnedContent = 'A'.repeat(5000 * 4); // ~5000 tokens
    const journalContent = 'B'.repeat(6000 * 4); // ~6000 tokens, larger than any remaining room — forces truncation
    insertFile(sqlite, 'preferences/big.md', pinnedContent, { pinned: 1 });
    insertFile(sqlite, `journal/${today}.md`, journalContent);
    insertFile(sqlite, 'notes/neighbor.md', 'ignored body', { type: 'note', description: 'a neighbor' });
    seedLink(sqlite, 'preferences/big.md', 'notes/neighbor.md');

    const snapshot = await loadMemorySnapshot(rawDb, USER_ID, tokenBudget);

    const estimateTokens = (s: string) => Math.ceil(s.length / 4);
    const fileTokens = snapshot.files.reduce((sum, f) => sum + estimateTokens(f.content), 0);
    const neighborTokens = snapshot.neighbors.reduce(
      (sum, n) => sum + estimateTokens(`- [${n.type}] ${n.path}${n.description ? ` — ${n.description}` : ''}`),
      0,
    );
    expect(snapshot.neighbors.map((n) => n.path)).toContain('notes/neighbor.md');
    expect(fileTokens + neighborTokens).toBeLessThanOrEqual(tokenBudget);
    // The main tier must have been capped well below the full budget (not
    // allowed to fill all the way to tokenBudget) to leave room for the
    // carved-out neighbor sub-budget. A small slack accounts for the
    // "[... truncated]" suffix appended after the token-budget slice point.
    const neighborBudget = Math.floor(tokenBudget * 0.2);
    expect(fileTokens).toBeLessThanOrEqual(tokenBudget - neighborBudget + 10);
  });

  it('excludes expired pinned files from the snapshot body', async () => {
    insertFile(sqlite, 'preferences/live.md', 'LIVE_PINNED', { pinned: 1 });
    insertFile(sqlite, 'preferences/dead.md', 'DEAD_PINNED', { pinned: 1, expires: '2000-01-01 00:00:00' });

    const snapshot = await loadMemorySnapshot(rawDb, USER_ID);
    const paths = snapshot.files.map((f) => f.path);
    expect(paths).toContain('preferences/live.md');
    expect(paths).not.toContain('preferences/dead.md');
  });
});
