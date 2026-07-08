import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';

// Route-level coverage for the OKF memory HTTP envelope (Task 11). The DB
// layer (writeMemoryFile, queryLinks, buildMemoryGraph, moveMemoryFile, ...)
// already has focused unit coverage; these tests exercise only the logic the
// route itself adds: envelope assembly (document/backlinks/notices), the
// sourceSessionId hard-coded-'' guarantee, directory index assembly, and the
// graph `truncated` flag.
const {
  ensureLinksIndexedMock,
  normalizePathMock,
  listMemoryFilesMock,
  readMemoryFileMock,
  boostMemoryFileRelevanceMock,
  fileToConceptMetaMock,
  queryLinksMock,
  writeMemoryFileMock,
  moveMemoryFileMock,
  buildMemoryGraphMock,
  exportMemoryFilesMock,
  patchMemoryFileMock,
} = vi.hoisted(() => ({
  ensureLinksIndexedMock: vi.fn(),
  normalizePathMock: vi.fn((p: string) => p.replace(/\/+$/, '')),
  listMemoryFilesMock: vi.fn(),
  readMemoryFileMock: vi.fn(),
  boostMemoryFileRelevanceMock: vi.fn(),
  fileToConceptMetaMock: vi.fn(),
  queryLinksMock: vi.fn(),
  writeMemoryFileMock: vi.fn(),
  moveMemoryFileMock: vi.fn(),
  buildMemoryGraphMock: vi.fn(),
  exportMemoryFilesMock: vi.fn(),
  patchMemoryFileMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  MAX_MEMORY_FILE_SIZE: 262144,
  MAX_GRAPH_NODES: 500,
  ensureLinksIndexed: ensureLinksIndexedMock,
  normalizePath: normalizePathMock,
  listMemoryFiles: listMemoryFilesMock,
  readMemoryFile: readMemoryFileMock,
  boostMemoryFileRelevance: boostMemoryFileRelevanceMock,
  fileToConceptMeta: fileToConceptMetaMock,
  queryLinks: queryLinksMock,
  writeMemoryFile: writeMemoryFileMock,
  moveMemoryFile: moveMemoryFileMock,
  buildMemoryGraph: buildMemoryGraphMock,
  exportMemoryFiles: exportMemoryFilesMock,
  patchMemoryFile: patchMemoryFileMock,
  // Unused by the routes under test but referenced elsewhere in orchestrator.ts
  // at module scope only via the properties above — no other top-level use.
}));

import { orchestratorRouter } from './orchestrator.js';

/**
 * `Response.json()` is typed `Promise<unknown>` under @cloudflare/workers-types.
 * Narrowing here is the same bridge every other route test does inline via
 * `toEqual`/`toMatchObject`; centralized so call sites can read named fields.
 */
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function makeRawDb(titleRows: { path: string; title: string }[] = []): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: titleRows }),
      }),
    }),
  } as unknown as D1Database;
}

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', { id: 'user-1', email: 'user@example.com', role: 'member' });
    c.set('db', {} as Variables['db']);
    c.set('requestId', 'req-test');
    await next();
  });
  app.route('/', orchestratorRouter);
  return app;
}

function baseMemoryFile(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'id-1',
    userId: 'user-1',
    orgId: '',
    path: 'notes/foo.md',
    content: '# Foo\nbody text',
    title: 'Foo',
    type: 'note',
    description: '',
    tags: [],
    resource: '',
    extras: {},
    sensitivity: 'private',
    origin: 'inferred',
    sourceSessionId: '',
    expires: null,
    relevance: 0,
    pinned: false,
    version: 1,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    lastAccessedAt: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('GET /memory (file)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileToConceptMetaMock.mockImplementation((f: ReturnType<typeof baseMemoryFile>) => ({
      type: f.type,
      title: f.title,
      description: f.description,
      resource: f.resource,
      tags: f.tags,
      sensitivity: f.sensitivity,
      origin: f.origin,
      expires: f.expires,
      updatedAt: f.updatedAt,
      extras: f.extras,
    }));
    boostMemoryFileRelevanceMock.mockResolvedValue(undefined);
  });

  it('assembles document + backlinks + empty notices for a live file', async () => {
    const file = baseMemoryFile();
    readMemoryFileMock.mockResolvedValue(file);
    queryLinksMock.mockResolvedValue({
      neighbors: [[{ path: 'notes/bar.md', title: 'Bar', type: 'note', description: '', phantom: false, relation: 'in' }]],
      truncated: false,
    });

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/memory?path=notes/foo.md'),
      { DB: makeRawDb() } as Env,
    );

    expect(res.status).toBe(200);
    const body = await readJson<{ file: unknown; document: string; backlinks: unknown[]; notices: string[] }>(res);
    expect(body.file).toEqual(file);
    expect(body.document).toContain('body text');
    expect(body.document).not.toMatch(/valet:backlinks|valet:notice/);
    expect(body.backlinks).toEqual([
      { path: 'notes/bar.md', title: 'Bar', type: 'note', description: '', phantom: false, relation: 'in' },
    ]);
    expect(body.notices).toEqual([]);
    expect(queryLinksMock).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1' }, 'notes/foo.md', 'in', 1, false);
  });

  it('surfaces an expiry notice for an expired file', async () => {
    const file = baseMemoryFile({ expires: '2000-01-01 00:00:00' });
    readMemoryFileMock.mockResolvedValue(file);
    queryLinksMock.mockResolvedValue({ neighbors: [[]], truncated: false });

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/memory?path=notes/foo.md'),
      { DB: makeRawDb() } as Env,
    );

    const body = await readJson<{ notices: string[] }>(res);
    expect(body.notices).toEqual(['⚠ expired 2000-01-01 00:00:00']);
  });

  it('returns an empty envelope when the file does not exist', async () => {
    readMemoryFileMock.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/memory?path=notes/missing.md'),
      { DB: makeRawDb() } as Env,
    );

    expect(await res.json()).toEqual({ file: null, document: '', backlinks: [], notices: [], sourceThread: null });
    expect(queryLinksMock).not.toHaveBeenCalled();
  });
});

describe('GET /memory (directory)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureLinksIndexedMock.mockResolvedValue(false);
  });

  it('builds the listing + a virtual OKF index over direct children only', async () => {
    listMemoryFilesMock.mockResolvedValue([
      { path: 'notes/foo.md', size: 10, updatedAt: '2026-01-01', pinned: false, type: 'note', description: 'about foo', tags: [] },
      { path: 'notes/sub/bar.md', size: 5, updatedAt: '2026-01-01', pinned: false, type: 'note', description: '', tags: [] },
    ]);

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/memory?path=notes/'),
      { DB: makeRawDb([{ path: 'notes/foo.md', title: 'Foo' }]) } as Env,
    );

    expect(res.status).toBe(200);
    const body = await readJson<{ listing: unknown[]; index: string }>(res);
    expect(body.listing).toHaveLength(2);
    expect(ensureLinksIndexedMock).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1' });
    // Direct file rendered with title + description; subdirectory rendered as a
    // bare entry; the nested file itself must not appear as a direct entry.
    expect(body.index).toContain('[Foo](/notes/foo.md) - about foo');
    expect(body.index).toContain('[sub](/notes/sub/)');
    expect(body.index).not.toContain('bar.md');
  });
});

describe('PUT /memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always writes sourceSessionId as "" even when the body supplies one', async () => {
    const file = baseMemoryFile();
    writeMemoryFileMock.mockResolvedValue({ file, warnings: ['⚠ something'] });

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/memory', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: 'notes/foo.md',
          content: '# Foo',
          sourceSessionId: 'sneaky-thread-id',
        }),
      }),
      { DB: makeRawDb() } as Env,
    );

    expect(res.status).toBe(201);
    expect(writeMemoryFileMock).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'user-1' },
      'notes/foo.md',
      '# Foo',
      {},
      '',
    );
    expect(await res.json()).toEqual({ file, warnings: ['⚠ something'] });
  });

  it('maps metadata fields onto MemoryWriteMeta and omits unset ones', async () => {
    const file = baseMemoryFile();
    writeMemoryFileMock.mockResolvedValue({ file, warnings: [] });

    const app = buildApp();
    await app.fetch(
      new Request('http://localhost/memory', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'notes/foo.md', sensitivity: 'shareable', tags: ['a', 'b'] }),
      }),
      { DB: makeRawDb() } as Env,
    );

    expect(writeMemoryFileMock).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'user-1' },
      'notes/foo.md',
      undefined,
      { sensitivity: 'shareable', tags: ['a', 'b'] },
      '',
    );
  });

  it('rejects an invalid sensitivity enum value with a 400', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/memory', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'notes/foo.md', content: '# Foo', sensitivity: 'public' }),
      }),
      { DB: makeRawDb() } as Env,
    );
    expect(res.status).toBe(400);
    expect(writeMemoryFileMock).not.toHaveBeenCalled();
  });
});

describe('POST /memory/move', () => {
  it('wires body straight to moveMemoryFile and returns the result', async () => {
    const result = {
      from: 'notes/a.md',
      to: 'notes/b.md',
      pinnedBefore: false,
      pinnedAfter: false,
      type: 'note',
      typeDefaultForDest: 'note',
      referencersUpdated: 1,
      referencersSkipped: [],
    };
    moveMemoryFileMock.mockResolvedValue(result);

    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/memory/move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'notes/a.md', to: 'notes/b.md' }),
      }),
      { DB: makeRawDb() } as Env,
    );

    expect(res.status).toBe(200);
    expect(moveMemoryFileMock).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1' }, 'notes/a.md', 'notes/b.md');
    expect(await res.json()).toEqual(result);
  });
});

describe('GET /memory/links', () => {
  it('defaults direction to both and depth to 1', async () => {
    queryLinksMock.mockResolvedValue({ neighbors: [[]], truncated: false });
    const app = buildApp();
    await app.fetch(new Request('http://localhost/memory/links?path=notes/a.md'), { DB: makeRawDb() } as Env);
    expect(queryLinksMock).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1' }, 'notes/a.md', 'both', 1, false);
  });

  it('parses direction/depth/includeJournal query params', async () => {
    queryLinksMock.mockResolvedValue({ neighbors: [[], []], truncated: false });
    const app = buildApp();
    await app.fetch(
      new Request('http://localhost/memory/links?path=notes/a.md&direction=in&depth=2&includeJournal=true'),
      { DB: makeRawDb() } as Env,
    );
    expect(queryLinksMock).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1' }, 'notes/a.md', 'in', 2, true);
  });

  it('400s when path is missing', async () => {
    const app = buildApp();
    const res = await app.fetch(new Request('http://localhost/memory/links'), { DB: makeRawDb() } as Env);
    expect(res.status).toBe(400);
  });
});

describe('GET /memory/graph', () => {
  it('sets truncated=false when under the node cap', async () => {
    buildMemoryGraphMock.mockResolvedValue({ nodes: [{ id: 'a', kind: 'concept' }], edges: [] });
    const app = buildApp();
    const res = await app.fetch(new Request('http://localhost/memory/graph'), { DB: makeRawDb() } as Env);
    expect(await res.json()).toEqual({ nodes: [{ id: 'a', kind: 'concept' }], edges: [], truncated: false });
  });

  it('sets truncated=true when the node count hits MAX_GRAPH_NODES', async () => {
    const nodes = Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, kind: 'concept' }));
    buildMemoryGraphMock.mockResolvedValue({ nodes, edges: [] });
    const app = buildApp();
    const res = await app.fetch(new Request('http://localhost/memory/graph'), { DB: makeRawDb() } as Env);
    const body = await readJson<{ truncated: boolean }>(res);
    expect(body.truncated).toBe(true);
  });

  it('passes tags/containment opt-in flags through', async () => {
    buildMemoryGraphMock.mockResolvedValue({ nodes: [], edges: [] });
    const app = buildApp();
    await app.fetch(new Request('http://localhost/memory/graph?tags=true&containment=true'), { DB: makeRawDb() } as Env);
    expect(buildMemoryGraphMock).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1' }, { tags: true, containment: true });
  });
});

describe('GET /memory/export', () => {
  it('defaults to include=all', async () => {
    exportMemoryFilesMock.mockResolvedValue({ okfVersion: '0.1', include: 'all', files: {}, leakFlags: [] });
    const app = buildApp();
    await app.fetch(new Request('http://localhost/memory/export'), { DB: makeRawDb() } as Env);
    expect(exportMemoryFilesMock).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1' }, 'all');
  });

  it('passes include=shareable through', async () => {
    exportMemoryFilesMock.mockResolvedValue({ okfVersion: '0.1', include: 'shareable', files: {}, leakFlags: [] });
    const app = buildApp();
    const res = await app.fetch(new Request('http://localhost/memory/export?include=shareable'), { DB: makeRawDb() } as Env);
    expect(exportMemoryFilesMock).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1' }, 'shareable');
    expect((await readJson<{ include: string }>(res)).include).toBe('shareable');
  });

  it('treats any other include value as "all"', async () => {
    exportMemoryFilesMock.mockResolvedValue({ okfVersion: '0.1', include: 'all', files: {}, leakFlags: [] });
    const app = buildApp();
    await app.fetch(new Request('http://localhost/memory/export?include=bogus'), { DB: makeRawDb() } as Env);
    expect(exportMemoryFilesMock).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1' }, 'all');
  });
});
