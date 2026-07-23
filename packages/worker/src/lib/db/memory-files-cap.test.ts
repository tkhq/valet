import { describe, it, expect, beforeEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb } from '../../test-utils/db.js';
import { makeD1Adapter } from '../../test-utils/d1.js';
import { writeMemoryFile, type MemoryScope } from './memory-files.js';

/**
 * Regression tests for the memory-cap self-eviction bug.
 *
 * Root cause (pre-fix): writeMemoryFile called enforceMemoryCap AFTER selecting
 * savedRow and had no way to signal "don't consider the just-written row as a
 * victim". Because the read-boost path pushes any previously-touched file's
 * relevance above the schema default (1.0), a fresh file at exactly relevance=1.0
 * became the unique ORDER BY minimum and got deterministically evicted while the
 * tool response still claimed success — silent data loss.
 */

const USER = 'user-cap-test';
const scope: MemoryScope = { userId: USER };

const MEMORY_CAP = 500;

describe('memory-files cap enforcement — self-eviction regression', () => {
  let rawDb: D1Database;
  let db: BetterSQLite3Database;
  let sqlite: DatabaseType;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);
    sqlite
      .prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')")
      .run(USER, `${USER}@test.com`);
  });

  /**
   * Seed the store at exactly the cap, then bump every existing non-pinned
   * row's relevance above the schema default so the NEXT write (which starts
   * at relevance=1.0) would be the unique ORDER BY minimum on the old code
   * path. If self-eviction has been fixed, the new file must survive and
   * something else must be evicted; if it hasn't, the new file itself is the
   * victim and this assertion fails.
   */
  it('never evicts the just-written file when the cap is reached', async () => {
    // Seed the store to exactly MEMORY_CAP non-pinned files.
    for (let i = 0; i < MEMORY_CAP; i++) {
      await writeMemoryFile(rawDb, scope, `notes/seed-${i}.md`, `# seed ${i}`, {}, '');
    }

    // Bump every seed row above the default relevance so the fresh write's
    // relevance=1.0 would be the unique minimum on the old code path.
    sqlite
      .prepare("UPDATE orchestrator_memory_files SET relevance = 1.5 WHERE user_id = ? AND pinned = 0")
      .run(USER);

    // Write one more file — at the cap + 1, the pruner MUST fire.
    const targetPath = 'notes/the-new-file.md';
    const { warnings } = await writeMemoryFile(rawDb, scope, targetPath, '# new\n\nfresh content', {}, '');

    // The new file must still exist. This is the bug repro: pre-fix, this
    // assertion failed because the fresh file self-evicted.
    const survived = sqlite
      .prepare('SELECT path, content FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
      .get(USER, targetPath) as { path: string; content: string } | undefined;
    expect(survived).toBeDefined();
    expect(survived?.content).toContain('fresh content');

    // Exactly one seed file must have been evicted to keep us at the cap.
    const totalNonPinned = (sqlite
      .prepare('SELECT COUNT(*) AS c FROM orchestrator_memory_files WHERE user_id = ? AND pinned = 0')
      .get(USER) as { c: number }).c;
    expect(totalNonPinned).toBe(MEMORY_CAP);

    // The write result should carry an eviction warning so callers know the
    // silent-data-loss was replaced with a visible signal.
    expect(warnings.some((w) => /memory cap reached/i.test(w))).toBe(true);
    expect(warnings.some((w) => /evicted/i.test(w))).toBe(true);
  });

  it('does not warn when no eviction was needed (below the cap)', async () => {
    // A single write well under the cap should not produce a cap warning.
    const { warnings } = await writeMemoryFile(rawDb, scope, 'notes/small.md', '# small', {}, '');
    expect(warnings.some((w) => /memory cap reached/i.test(w))).toBe(false);
  });

  it('warning names the evicted paths (or a preview) so callers can trace loss', async () => {
    // Seed at cap and mark seeds as older/lower-priority so their eviction is
    // deterministic — then confirm the warning surfaces the evicted path list.
    for (let i = 0; i < MEMORY_CAP; i++) {
      await writeMemoryFile(rawDb, scope, `notes/seed-${i}.md`, `# seed ${i}`, {}, '');
    }
    sqlite
      .prepare("UPDATE orchestrator_memory_files SET relevance = 1.5 WHERE user_id = ? AND pinned = 0")
      .run(USER);

    const { warnings } = await writeMemoryFile(rawDb, scope, 'notes/newcomer.md', '# newcomer', {}, '');

    const capWarning = warnings.find((w) => /memory cap reached/i.test(w));
    expect(capWarning).toBeDefined();
    // The evicted seed's path should appear in the warning preview so a user
    // reading tool output can grep back to the lost file.
    expect(capWarning).toMatch(/notes\/seed-/);
  });

  it('bulk import cap-enforcement path still works after the return-shape change', async () => {
    // The bulk import call site consumes { count, paths } and only threads
    // count through as `pruned`. Verify it still runs and reports correctly
    // when it fires — the existing memory-files-export.test.ts covers the
    // end-to-end import path; this is a narrow guard against a signature
    // regression at the enforceMemoryCap boundary.
    // Seed above the cap and confirm a subsequent write self-heals.
    for (let i = 0; i < MEMORY_CAP + 5; i++) {
      // enforceCap=false on bulk seed to defer to a single enforcement.
      await writeMemoryFile(
        rawDb,
        scope,
        `notes/bulk-${i}.md`,
        `# bulk ${i}`,
        {},
        '',
        // arg 7: enforceCap
        false,
      );
    }
    // Trigger a single cap enforcement via a normal write (which will exclude
    // itself and evict 6 seeds — 5 excess + 1 for the new write).
    const { warnings } = await writeMemoryFile(rawDb, scope, 'notes/trigger.md', '# trigger', {}, '');
    const nonPinned = (sqlite
      .prepare('SELECT COUNT(*) AS c FROM orchestrator_memory_files WHERE user_id = ? AND pinned = 0')
      .get(USER) as { c: number }).c;
    expect(nonPinned).toBe(MEMORY_CAP);
    expect(warnings.some((w) => /memory cap reached/i.test(w))).toBe(true);

    // The trigger file must survive.
    const trigger = sqlite
      .prepare('SELECT path FROM orchestrator_memory_files WHERE user_id = ? AND path = ?')
      .get(USER, 'notes/trigger.md');
    expect(trigger).toBeDefined();
  });
});
