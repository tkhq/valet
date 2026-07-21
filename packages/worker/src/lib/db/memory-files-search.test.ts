import { describe, it, expect, beforeEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb } from '../../test-utils/db.js';
import { writeMemoryFile, searchMemoryFiles } from './memory-files.js';

// Thin adapter: wraps better-sqlite3 sync API to match D1Database async interface.
// Internal closures use `any` only where the better-sqlite3 / D1 types don't align;
// the public surface is typed as D1Database to satisfy all helper signatures.
function makeD1Adapter(sqlite: DatabaseType): D1Database {
  const bound = (sql: string, args: unknown[]) => ({
    sql, args,
    async run() { return sqlite.prepare(sql).run(...args); },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async first() { return (sqlite.prepare(sql).get(...args) as any) ?? null; },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter: any = {
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => bound(sql, args) };
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      return sqlite.transaction(() => stmts.map((s) => sqlite.prepare(s.sql).run(...s.args)))();
    },
  };
  return adapter as unknown as D1Database;
}

const USER_ID = 'user-test-mem-search';
const scope = { userId: USER_ID };

describe('searchMemoryFiles', () => {
  let rawDb: D1Database;
  let sqlite: DatabaseType;

  beforeEach(async () => {
    ({ sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);

    // Seed user row to satisfy FK on orchestrator_memory_files.user_id
    sqlite.prepare(
      "INSERT INTO users (id, email, role) VALUES (?, ?, 'member')"
    ).run(USER_ID, `${USER_ID}@test.com`);

    await writeMemoryFile(rawDb, scope, 'projects/valet/overview.md',
      '# Valet Project\n\nValet is a hosted coding agent platform built on Cloudflare Workers.', {}, '');
    await writeMemoryFile(rawDb, scope, 'preferences/coding-style.md',
      '# Coding Style\n\nAlways use TypeScript strict mode. Prefer functional patterns.', {}, '');
    await writeMemoryFile(rawDb, scope, 'journal/2026-03-08.md',
      '# 2026-03-08\n\n## 10:00 — Deployed auth fix\n\n- PR #42 merged.\n- Fixed Cloudflare D1 migration.', {}, '');
  });

  it('finds files by content keyword', async () => {
    const { results } = await searchMemoryFiles(rawDb, scope, 'cloudflare');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.path.includes('valet'))).toBe(true);
  });

  it('gives path boost to files whose path matches the query', async () => {
    const { results } = await searchMemoryFiles(rawDb, scope, 'valet');
    const valetResult = results.find(r => r.path === 'projects/valet/overview.md');
    expect(valetResult).toBeDefined();
    expect(valetResult!.relevance).toBeGreaterThan(0.5);
  });

  it('returns match-aware snippets containing the search term', async () => {
    const { results } = await searchMemoryFiles(rawDb, scope, 'auth');
    const journal = results.find(r => r.path.includes('journal'));
    expect(journal?.snippet).toContain('auth');
  });

  it('scopes results to pathPrefix when provided', async () => {
    const { results } = await searchMemoryFiles(rawDb, scope, 'typescript', { pathPrefix: 'preferences/' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.path.startsWith('preferences/'))).toBe(true);
  });

  it('falls back to OR when AND returns no results', async () => {
    const { results } = await searchMemoryFiles(rawDb, scope, 'valet typescript');
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns empty results for nonsense query', async () => {
    const { results, suppressedExpired } = await searchMemoryFiles(rawDb, scope, 'xyzzy123nonsense');
    expect(results).toEqual([]);
    expect(suppressedExpired).toBe(0);
  });

  it('result rows carry the new metadata fields', async () => {
    const { results } = await searchMemoryFiles(rawDb, scope, 'cloudflare');
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(typeof r.title).toBe('string');
    expect(typeof r.type).toBe('string');
    expect(typeof r.description).toBe('string');
    expect(Array.isArray(r.tags)).toBe(true);
    expect(typeof r.resource).toBe('string');
    expect(typeof r.inboundLinks).toBe('number');
    expect(typeof r.expired).toBe('boolean');
    expect(r.expired).toBe(false);
  });

  it('description matches boost rank above content-only matches', async () => {
    // Fixtures are carefully shaped so the only FTS signal difference is
    // description (weight 8) vs content (weight 1):
    //
    // alpha-memo: "rocket" is ONLY in the second paragraph of the body.
    //   - title    = "Alpha Memo"         (no rocket → weight 10 = 0)
    //   - FTS desc = first paragraph text  (no rocket → weight 8  = 0)
    //   - FTS content has "rocket"         (weight 1)
    //   - path has no "rocket"             (no pathBoost)
    //
    // beta-memo: "rocket" is ONLY in the authored description.
    //   - title    = "Beta Memo"           (no rocket → weight 10 = 0)
    //   - FTS desc = authored description  (rocket    → weight 8)
    //   - FTS content = body               (no rocket → weight 1  = 0)
    //   - path has no "rocket"             (no pathBoost)
    //
    // With weights bm25(path=5, title=10, description=8, tags=6, content=1),
    // beta-memo must rank above alpha-memo.
    await writeMemoryFile(rawDb, scope, 'notes/alpha-memo.md',
      '# Alpha Memo\n\nIntroductory paragraph about general topics.\n\nThe rocket engine section is here.',
      {}, '');
    await writeMemoryFile(rawDb, scope, 'notes/beta-memo.md',
      '# Beta Memo\n\nSome general notes about planning and scheduling.',
      { description: 'rocket propulsion research' }, '');

    const { results } = await searchMemoryFiles(rawDb, scope, 'rocket');
    const descIdx = results.findIndex(r => r.path === 'notes/beta-memo.md');
    const contentIdx = results.findIndex(r => r.path === 'notes/alpha-memo.md');
    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(contentIdx).toBeGreaterThanOrEqual(0);
    expect(descIdx).toBeLessThan(contentIdx);
  });

  it('resource filter matches exact resource', async () => {
    await writeMemoryFile(rawDb, scope, 'projects/valet-repo.md',
      '# Valet Repo', { resource: 'https://github.com/tkhq/valet' }, '');
    await writeMemoryFile(rawDb, scope, 'projects/other-repo.md',
      '# Other Repo', { resource: 'https://github.com/tkhq/other' }, '');

    const { results } = await searchMemoryFiles(rawDb, scope, 'repo', { resource: 'https://github.com/tkhq/valet' });
    expect(results.some(r => r.path === 'projects/valet-repo.md')).toBe(true);
    expect(results.every(r => r.path !== 'projects/other-repo.md')).toBe(true);
  });

  it('resource filter is segment-aware: matches prefix + sub-paths but not same-prefix sibling', async () => {
    await writeMemoryFile(rawDb, scope, 'projects/valet-issues.md',
      '# Valet Issues', { resource: 'https://github.com/tkhq/valet/issues' }, '');
    await writeMemoryFile(rawDb, scope, 'projects/valet-infra.md',
      '# Valet Infra', { resource: 'https://github.com/tkhq/valet-infra' }, '');

    const { results } = await searchMemoryFiles(rawDb, scope, 'valet', { resource: 'https://github.com/tkhq/valet' });
    // Should match valet-issues (sub-path of valet)
    expect(results.some(r => r.path === 'projects/valet-issues.md')).toBe(true);
    // Should NOT match valet-infra (sibling, different repo name)
    expect(results.every(r => r.path !== 'projects/valet-infra.md')).toBe(true);
  });

  it('excludes expired files by default and reports suppressedExpired count', async () => {
    // Write an expired file
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await writeMemoryFile(rawDb, scope, 'ephemeral/expired-note.md',
      '# Expired cloudflare note\n\nThis should not appear.', { expires: pastDate }, '');

    const { results, suppressedExpired } = await searchMemoryFiles(rawDb, scope, 'cloudflare');
    expect(results.every(r => !r.expired)).toBe(true);
    expect(suppressedExpired).toBeGreaterThanOrEqual(1);
  });

  it('suppressedExpired count respects scope filters (pathPrefix)', async () => {
    // Expired file is at notes/ — only visible to an un-scoped search.
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await writeMemoryFile(rawDb, scope, 'notes/scoped-expired.md',
      '# Scoped cloudflare note\n\nExpired content here.', { expires: pastDate }, '');

    // Scoped to projects/ — the expired file at notes/ must not be counted.
    const { suppressedExpired: scopedCount } = await searchMemoryFiles(
      rawDb, scope, 'cloudflare', { pathPrefix: 'projects/' }
    );
    expect(scopedCount).toBe(0);

    // Unscoped — the expired file IS within scope and must be counted.
    const { suppressedExpired: unscopedCount } = await searchMemoryFiles(rawDb, scope, 'cloudflare');
    expect(unscopedCount).toBeGreaterThanOrEqual(1);
  });

  it('includeExpired returns expired files flagged and ranked last', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await writeMemoryFile(rawDb, scope, 'ephemeral/expired-cloud.md',
      '# Expired cloudflare note', { expires: pastDate }, '');

    const { results } = await searchMemoryFiles(rawDb, scope, 'cloudflare', { includeExpired: true });
    const expiredResults = results.filter(r => r.expired);
    const activeResults = results.filter(r => !r.expired);
    expect(expiredResults.length).toBeGreaterThanOrEqual(1);
    // Expired results should rank after active results
    if (activeResults.length > 0 && expiredResults.length > 0) {
      const minActiveRelevance = Math.min(...activeResults.map(r => r.relevance));
      const maxExpiredRelevance = Math.max(...expiredResults.map(r => r.relevance));
      expect(maxExpiredRelevance).toBeLessThan(minActiveRelevance);
    }
  });

  it('inboundLinks counts memory_links rows correctly', async () => {
    // Insert a memory_links row manually pointing to projects/valet/overview.md
    sqlite.prepare(
      "INSERT INTO memory_links (user_id, from_path, to_path, context) VALUES (?, ?, ?, ?)"
    ).run(USER_ID, 'other/file.md', 'projects/valet/overview.md', 'linked from test');

    const { results } = await searchMemoryFiles(rawDb, scope, 'valet');
    const valetResult = results.find(r => r.path === 'projects/valet/overview.md');
    expect(valetResult).toBeDefined();
    expect(valetResult!.inboundLinks).toBe(1);
  });
});
