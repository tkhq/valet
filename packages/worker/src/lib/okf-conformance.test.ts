/**
 * OKF v0.1 conformance smoke test.
 *
 * Seeds a realistic bundle through the real write path (files across every
 * directory, one file carrying extras via a trusted import, one expired file,
 * cross-links between files), exports with `include: 'all'`, and asserts the
 * exported manifest satisfies OKF v0.1's conformance rules programmatically:
 *
 *   1. Every non-reserved `.md` entry parses with frontmatter and a non-empty `type`.
 *   2. Every `index.md` entry has NO frontmatter, except the root index, which
 *      has exactly `okf_version: "0.1"`.
 *   3. Every index entry line matches the OKF list-item shape.
 *
 * This is a smoke test over the shipped export path, not a re-test of the
 * unit-level suites (okf.test.ts, memory-files-okf.test.ts, memory-files-export.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb } from '../test-utils/db.js';
import { makeD1Adapter } from '../test-utils/d1.js';
import { writeMemoryFile, exportMemoryFiles, importMemoryFiles } from './db/memory-files.js';
import { parseConcept, OKF_VERSION } from './okf.js';

interface Harness {
  db: BetterSQLite3Database;
  sqlite: DatabaseType;
  rawDb: D1Database;
}

const USER = 'user-conformance';
const scope = { userId: USER };

/** Reserved/generated names that are never OKF concepts. */
const isIndexEntry = (path: string) => path === 'index.md' || path.endsWith('/index.md');

/** OKF v0.1 index list-item shape: bare-subdir form or file form with optional description. */
const INDEX_LINE_RE = /^\* \[[^\]]*\]\(\/[^)]+\)( - .+)?$/;

function makeHarness(): Harness {
  const { db, sqlite } = createTestDb();
  sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(USER, `${USER}@test.com`);
  return { db, sqlite, rawDb: makeD1Adapter(sqlite) };
}

describe('OKF v0.1 conformance smoke test', () => {
  let h: Harness;

  beforeEach(async () => {
    h = makeHarness();

    // Files across every directory the export path generates indexes for.
    await writeMemoryFile(h.rawDb, scope, 'preferences/coding-style.md',
      '# Coding Style\n\nStrict TypeScript everywhere.',
      { description: 'How I like code written', tags: ['style'] }, '');

    await writeMemoryFile(h.rawDb, scope, 'projects/valet/overview.md',
      '# Valet\n\nA hosted coding agent. See [style](/preferences/coding-style.md) and [conner](/people/conner.md).',
      { description: 'Valet project overview', tags: ['valet'], sensitivity: 'shareable', origin: 'user-stated' }, '');

    await writeMemoryFile(h.rawDb, scope, 'workflows/deploy.md',
      '# Deploy Workflow\n\nRun `make deploy` from the project root.',
      { description: 'Deploy steps', tags: ['ops'] }, '');

    await writeMemoryFile(h.rawDb, scope, 'journal/2026-07-01.md',
      '# 2026-07-01\n\nShipped the OKF conformance test. See [overview](/projects/valet/overview.md).',
      {}, '');

    await writeMemoryFile(h.rawDb, scope, 'people/conner.md',
      '# Conner\n\nProject owner.',
      { description: 'Project owner', resource: 'mailto:conner@example.com' }, '');

    await writeMemoryFile(h.rawDb, scope, 'notes/misc.md', '# Misc\n\nA loose note.', {}, '');

    // Expired file — must still parse and carry a non-empty type; export/expiry
    // filtering is a retrieval-time concern (mem_search), not an export concern.
    await writeMemoryFile(h.rawDb, scope, 'notes/temp-context.md',
      '# Temp Context\n\nThis is ephemeral.',
      { expires: '2020-01-01T00:00:00Z' }, '');

    // A file carrying extras (unknown frontmatter keys), via a trusted import —
    // trusted-import is the channel that honors arbitrary OKF keys + extras.
    const importedDoc = [
      '---',
      'type: "reference"',
      'title: "External Reference"',
      'description: "Imported from elsewhere"',
      'custom_field: "kept verbatim"',
      'timestamp: "2026-06-01T00:00:00Z"',
      'valet:',
      '  sensitivity: "private"',
      '---',
      'Body from an external OKF bundle.',
      '',
    ].join('\n');
    await importMemoryFiles(h.rawDb, scope, { 'notes/imported-ref.md': importedDoc }, true);
  });

  it('produces a bundle where every concept parses, every index has the right frontmatter, and every index line matches OKF shape', async () => {
    const manifest = await exportMemoryFiles(h.db, scope, 'all');

    expect(manifest.okfVersion).toBe(OKF_VERSION);
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0);

    let conceptCount = 0;
    let indexCount = 0;

    for (const [path, entry] of Object.entries(manifest.files)) {
      const parsed = parseConcept(entry.content);

      if (isIndexEntry(path)) {
        indexCount++;
        if (path === 'index.md') {
          // Root index: frontmatter present, with exactly `okf_version: "0.1"`.
          // `okf_version` isn't an OKF concept key, so parseConcept captures it
          // as an extra — assert no *known* concept keys leaked in, and that the
          // sole extra is exactly `okf_version: "0.1"`.
          expect(parsed.hadFrontmatter).toBe(true);
          expect(Object.keys(parsed.meta)).toEqual(['extras']);
          // Extras capture as-written source text, so the quoted scalar is preserved.
          expect(parsed.meta.extras).toEqual({ okf_version: '"0.1"' });
          expect(entry.content).toMatch(/^---\nokf_version: "0\.1"\n---\n/);
        } else {
          // Non-root indexes: no frontmatter at all.
          expect(parsed.hadFrontmatter).toBe(false);
        }

        // Every list line in the index body matches the OKF entry shape.
        const bodyLines = parsed.body.split('\n').filter((l) => l.trim().length > 0);
        for (const line of bodyLines) {
          expect(line).toMatch(INDEX_LINE_RE);
        }
      } else {
        // Every non-reserved concept: parses with frontmatter and a non-empty type.
        conceptCount++;
        expect(parsed.hadFrontmatter).toBe(true);
        expect(parsed.meta.type).toBeTruthy();
      }
    }

    // Sanity: we actually exercised both classes of entry.
    expect(conceptCount).toBe(8); // 7 written + 1 trusted-imported
    expect(indexCount).toBeGreaterThan(0);

    // The extras-carrying file round-trips its unknown key verbatim.
    const importedEntry = manifest.files['notes/imported-ref.md'];
    expect(importedEntry).toBeDefined();
    const importedParsed = parseConcept(importedEntry.content);
    expect(importedParsed.meta.extras).toEqual({ custom_field: '"kept verbatim"' });

    // Cross-links survive in rendered bodies (bundle-relative, OKF-shaped links).
    const overview = manifest.files['projects/valet/overview.md'];
    expect(overview.content).toContain('(/preferences/coding-style.md)');
    expect(overview.content).toContain('(/people/conner.md)');

    // The expired file is still a conformant concept in the export — expiry is
    // a retrieval-time filter, not an export-time exclusion.
    const expiredEntry = manifest.files['notes/temp-context.md'];
    expect(expiredEntry).toBeDefined();
    const expiredParsed = parseConcept(expiredEntry.content);
    expect(expiredParsed.hadFrontmatter).toBe(true);
    expect(expiredParsed.meta.type).toBeTruthy();
  });
});
