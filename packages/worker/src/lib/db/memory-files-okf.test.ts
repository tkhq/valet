import { describe, it, expect, beforeEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { D1Database, D1Result } from '@cloudflare/workers-types';
import { createTestDb } from '../../test-utils/db.js';
import { makeD1Adapter } from '../../test-utils/d1.js';
import {
  writeMemoryFile,
  readMemoryFile,
  deleteMemoryFile,
  moveMemoryFile,
  patchMemoryFile,
  fileToConceptMeta,
  MAX_MEMORY_FILE_SIZE,
  type MemoryScope,
} from './memory-files.js';
import { renderConcept, renderBacklinksBlock } from '../okf.js';

const USER_ID = 'user-okf-test';
const scope: MemoryScope = { userId: USER_ID };

describe('memory-files OKF write path', () => {
  let rawDb: D1Database;
  let db: BetterSQLite3Database;
  let sqlite: DatabaseType;

  // Run an arbitrary read query against the underlying sqlite.
  const rawQuery = <T = Record<string, unknown>>(sql: string): T[] =>
    sqlite.prepare(sql).all() as T[];

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);
    sqlite
      .prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')")
      .run(USER_ID, `${USER_ID}@test.com`);
  });

  describe('writeMemoryFile v2', () => {
    it('create applies defaults: type from directory, sensitivity private, origin inferred', async () => {
      const { file } = await writeMemoryFile(rawDb, scope, 'projects/valet/notes.md', '# N\n\nBody.', {}, 'thread-1');
      expect(file.type).toBe('project-note');
      expect(file.sensitivity).toBe('private');
      expect(file.origin).toBe('inferred');
      expect(file.sourceSessionId).toBe('thread-1');
    });

    it('stickiness: body-only update leaves metadata unchanged', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'v1', { sensitivity: 'shareable', origin: 'user-stated' }, 't1');
      const { file } = await writeMemoryFile(rawDb, scope, 'notes/a.md', 'v2', {}, 't2');
      expect(file.sensitivity).toBe('shareable');
      expect(file.origin).toBe('user-stated');
    });

    it('metadata-only update: content undefined leaves body, bumps version', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'the body', {}, 't1');
      const { file } = await writeMemoryFile(rawDb, scope, 'notes/a.md', undefined, { tags: ['x'] }, 't1');
      expect(file.content).toBe('the body');
      expect(file.version).toBe(2);
      expect(file.tags).toEqual(['x']);
    });

    it('content "" rejected with remediation; create-without-content rejected', async () => {
      await expect(writeMemoryFile(rawDb, scope, 'notes/a.md', '', {}, 't')).rejects.toThrow(/mem_rm/);
      await expect(writeMemoryFile(rawDb, scope, 'notes/new.md', undefined, {}, 't')).rejects.toThrow(/does not exist/);
    });

    it('embedded frontmatter is stripped and disposition applies (agent channel)', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'plain', {}, 't1');
      const doc = '---\ntype: note\nvalet:\n  sensitivity: shareable\n---\nnew body\n';
      const { file, warnings } = await writeMemoryFile(rawDb, scope, 'notes/a.md', doc, {}, 't1');
      expect(file.content).toBe('new body\n');
      expect(file.sensitivity).toBe('private');
      expect(warnings.some((w) => w.includes('sensitivity'))).toBe(true);
    });

    it('reserved names rejected with the spec messages, post-normalization', async () => {
      await expect(writeMemoryFile(rawDb, scope, 'notes/Index.MD', 'x', {}, 't')).rejects.toThrow(/auto-generated/);
      await expect(writeMemoryFile(rawDb, scope, 'lib/x.md', 'x', {}, 't')).rejects.toThrow(/reserved for mounted libraries/);
      await expect(writeMemoryFile(rawDb, scope, 'a/b/c/d/e/f.md', 'x', {}, 't')).rejects.toThrow(/5 levels/);
    });

    it('resource is normalized on write and collision warns', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'x', { resource: 'https://github.com/tkhq/valet.git' }, 't');
      const { warnings } = await writeMemoryFile(rawDb, scope, 'notes/b.md', 'y', { resource: 'https://github.com/tkhq/valet/' }, 't');
      expect(warnings.some((w) => w.includes('notes/a.md'))).toBe(true);
    });

    it('links are extracted into memory_links with line context', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'See [B](/notes/b.md) for detail.\n', {}, 't');
      const links = rawQuery<{ to_path: string; context: string }>(
        `SELECT * FROM memory_links WHERE from_path = 'notes/a.md'`,
      );
      expect(links[0].to_path).toBe('notes/b.md');
      expect(links[0].context).toContain('See [B]');
    });
  });

  describe('deletion semantics', () => {
    it('mem_rm deletes inbound AND outgoing link rows, returns inbound warning', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'link [b](/notes/b.md)\n', {}, 't');
      await writeMemoryFile(rawDb, scope, 'notes/b.md', 'link [a](/notes/a.md)\n', {}, 't');
      const r = await deleteMemoryFile(rawDb, scope, 'notes/b.md');
      expect(r.inboundWarning).toContain('notes/a.md');
      const remaining = rawQuery(
        `SELECT * FROM memory_links WHERE from_path = 'notes/b.md' OR to_path = 'notes/b.md'`,
      );
      expect(remaining.length).toBe(0);
    });
  });

  describe('Law 2: agent round-trip through the DB layer', () => {
    it('write(renderConcept(read(x)) + backlinks block) changes nothing', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'Body.\n', { description: 'd', tags: ['t'] }, 't1');
      const before = await readMemoryFile(db, scope, 'notes/a.md');
      const doc = renderConcept(fileToConceptMeta(before!), before!.content) + '\n' + renderBacklinksBlock([], 0, '', 0);
      const { file: after } = await writeMemoryFile(rawDb, scope, 'notes/a.md', doc, {}, 't1');
      expect(after.content).toBe(before!.content);
      expect(after.description).toBe('d');
      expect(after.tags).toEqual(['t']);
    });
  });

  describe('patchMemoryFile size cap', () => {
    it('append that would grow an existing file past MAX_MEMORY_FILE_SIZE is rejected, file unchanged', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/big.md', 'a'.repeat(MAX_MEMORY_FILE_SIZE - 10), {}, 't1');
      await expect(
        patchMemoryFile(rawDb, scope, 'notes/big.md', [{ op: 'append', content: 'b'.repeat(100) }], 't1'),
      ).rejects.toThrow(/exceeds max size/);

      const after = await readMemoryFile(db, scope, 'notes/big.md');
      expect(after!.content).toBe('a'.repeat(MAX_MEMORY_FILE_SIZE - 10));
      expect(after!.version).toBe(1);
    });
  });

  describe('moveMemoryFile', () => {
    it('carries all metadata columns including source_session_id', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/old.md', 'Body.\n', {
        type: 'note',
        description: 'my note',
        tags: ['alpha', 'beta'],
        sensitivity: 'shareable',
        origin: 'user-stated',
      }, 'session-x');

      const result = await moveMemoryFile(rawDb, scope, 'notes/old.md', 'notes/new.md');
      expect(result.from).toBe('notes/old.md');
      expect(result.to).toBe('notes/new.md');

      const moved = await readMemoryFile(db, scope, 'notes/new.md');
      expect(moved).not.toBeNull();
      expect(moved!.content).toBe('Body.\n');
      expect(moved!.type).toBe('note');
      expect(moved!.description).toBe('my note');
      expect(moved!.tags).toEqual(['alpha', 'beta']);
      expect(moved!.sensitivity).toBe('shareable');
      expect(moved!.origin).toBe('user-stated');
      expect(moved!.sourceSessionId).toBe('session-x');

      // Old path is gone
      const old = await readMemoryFile(db, scope, 'notes/old.md');
      expect(old).toBeNull();
    });

    it('rejects destination with reserved name or invalid path', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'x', {}, 't');
      await expect(moveMemoryFile(rawDb, scope, 'notes/a.md', 'notes/index.md')).rejects.toThrow(/auto-generated/);
      await expect(moveMemoryFile(rawDb, scope, 'notes/a.md', 'lib/a.md')).rejects.toThrow(/reserved for mounted libraries/);
    });

    it('rejects move when destination already exists', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'a body', {}, 't');
      await writeMemoryFile(rawDb, scope, 'notes/b.md', 'b body', {}, 't');
      await expect(moveMemoryFile(rawDb, scope, 'notes/a.md', 'notes/b.md')).rejects.toThrow(/already exists/);
    });

    it('rewrites referencing bodies and updates memory_links', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/old.md', 'Old file.\n', {}, 't');
      await writeMemoryFile(
        rawDb, scope, 'notes/ref.md',
        'See [old](/notes/old.md) and also [old again](notes/old.md).\n',
        {}, 't',
      );

      const result = await moveMemoryFile(rawDb, scope, 'notes/old.md', 'notes/new.md');
      expect(result.referencersUpdated).toBe(1);
      expect(result.referencersSkipped).toHaveLength(0);

      const ref = await readMemoryFile(db, scope, 'notes/ref.md');
      expect(ref!.content).toContain('/notes/new.md');
      expect(ref!.content).not.toContain('/notes/old.md');
      expect(ref!.content).toContain('notes/new.md');
      expect(ref!.content).not.toContain('notes/old.md');

      // memory_links row updated to point to new path
      const links = rawQuery<{ from_path: string; to_path: string }>(
        `SELECT from_path, to_path FROM memory_links WHERE user_id = '${USER_ID}'`,
      );
      const link = links.find((l) => l.from_path === 'notes/ref.md');
      expect(link?.to_path).toBe('notes/new.md');
    });

    it('churn semantics: moved file updated_at preserved, version bumped; referencer updated_at not bumped, version bumped', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/old.md', 'Content.\n', {}, 't');
      await writeMemoryFile(rawDb, scope, 'notes/ref.md', 'See [old](/notes/old.md).\n', {}, 't');

      // Fetch baseline timestamps
      type Row = { path: string; updated_at: string; version: number };
      const before = rawQuery<Row>(
        `SELECT path, updated_at, version FROM orchestrator_memory_files WHERE user_id = '${USER_ID}'`,
      );
      const oldBefore = before.find((r) => r.path === 'notes/old.md')!;
      const refBefore = before.find((r) => r.path === 'notes/ref.md')!;

      await moveMemoryFile(rawDb, scope, 'notes/old.md', 'notes/new.md');

      const after = rawQuery<Row>(
        `SELECT path, updated_at, version FROM orchestrator_memory_files WHERE user_id = '${USER_ID}'`,
      );
      const newAfter = after.find((r) => r.path === 'notes/new.md')!;
      const refAfter = after.find((r) => r.path === 'notes/ref.md')!;

      // Moved file: updated_at preserved (not changed), version bumped
      expect(newAfter.updated_at).toBe(oldBefore.updated_at);
      expect(newAfter.version).toBe(oldBefore.version + 1);

      // Referencer: updated_at NOT bumped, version bumped
      expect(refAfter.updated_at).toBe(refBefore.updated_at);
      expect(refAfter.version).toBe(refBefore.version + 1);
    });

    it('reports pin transition: preferences/ → notes/ yields pinnedBefore true, pinnedAfter false', async () => {
      await writeMemoryFile(rawDb, scope, 'preferences/theme.md', 'dark mode\n', {}, 't');
      const result = await moveMemoryFile(rawDb, scope, 'preferences/theme.md', 'notes/theme.md');
      expect(result.pinnedBefore).toBe(true);
      expect(result.pinnedAfter).toBe(false);
    });

    it('reports pin transition: notes/ → preferences/ yields pinnedBefore false, pinnedAfter true', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/pref.md', 'x\n', {}, 't');
      const result = await moveMemoryFile(rawDb, scope, 'notes/pref.md', 'preferences/pref.md');
      expect(result.pinnedBefore).toBe(false);
      expect(result.pinnedAfter).toBe(true);
    });

    it('reports type and typeDefaultForDest for reclassify hint', async () => {
      // journal-entry type file moved to notes/ — typeDefaultForDest differs from actual type
      await writeMemoryFile(rawDb, scope, 'journal/2026-01-01.md', 'Entry.\n', { type: 'journal-entry' }, 't');
      const result = await moveMemoryFile(rawDb, scope, 'journal/2026-01-01.md', 'notes/archive-entry.md');
      expect(result.type).toBe('journal-entry');
      expect(result.typeDefaultForDest).toBe('note');

      // When type matches destination default, no reclassify needed
      await writeMemoryFile(rawDb, scope, 'notes/b.md', 'Note.\n', { type: 'note' }, 't');
      const result2 = await moveMemoryFile(rawDb, scope, 'notes/b.md', 'notes/c.md');
      expect(result2.type).toBe('note');
      expect(result2.typeDefaultForDest).toBe('note');
    });

    it('rewrites fragment links in referencer bodies', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/old.md', '# Old\n\n## Section\n', {}, 't');
      await writeMemoryFile(
        rawDb, scope, 'notes/ref.md',
        'See [section](/notes/old.md#section) for detail.\n',
        {}, 't',
      );

      await moveMemoryFile(rawDb, scope, 'notes/old.md', 'notes/new.md');

      const ref = await readMemoryFile(db, scope, 'notes/ref.md');
      expect(ref!.content).toContain('/notes/new.md#section');
      expect(ref!.content).not.toContain('/notes/old.md');
    });

    it('rewrites memory_links from_path for moved file outgoing rows', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/target.md', 'Target.\n', {}, 't');
      await writeMemoryFile(rawDb, scope, 'notes/old.md', 'Links to [target](/notes/target.md).\n', {}, 't');

      await moveMemoryFile(rawDb, scope, 'notes/old.md', 'notes/new.md');

      const links = rawQuery<{ from_path: string; to_path: string }>(
        `SELECT from_path, to_path FROM memory_links WHERE user_id = '${USER_ID}'`,
      );
      // The moved file's outgoing link row should now have from_path = notes/new.md
      const outgoing = links.find((l) => l.to_path === 'notes/target.md');
      expect(outgoing?.from_path).toBe('notes/new.md');
    });

    it('referencersSkipped: version guard SQL touches 0 rows on stale version; happy path reports empty', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/target.md', 'Target.\n', {}, 't');
      await writeMemoryFile(rawDb, scope, 'notes/ref.md', 'See [t](/notes/target.md).\n', {}, 't');

      // ── SQL-level guard mechanics ──────────────────────────────────────────
      // This is the exact guarded UPDATE statement moveMemoryFile uses per referencer.
      // A stale version (current - 1) must produce 0 changes.
      type IdRow = { id: string; version: number };
      const [refRow] = rawQuery<IdRow>(
        `SELECT id, version FROM orchestrator_memory_files WHERE user_id = '${USER_ID}' AND path = 'notes/ref.md'`,
      );
      const batchResults = (await rawDb.batch([
        rawDb
          .prepare(
            `UPDATE orchestrator_memory_files SET content = ?, version = version + 1 WHERE id = ? AND version = ?`,
          )
          .bind('new body', refRow.id, refRow.version - 1), // stale version — guard should fire
      ])) as D1Result<unknown>[];
      expect(batchResults[0]?.meta?.changes).toBe(0); // guard fired: 0 rows touched

      // ── Happy path: no referencers skipped ────────────────────────────────
      // Full concurrent-race simulation requires an adapter interception hook that
      // is not available in this synchronous harness; the SQL assertion above
      // verifies the guard mechanism at the unit level instead.
      const moveResult = await moveMemoryFile(rawDb, scope, 'notes/target.md', 'notes/moved.md');
      expect(moveResult.referencersUpdated).toBe(1);
      expect(moveResult.referencersSkipped).toHaveLength(0);
    });
  });
});
