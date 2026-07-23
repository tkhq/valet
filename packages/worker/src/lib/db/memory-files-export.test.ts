import { describe, it, expect, beforeEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb } from '../../test-utils/db.js';
import { makeD1Adapter } from '../../test-utils/d1.js';
import { writeMemoryFile, exportMemoryFiles, importMemoryFiles } from './memory-files.js';
import { fromIso } from '../okf.js';

interface Harness {
  db: BetterSQLite3Database;
  sqlite: DatabaseType;
  rawDb: D1Database;
}

function makeHarness(...userIds: string[]): Harness {
  const { db, sqlite } = createTestDb();
  for (const id of userIds) {
    sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(id, `${id}@test.com`);
  }
  return { db, sqlite, rawDb: makeD1Adapter(sqlite) };
}

const USER = 'user-export-a';
const OTHER = 'user-export-b';
const scope = { userId: USER };

interface MemRow {
  path: string;
  content: string;
  title: string;
  type: string;
  sensitivity: string;
  origin: string;
  source_session_id: string;
  updated_at: string;
  version: number;
  pinned: number;
}

const getRow = (h: Harness, userId: string, path: string): MemRow | undefined =>
  h.sqlite
    .prepare(
      `SELECT path, content, title, type, sensitivity, origin, source_session_id, updated_at, version, pinned
       FROM orchestrator_memory_files WHERE user_id = ? AND path = ?`,
    )
    .get(userId, path) as MemRow | undefined;

/** Reduce a manifest to the map form the importer consumes. */
const toContentMap = (files: Record<string, { content: string }>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([p, e]) => [p, e.content]));

describe('exportMemoryFiles (manifest v2)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = makeHarness(USER, OTHER);
    await writeMemoryFile(h.rawDb, scope, 'projects/valet/overview.md',
      '# Valet\n\nA hosted coding agent. See [style](/preferences/coding-style.md).',
      { description: 'Valet overview', tags: ['valet'], sensitivity: 'shareable', origin: 'user-stated' }, '');
    await writeMemoryFile(h.rawDb, scope, 'preferences/coding-style.md', '# Style\n\nStrict TypeScript.', {}, '');
    await writeMemoryFile(h.rawDb, scope, 'notes/secret-plan.md', '# Secret Plan\n\nPrivate stuff.', {}, '');
  });

  it('renders every concept with frontmatter, hash, and valetState', async () => {
    const manifest = await exportMemoryFiles(h.db, scope);

    expect(manifest.okfVersion).toBe('0.1');
    expect(manifest.include).toBe('all');
    expect(manifest.leakFlags).toEqual([]);

    const overview = manifest.files['projects/valet/overview.md'];
    expect(overview).toBeDefined();
    expect(overview.content).toMatch(/^---\ntype: "project-note"\n/);
    expect(overview.content).toContain('valet:');
    expect(overview.content).toContain('# Valet');
    expect(overview.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(overview.valetState).toEqual({ pinned: false, relevance: 1, version: 1, sourceSessionId: '' });

    const pref = manifest.files['preferences/coding-style.md'];
    expect(pref.valetState?.pinned).toBe(true);
  });

  it('generates an index.md per directory level with basename display + full-path links', async () => {
    const manifest = await exportMemoryFiles(h.db, scope);

    expect(Object.keys(manifest.files).sort()).toEqual([
      'index.md',
      'notes/index.md',
      'notes/secret-plan.md',
      'preferences/coding-style.md',
      'preferences/index.md',
      'projects/index.md',
      'projects/valet/index.md',
      'projects/valet/overview.md',
    ]);

    const root = manifest.files['index.md'].content;
    expect(root).toContain('okf_version: "0.1"');
    expect(root).toContain('* [notes](/notes/)');
    expect(root).toContain('* [projects](/projects/)');

    const projects = manifest.files['projects/index.md'].content;
    expect(projects).toContain('* [valet](/projects/valet/)');

    const valetDir = manifest.files['projects/valet/index.md'].content;
    expect(valetDir).toContain('* [Valet](/projects/valet/overview.md) - Valet overview');

    // Index entries carry hashes but never valetState (they are generated).
    expect(manifest.files['index.md'].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files['index.md'].valetState).toBeUndefined();
  });

  it('scopes the export to the user', async () => {
    await writeMemoryFile(h.rawDb, { userId: OTHER }, 'notes/other.md', '# Other', {}, '');
    const manifest = await exportMemoryFiles(h.db, scope);
    expect(manifest.files['notes/other.md']).toBeUndefined();
  });

  describe('shareable export', () => {
    it('filters to shareable files, prunes empty dirs, omits valet/valetState, flags leaks', async () => {
      const manifest = await exportMemoryFiles(h.db, scope, 'shareable');

      expect(manifest.include).toBe('shareable');
      // Only the shareable concept + the directory chain that contains it.
      expect(Object.keys(manifest.files).sort()).toEqual([
        'index.md',
        'projects/index.md',
        'projects/valet/index.md',
        'projects/valet/overview.md',
      ]);

      const serialized = JSON.stringify(manifest);
      // No private title/description bytes anywhere (index included).
      expect(serialized).not.toContain('Secret Plan');
      expect(serialized).not.toContain('Style');
      // No valet: block, no valetState sidecar.
      expect(serialized).not.toContain('valet:');
      expect(serialized).not.toContain('valetState');
      expect(manifest.files['projects/valet/overview.md'].content).not.toContain('\nvalet:');

      // The shareable file links a private path — flagged (residual body-prose leak).
      expect(manifest.leakFlags).toEqual(['projects/valet/overview.md']);
    });

    it('an empty shareable set yields an empty manifest', async () => {
      const manifest = await exportMemoryFiles(h.db, { userId: OTHER }, 'shareable');
      expect(manifest.files).toEqual({});
      expect(manifest.leakFlags).toEqual([]);
    });
  });
});

describe('export → import → export determinism (the identity law)', () => {
  it('trusted import into a second DB reproduces an identical manifest, hashes included', async () => {
    const h1 = makeHarness(USER);
    await writeMemoryFile(h1.rawDb, scope, 'projects/valet/overview.md',
      '# Valet\n\nSee [style](/preferences/coding-style.md).',
      { description: 'Overview', tags: ['valet', 'agent'], sensitivity: 'shareable', origin: 'user-stated' }, '');
    await writeMemoryFile(h1.rawDb, scope, 'preferences/coding-style.md', '# Coding Style\n\nStrict mode.', {}, '');
    await writeMemoryFile(h1.rawDb, scope, 'journal/2026-07-01.md', '# 2026-07-01\n\nShipped export v2.', {}, '');

    // Make the fixture realistic: write overview a second time (version → 2),
    // then inject a non-default source_session_id and boosted relevance directly.
    // This ensures the identity law is tested against a non-trivial valetState.
    await writeMemoryFile(h1.rawDb, scope, 'projects/valet/overview.md',
      '# Valet\n\nSee [style](/preferences/coding-style.md).',
      { description: 'Overview', tags: ['valet', 'agent'], sensitivity: 'shareable', origin: 'user-stated' }, 'thread-abc');
    h1.sqlite
      .prepare(`UPDATE orchestrator_memory_files SET relevance = 1.5 WHERE user_id = ? AND path = ?`)
      .run(USER, 'projects/valet/overview.md');

    const export1 = await exportMemoryFiles(h1.db, scope);

    const h2 = makeHarness(USER);
    const result = await importMemoryFiles(h2.rawDb, scope, toContentMap(export1.files), true);
    expect(result.imported).toBe(3); // index files skipped, concepts imported
    expect(result.okfVersion).toBe('0.1');

    const export2 = await exportMemoryFiles(h2.db, scope);

    // Identity law: key sets and all rendered content + hashes must match exactly.
    // This is the sync primitive — content divergence would be a production bug.
    expect(Object.keys(export2.files).sort()).toEqual(Object.keys(export1.files).sort());
    for (const path of Object.keys(export1.files)) {
      expect(export2.files[path].content).toBe(export1.files[path].content);
      expect(export2.files[path].hash).toBe(export1.files[path].hash);
    }

    // valetState is an instance-local sidecar excluded from sync identity by design.
    // Import resets version → 1 and clears source_session_id; relevance starts at
    // the default 1.0.  The touched file must diverge from the realistic source values.
    const overviewVs1 = export1.files['projects/valet/overview.md'].valetState;
    const overviewVs2 = export2.files['projects/valet/overview.md'].valetState;
    expect(overviewVs1).toMatchObject({ version: 2, sourceSessionId: 'thread-abc', relevance: 1.5 });
    expect(overviewVs2).toMatchObject({ version: 1, sourceSessionId: '', relevance: 1.0 });
  });

  it('re-importing the same manifest is a complete no-op (imported: 0)', async () => {
    const h1 = makeHarness(USER);
    await writeMemoryFile(h1.rawDb, scope, 'notes/a.md', '# A\n\nAlpha.', { tags: ['x'] }, '');
    await writeMemoryFile(h1.rawDb, scope, 'notes/b.md', '# B\n\nBeta.', {}, '');
    const manifest = await exportMemoryFiles(h1.db, scope);

    const versionBefore = getRow(h1, USER, 'notes/a.md')?.version;
    const updatedBefore = getRow(h1, USER, 'notes/a.md')?.updated_at;

    const result = await importMemoryFiles(h1.rawDb, scope, toContentMap(manifest.files), true);
    expect(result.imported).toBe(0);
    expect(result.skipped.map((s) => s.reason)).toEqual(['unchanged', 'unchanged']);

    // No-op means untouched rows: no version bump, no updated_at churn.
    expect(getRow(h1, USER, 'notes/a.md')?.version).toBe(versionBefore);
    expect(getRow(h1, USER, 'notes/a.md')?.updated_at).toBe(updatedBefore);
  });

  it('trusted import preserves the incoming timestamp as updated_at', async () => {
    const h = makeHarness(USER);
    const doc = '---\ntype: "note"\ntitle: "T"\ntimestamp: "2026-01-02T03:04:05Z"\nvalet:\n  sensitivity: "private"\n---\nBody.\n';
    await importMemoryFiles(h.rawDb, scope, { 'notes/t.md': doc }, true);
    expect(getRow(h, USER, 'notes/t.md')?.updated_at).toBe('2026-01-02 03:04:05');
  });

  it('missing timestamp ⇒ import-time now', async () => {
    const h = makeHarness(USER);
    const before = fromIso(new Date().toISOString());
    await importMemoryFiles(h.rawDb, scope, { 'notes/no-ts.md': '# NoTs\n\nBody.' }, true);
    const row = getRow(h, USER, 'notes/no-ts.md');
    expect(row?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row!.updated_at >= before).toBe(true);
  });
});

describe('import trust boundaries', () => {
  const foreignDoc = [
    '---',
    'type: "insight"',
    'title: "Foreign Note"',
    'timestamp: "2026-02-03T04:05:06Z"',
    'valet:',
    '  sensitivity: "shareable"',
    '  origin: "user-stated"',
    '  source_session_id: "thread-123"',
    '  bogus: "x"',
    '---',
    'Foreign body.',
    '',
  ].join('\n');

  it('foreign import resets sensitivity, forces origin, clears source_session_id, drops unknown valet keys', async () => {
    const h = makeHarness(USER);
    const result = await importMemoryFiles(h.rawDb, scope, { 'notes/foreign.md': foreignDoc }, false);

    expect(result.imported).toBe(1);
    expect(result.droppedValetKeys.sort()).toEqual(['bogus', 'source_session_id']);

    const row = getRow(h, USER, 'notes/foreign.md');
    expect(row?.sensitivity).toBe('private');
    expect(row?.origin).toBe('imported');
    expect(row?.source_session_id).toBe('');
    expect(row?.type).toBe('insight');           // OKF content keys honored
    expect(row?.title).toBe('Foreign Note');     // title honored on imports
    expect(row?.updated_at).toBe('2026-02-03 04:05:06'); // timestamp honored
  });

  it('trusted import honors valet keys', async () => {
    const h = makeHarness(USER);
    await importMemoryFiles(h.rawDb, scope, { 'notes/trusted.md': foreignDoc }, true);
    const row = getRow(h, USER, 'notes/trusted.md');
    expect(row?.sensitivity).toBe('shareable');
    expect(row?.origin).toBe('user-stated');
    expect(row?.source_session_id).toBe(''); // never accepted from any document
  });

  it('legacy array-form input gets trusted semantics only with the explicit flag', async () => {
    const hForeign = makeHarness(USER);
    await importMemoryFiles(hForeign.rawDb, scope, [{ path: 'notes/legacy.md', content: foreignDoc }], false);
    expect(getRow(hForeign, USER, 'notes/legacy.md')?.origin).toBe('imported');

    const hTrusted = makeHarness(USER);
    await importMemoryFiles(hTrusted.rawDb, scope, [{ path: 'notes/legacy.md', content: foreignDoc }], true);
    expect(getRow(hTrusted, USER, 'notes/legacy.md')?.origin).toBe('user-stated');
  });
});

describe('import path map & remaps', () => {
  it('percent-decodes and normalizes paths, rewriting bundle-relative links through the map', async () => {
    const h = makeHarness(USER);
    const result = await importMemoryFiles(h.rawDb, scope, {
      'Projects/My%20Notes.md': '# My Notes\n\nContent.',
      'notes/ref.md': 'see [x](/Projects/My%20Notes.md)',
    }, true);

    expect(result.imported).toBe(2);
    expect(getRow(h, USER, 'projects/my-notes.md')?.content).toBe('# My Notes\n\nContent.');
    expect(getRow(h, USER, 'notes/ref.md')?.content).toBe('see [x](/projects/my-notes.md)');
  });

  it('normalization collisions are skipped, never silent last-wins', async () => {
    const h = makeHarness(USER);
    const result = await importMemoryFiles(h.rawDb, scope, {
      'notes/A B.md': '# first',
      'notes/a-b.md': '# second',
    }, true);

    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/collision/);
    expect(getRow(h, USER, 'notes/a-b.md')?.content).toBe('# first');
  });

  it('remaps lib/ to imported-lib/ and rewrites links to follow', async () => {
    const h = makeHarness(USER);
    const result = await importMemoryFiles(h.rawDb, scope, {
      'lib/shared/util.md': '# Util\n\nHelper.',
      'notes/uses.md': 'uses [util](/lib/shared/util.md)',
    }, true);

    expect(result.renamed['lib/shared/util.md']).toBe('imported-lib/shared/util.md');
    expect(getRow(h, USER, 'imported-lib/shared/util.md')?.content).toBe('# Util\n\nHelper.');
    expect(getRow(h, USER, 'lib/shared/util.md')).toBeUndefined();
    expect(getRow(h, USER, 'notes/uses.md')?.content).toBe('uses [util](/imported-lib/shared/util.md)');
  });

  it('imports foreign log.md as log-imported.md with type log, body verbatim', async () => {
    const h = makeHarness(USER);
    const body = '## 2026-06-01\nAuthored history, not regenerable.\n';
    const result = await importMemoryFiles(h.rawDb, scope, { 'projects/log.md': body }, false);

    expect(result.renamed['projects/log.md']).toBe('projects/log-imported.md');
    const row = getRow(h, USER, 'projects/log-imported.md');
    expect(row?.type).toBe('log');
    expect(row?.content).toBe(body);
  });

  it('flattens over-deep paths and records the remap', async () => {
    const h = makeHarness(USER);
    const result = await importMemoryFiles(h.rawDb, scope, {
      'a/b/c/d/e/deep.md': '# Deep',
    }, true);

    expect(result.imported).toBe(1);
    expect(result.renamed['a/b/c/d/e/deep.md']).toBe('a/b/c/d/deep.md');
    expect(getRow(h, USER, 'a/b/c/d/deep.md')?.content).toBe('# Deep');
  });

  it('records okf_version from the root index and skips all index files', async () => {
    const h = makeHarness(USER);
    const result = await importMemoryFiles(h.rawDb, scope, {
      'index.md': '---\nokf_version: "0.1"\n---\n* [notes](/notes/)',
      'notes/index.md': '* [a](/notes/a.md)',
      'notes/a.md': '# A\n\nAlpha.',
    }, true);

    expect(result.okfVersion).toBe('0.1');
    expect(result.imported).toBe(1);
    expect(getRow(h, USER, 'index.md')).toBeUndefined();
    expect(getRow(h, USER, 'notes/index.md')).toBeUndefined();
    expect(getRow(h, USER, 'notes/a.md')).toBeDefined();
    // Non-root index files are skipped silently — not listed in skipped.
    expect(result.skipped).toEqual([]);
  });
});

describe('import mechanics (size, cap, chunking)', () => {
  it('skips empty-content files and reports them', async () => {
    const h = makeHarness(USER);
    const result = await importMemoryFiles(h.rawDb, scope, {
      'notes/keep.md': '# Keep me',
      'notes/empty.md': '',
    }, true);

    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([{ path: 'notes/empty.md', reason: 'empty content' }]);
  });

  it('round-trips a >50k file losslessly', async () => {
    const h = makeHarness(USER);
    const content = '# Big\n\n' + 'x'.repeat(60001);
    const result = await importMemoryFiles(h.rawDb, scope, { 'big/note.md': content }, true);
    expect(result.imported).toBe(1);
    expect(getRow(h, USER, 'big/note.md')?.content).toBe(content);
  });

  it('imports past the file cap: prunes non-pinned excess and reports it', async () => {
    const h = makeHarness(USER);
    const files: Record<string, string> = {};
    for (let i = 0; i < 550; i++) files[`notes/n-${i}.md`] = `# note ${i}`;
    for (let i = 0; i < 10; i++) files[`preferences/p-${i}.md`] = `# pref ${i}`;

    const result = await importMemoryFiles(h.rawDb, scope, files, true);
    expect(result.imported).toBe(560);
    expect(result.pruned).toBe(50);

    const count = (pinned: 0 | 1) =>
      (h.sqlite
        .prepare('SELECT COUNT(*) AS c FROM orchestrator_memory_files WHERE user_id = ? AND pinned = ?')
        .get(USER, pinned) as { c: number }).c;
    expect(count(0)).toBe(500);
    expect(count(1)).toBe(10);
  });

  it('merges on import: differing same-path files are overwritten with version bump', async () => {
    const h = makeHarness(USER);
    await writeMemoryFile(h.rawDb, scope, 'notes/n.md', '# N\n\nOld.', {}, '');
    const before = getRow(h, USER, 'notes/n.md');

    const result = await importMemoryFiles(h.rawDb, scope, { 'notes/n.md': '# N\n\nNew.' }, true);
    expect(result.imported).toBe(1);

    const after = getRow(h, USER, 'notes/n.md');
    expect(after?.content).toBe('# N\n\nNew.');
    expect(after?.version).toBe((before?.version ?? 0) + 1);
  });
});
