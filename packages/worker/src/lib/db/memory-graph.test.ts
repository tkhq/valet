import { describe, it, expect, beforeEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb } from '../../test-utils/db.js';
import { makeD1Adapter } from '../../test-utils/d1.js';
import { writeMemoryFile } from './memory-files.js';
import { _resetBackfillCacheForTests } from './memory-link-backfill.js';
import { buildMemoryGraph, queryLinks, MAX_GRAPH_NODES, MAX_LINK_NODES } from './memory-graph.js';
import type { MemoryScope } from './memory-derived-stores.js';

const USER_ID = 'user-graph-test';
const scope: MemoryScope = { userId: USER_ID };

describe('memory-graph', () => {
  let rawDb: D1Database;
  let sqlite: DatabaseType;

  beforeEach(() => {
    _resetBackfillCacheForTests();
    ({ sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);
    sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(USER_ID, `${USER_ID}@test.com`);
  });

  describe('buildMemoryGraph', () => {
    it('builds concept nodes and link edges from bodies', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'A.\n\nSee [B](/notes/b.md).\n', {}, '');
      await writeMemoryFile(rawDb, scope, 'notes/b.md', 'B.\n', {}, '');

      const graph = await buildMemoryGraph(rawDb, scope, {});

      const a = graph.nodes.find((n) => n.id === 'notes/a.md');
      const b = graph.nodes.find((n) => n.id === 'notes/b.md');
      expect(a?.kind).toBe('concept');
      expect(b?.kind).toBe('concept');
      const edge = graph.edges.find((e) => e.from === 'notes/a.md' && e.to === 'notes/b.md');
      expect(edge).toBeDefined();
      expect(edge?.kind).toBe('link');
    });

    it('renders session siblings as a star hub, never a pairwise clique', async () => {
      const sid = 'thread-123';
      await writeMemoryFile(rawDb, scope, 'notes/s1.md', 'One.\n', {}, sid);
      await writeMemoryFile(rawDb, scope, 'notes/s2.md', 'Two.\n', {}, sid);
      await writeMemoryFile(rawDb, scope, 'notes/s3.md', 'Three.\n', {}, sid);

      const graph = await buildMemoryGraph(rawDb, scope, {});

      const hub = graph.nodes.find((n) => n.kind === 'session');
      expect(hub).toBeDefined();

      const hubEdges = graph.edges.filter((e) => e.kind === 'session' && (e.from === hub!.id || e.to === hub!.id));
      // Star: exactly k edges (one per spoke), never k*(k-1)/2 pairwise.
      expect(hubEdges).toHaveLength(3);

      // No direct file-to-file edges among the siblings (that would be the clique).
      const directSiblingEdge = graph.edges.find(
        (e) =>
          ['notes/s1.md', 'notes/s2.md', 'notes/s3.md'].includes(e.from) &&
          ['notes/s1.md', 'notes/s2.md', 'notes/s3.md'].includes(e.to),
      );
      expect(directSiblingEdge).toBeUndefined();
    });

    it('empty source_session_id produces no session nodes or edges', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/x.md', 'X.\n', {}, '');
      await writeMemoryFile(rawDb, scope, 'notes/y.md', 'Y.\n', {}, '');

      const graph = await buildMemoryGraph(rawDb, scope, {});

      expect(graph.nodes.find((n) => n.kind === 'session')).toBeUndefined();
      expect(graph.edges.find((e) => e.kind === 'session')).toBeUndefined();
    });

    it('creates a phantom node for a dangling link target', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'See [ghost](/notes/ghost.md).\n', {}, '');

      const graph = await buildMemoryGraph(rawDb, scope, {});

      const phantom = graph.nodes.find((n) => n.id === 'notes/ghost.md');
      expect(phantom?.kind).toBe('phantom');
      const edge = graph.edges.find((e) => e.from === 'notes/a.md' && e.to === 'notes/ghost.md');
      expect(edge).toBeDefined();
    });

    it('clusters concepts sharing a normalized resource around a resource node', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/r1.md', 'R1.\n', { resource: 'https://example.com/thing' }, '');
      await writeMemoryFile(rawDb, scope, 'notes/r2.md', 'R2.\n', { resource: 'https://example.com/thing/' }, '');

      const graph = await buildMemoryGraph(rawDb, scope, {});

      const resourceNodes = graph.nodes.filter((n) => n.kind === 'resource');
      expect(resourceNodes).toHaveLength(1);
      const resNode = resourceNodes[0];
      const edges = graph.edges.filter((e) => e.kind === 'resource' && e.to === resNode.id);
      expect(edges.map((e) => e.from).sort()).toEqual(['notes/r1.md', 'notes/r2.md']);
    });

    it('produces no resource nodes when no file has a resource', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'A.\n', {}, '');
      const graph = await buildMemoryGraph(rawDb, scope, {});
      expect(graph.nodes.find((n) => n.kind === 'resource')).toBeUndefined();
    });

    it('omits tag and containment classes unless opted in', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'A.\n', { tags: ['work'] }, '');

      const defaultGraph = await buildMemoryGraph(rawDb, scope, {});
      expect(defaultGraph.nodes.find((n) => n.kind === 'tag')).toBeUndefined();
      expect(defaultGraph.edges.find((e) => e.kind === 'containment')).toBeUndefined();

      const tagsGraph = await buildMemoryGraph(rawDb, scope, { tags: true });
      expect(tagsGraph.nodes.find((n) => n.kind === 'tag')).toBeDefined();

      const containmentGraph = await buildMemoryGraph(rawDb, scope, { containment: true });
      expect(containmentGraph.edges.find((e) => e.kind === 'containment')).toBeDefined();
    });

    it('excludes expired files from graph nodes', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/live.md', 'Live.\n', {}, '');
      await writeMemoryFile(rawDb, scope, 'notes/dead.md', 'Dead.\n', { expires: '2000-01-01 00:00:00' }, '');

      const graph = await buildMemoryGraph(rawDb, scope, {});
      expect(graph.nodes.find((n) => n.id === 'notes/live.md')).toBeDefined();
      expect(graph.nodes.find((n) => n.id === 'notes/dead.md')).toBeUndefined();
    });

    it('a link to an expired file renders neither a node nor a phantom', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'See [dead](/notes/dead.md).\n', {}, '');
      await writeMemoryFile(rawDb, scope, 'notes/dead.md', 'Dead. See [a](/notes/a.md).\n', { expires: '2000-01-01 00:00:00' }, '');

      const graph = await buildMemoryGraph(rawDb, scope, {});
      // Not a concept node, not a phantom (it exists but is expired — a phantom
      // is a TODO-stub for a file that was never created).
      expect(graph.nodes.find((n) => n.id === 'notes/dead.md')).toBeUndefined();
      // No dangling edges touching the expired path in either direction.
      expect(graph.edges.find((e) => e.from === 'notes/dead.md' || e.to === 'notes/dead.md')).toBeUndefined();
    });

    it('caps nodes at MAX_GRAPH_NODES', async () => {
      for (let i = 0; i < MAX_GRAPH_NODES + 20; i++) {
        await writeMemoryFile(rawDb, scope, `notes/n${i}.md`, `N${i}.\n`, {}, '');
      }
      const graph = await buildMemoryGraph(rawDb, scope, {});
      expect(graph.nodes.length).toBeLessThanOrEqual(MAX_GRAPH_NODES);
    });
  });

  describe('queryLinks', () => {
    it('returns depth-1 out neighbors with context', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'Intro. See [B](/notes/b.md) for more.\n', {}, '');
      await writeMemoryFile(rawDb, scope, 'notes/b.md', 'B body.\n', { description: 'about b' }, '');

      const result = await queryLinks(rawDb, scope, 'notes/a.md', 'out', 1, false);

      expect(result.neighbors).toHaveLength(1);
      const [ring1] = result.neighbors;
      const b = ring1.find((n) => n.path === 'notes/b.md');
      expect(b).toBeDefined();
      expect(b?.relation).toBe('out');
      expect(b?.phantom).toBe(false);
      expect(b?.description).toBe('about b');
      expect(typeof b?.context).toBe('string');
      expect(b?.context?.length).toBeGreaterThan(0);
    });

    it('flags a phantom target', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'See [ghost](/notes/ghost.md).\n', {}, '');
      const result = await queryLinks(rawDb, scope, 'notes/a.md', 'out', 1, false);
      const [ring1] = result.neighbors;
      const ghost = ring1.find((n) => n.path === 'notes/ghost.md');
      expect(ghost?.phantom).toBe(true);
    });

    it('includes session siblings at depth 1 with relation session', async () => {
      const sid = 'thread-abc';
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'A.\n', {}, sid);
      await writeMemoryFile(rawDb, scope, 'notes/sibling.md', 'Sibling.\n', {}, sid);

      const result = await queryLinks(rawDb, scope, 'notes/a.md', 'both', 1, false);
      const [ring1] = result.neighbors;
      const sib = ring1.find((n) => n.path === 'notes/sibling.md');
      expect(sib?.relation).toBe('session');
    });

    it('depth-2 excludes journal-entry nodes from further traversal unless includeJournal', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'See [J](/journal/2026-01-01.md).\n', {}, '');
      await writeMemoryFile(
        rawDb,
        scope,
        'journal/2026-01-01.md',
        'Journal entry. See [C](/notes/c.md).\n',
        { type: 'journal-entry' },
        '',
      );
      await writeMemoryFile(rawDb, scope, 'notes/c.md', 'C.\n', {}, '');

      const withoutJournal = await queryLinks(rawDb, scope, 'notes/a.md', 'out', 2, false);
      const [, ring2] = withoutJournal.neighbors;
      expect(ring2.find((n) => n.path === 'notes/c.md')).toBeUndefined();

      const withJournal = await queryLinks(rawDb, scope, 'notes/a.md', 'out', 2, true);
      const [, ring2WithJournal] = withJournal.neighbors;
      expect(ring2WithJournal.find((n) => n.path === 'notes/c.md')).toBeDefined();
    });

    it('context is only populated on depth-1 entries', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'See [B](/notes/b.md) here.\n', {}, '');
      await writeMemoryFile(rawDb, scope, 'notes/b.md', 'See [C](/notes/c.md) there.\n', {}, '');
      await writeMemoryFile(rawDb, scope, 'notes/c.md', 'C.\n', {}, '');

      const result = await queryLinks(rawDb, scope, 'notes/a.md', 'out', 2, false);
      const [, ring2] = result.neighbors;
      const c = ring2.find((n) => n.path === 'notes/c.md');
      expect(c?.context).toBeUndefined();
    });

    it('truncates at MAX_LINK_NODES and sets truncated: true', async () => {
      let body = '';
      for (let i = 0; i < MAX_LINK_NODES + 20; i++) {
        body += `See [n${i}](/notes/n${i}.md).\n`;
        await writeMemoryFile(rawDb, scope, `notes/n${i}.md`, `N${i}.\n`, {}, '');
      }
      await writeMemoryFile(rawDb, scope, 'notes/hub.md', body, {}, '');

      const result = await queryLinks(rawDb, scope, 'notes/hub.md', 'out', 1, false);
      expect(result.truncated).toBe(true);
      const total = result.neighbors.reduce((sum, ring) => sum + ring.length, 0);
      expect(total).toBeLessThanOrEqual(MAX_LINK_NODES);
    });

    it('excludes expired files from traversal (neither neighbor nor phantom)', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'See [dead](/notes/dead.md).\n', {}, '');
      await writeMemoryFile(rawDb, scope, 'notes/dead.md', 'Dead.\n', { expires: '2000-01-01 00:00:00' }, '');

      const result = await queryLinks(rawDb, scope, 'notes/a.md', 'out', 1, false);
      const [ring1] = result.neighbors;
      expect(ring1.find((n) => n.path === 'notes/dead.md')).toBeUndefined();
    });

    it('rejects direction "in" correctly (inbound neighbors)', async () => {
      await writeMemoryFile(rawDb, scope, 'notes/a.md', 'See [B](/notes/b.md).\n', {}, '');
      await writeMemoryFile(rawDb, scope, 'notes/b.md', 'B.\n', {}, '');

      const result = await queryLinks(rawDb, scope, 'notes/b.md', 'in', 1, false);
      const [ring1] = result.neighbors;
      const a = ring1.find((n) => n.path === 'notes/a.md');
      expect(a?.relation).toBe('in');
    });
  });
});
