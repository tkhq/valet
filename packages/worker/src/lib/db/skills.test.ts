import { describe, it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { upsertSkillFromSync } from './skills.js';
import { createTestDb } from '../../test-utils/db.js';

const baseSkill = {
  id: 'skill:default:workflows',
  orgId: 'default',
  source: 'builtin' as const,
  name: 'Workflows',
  slug: 'workflows',
  content: 'how to manage triggers and workflows',
  visibility: 'shared' as const,
};

function skillRowid(sqlite: import('better-sqlite3').Database, id: string): number {
  return (sqlite.prepare('SELECT rowid FROM skills WHERE id = ?').get(id) as { rowid: number }).rowid;
}

function ftsCount(sqlite: import('better-sqlite3').Database, rowid: number): number {
  return (sqlite.prepare('SELECT count(*) AS c FROM skills_fts WHERE rowid = ?').get(rowid) as { c: number }).c;
}

function ftsMatchCount(sqlite: import('better-sqlite3').Database, term: string): number {
  return (sqlite.prepare('SELECT count(*) AS c FROM skills_fts WHERE skills_fts MATCH ?').get(term) as { c: number }).c;
}

describe('upsertSkillFromSync — FTS indexing', () => {
  it('inserts the skill and indexes it in a single atomic FTS write', async () => {
    const { db, sqlite } = createTestDb();

    await upsertSkillFromSync(db, baseSkill);

    const rowid = skillRowid(sqlite, baseSkill.id);
    expect(ftsCount(sqlite, rowid)).toBe(1);
    // Content is searchable.
    expect(ftsMatchCount(sqlite, 'triggers')).toBe(1);
  });

  it('re-indexing an already-indexed skill overwrites cleanly instead of raising a constraint error', async () => {
    const { db, sqlite } = createTestDb();
    await upsertSkillFromSync(db, baseSkill);
    const rowid = skillRowid(sqlite, baseSkill.id);

    // The FTS row already exists for this rowid; a changed-content resync must
    // overwrite it in place rather than collide.
    await expect(
      upsertSkillFromSync(db, { ...baseSkill, content: 'updated trigger management guidance' }),
    ).resolves.toBeUndefined();

    expect(ftsCount(sqlite, rowid)).toBe(1);
    // The index now reflects the new content, not the old.
    expect(ftsMatchCount(sqlite, 'guidance')).toBe(1);
  });

  it('INSERT OR REPLACE avoids the SQLITE_CONSTRAINT a bare INSERT hits on an occupied rowid', () => {
    // Deterministic proof of the incident mechanism: two cold isolates race a
    // DELETE-then-INSERT pair (A.DELETE, B.DELETE, A.INSERT, B.INSERT) and B's
    // bare INSERT collides on the rowid. The fix collapses it to one statement.
    const { sqlite } = createTestDb();
    const ins = (or: string) =>
      sqlite
        .prepare(`INSERT ${or} INTO skills_fts(rowid, name, description, content) VALUES (?, ?, ?, ?)`)
        .run(7, 'a', 'd', 'c');

    ins(''); // first isolate indexes rowid 7
    // Second isolate's INSERT (its DELETE already lost the race) — old code path.
    expect(() => ins('')).toThrow(/constraint/i);
    // The fix: INSERT OR REPLACE overwrites in place, no error.
    expect(() =>
      sqlite
        .prepare('INSERT OR REPLACE INTO skills_fts(rowid, name, description, content) VALUES (?, ?, ?, ?)')
        .run(7, 'a2', 'd2', 'c2'),
    ).not.toThrow();
    expect(ftsCount(sqlite, 7)).toBe(1);
  });

  it('skips the UPDATE and the FTS rewrite when nothing changed', async () => {
    const { db, sqlite } = createTestDb();
    await upsertSkillFromSync(db, baseSkill);
    const rowid = skillRowid(sqlite, baseSkill.id);

    // Sentinel: if the UPDATE runs, updated_at is overwritten with datetime('now').
    sqlite.prepare("UPDATE skills SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(baseSkill.id);

    await upsertSkillFromSync(db, { ...baseSkill });

    const after = sqlite.prepare('SELECT updated_at FROM skills WHERE id = ?').get(baseSkill.id) as {
      updated_at: string;
    };
    expect(after.updated_at).toBe('2020-01-01 00:00:00');
    expect(ftsCount(sqlite, rowid)).toBe(1);
  });

  it('re-indexes on an unchanged skill when its FTS row is missing (self-healing backfill)', async () => {
    const { db, sqlite } = createTestDb();
    await upsertSkillFromSync(db, baseSkill);
    const rowid = skillRowid(sqlite, baseSkill.id);

    // A skill that failed to index on an earlier sync: row present, FTS entry gone.
    sqlite.prepare('DELETE FROM skills_fts WHERE rowid = ?').run(rowid);
    expect(ftsCount(sqlite, rowid)).toBe(0);

    // Unchanged content, so the UPDATE is still skipped, but the missing index is restored.
    await upsertSkillFromSync(db, { ...baseSkill });

    expect(ftsCount(sqlite, rowid)).toBe(1);
    expect(ftsMatchCount(sqlite, 'triggers')).toBe(1);
  });

  it('updates the row and refreshes the index when content changes', async () => {
    const { db, sqlite } = createTestDb();
    await upsertSkillFromSync(db, baseSkill);

    await upsertSkillFromSync(db, { ...baseSkill, content: 'brand new searchable phrase alpha' });

    const row = sqlite.prepare('SELECT content FROM skills WHERE id = ?').get(baseSkill.id) as {
      content: string;
    };
    expect(row.content).toContain('alpha');
    expect(ftsMatchCount(sqlite, 'alpha')).toBe(1);
    // Old content is no longer indexed.
    expect(ftsMatchCount(sqlite, 'triggers')).toBe(0);
  });

  it('truncates oversized content to 2000 chars before indexing', async () => {
    const { db, sqlite } = createTestDb();
    await upsertSkillFromSync(db, { ...baseSkill, content: 'y'.repeat(2500) });

    const rowid = skillRowid(sqlite, baseSkill.id);
    const fts = sqlite.prepare('SELECT content FROM skills_fts WHERE rowid = ?').get(rowid) as {
      content: string;
    };
    expect(fts.content.length).toBe(2000);
  });
});

describe('skills FTS sync — raw D1 client path', () => {
  it('issues a single INSERT OR REPLACE (no separate DELETE) on the raw client', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({ run })),
    }));

    const db = {
      all: vi
        .fn()
        // 1st all(): fetch the skill row for FTS.
        .mockResolvedValueOnce([{ rowid: 2, name: 'Google Calendar', description: '', content: 'x'.repeat(2500) }]),
      run: vi.fn(),
      session: { client: { prepare } },
      // Skill does not yet exist → INSERT branch, then full (non-skip) FTS write.
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    } as any;

    await upsertSkillFromSync(db, {
      id: 'skill:default:google-calendar',
      orgId: 'default',
      source: 'plugin',
      name: 'Google Calendar',
      slug: 'google-calendar',
      content: 'original content',
      visibility: 'shared',
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(
      'INSERT OR REPLACE INTO skills_fts(rowid, name, description, content) VALUES (?, ?, ?, ?)',
    );
    const bind = prepare.mock.results[0].value.bind;
    expect(bind).toHaveBeenCalledWith(2, 'Google Calendar', '', 'x'.repeat(2000));
  });
});
