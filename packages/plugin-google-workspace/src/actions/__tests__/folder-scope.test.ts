import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  FolderContainment,
  filterListResult,
  resolveFolderScope,
} from '../folder-scope.js';

/**
 * A Drive tree served over a fetch stub. `tree` maps a file id to its
 * parents; a missing id answers 404 the way Drive does for a file the
 * caller cannot see.
 */
function driveTree(tree: Record<string, string[] | undefined>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    const id = decodeURIComponent(String(url).split('/files/')[1].split('?')[0]);
    calls.push(id);
    const parents = tree[id];
    if (parents === undefined) {
      return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
    }
    return new Response(JSON.stringify({ parents }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fetchMock, calls };
}

describe('resolveFolderScope', () => {
  it('returns null when no scope is set, leaving access unrestricted', () => {
    expect(resolveFolderScope(null)).toBeNull();
    expect(resolveFolderScope({})).toBeNull();
    expect(resolveFolderScope({ metadata: {} })).toBeNull();
    expect(resolveFolderScope({ metadata: { driveFolderScope: null } })).toBeNull();
  });

  it('reads the allowed folder ids', () => {
    expect(
      resolveFolderScope({ metadata: { driveFolderScope: { folderIds: ['abc', 'def-1_2'] } } }),
    ).toEqual({ folderIds: ['abc', 'def-1_2'] });
  });

  it('denies everything when a scope is set with no usable id', () => {
    // Someone who set a scope and then emptied it has not asked for
    // unrestricted access. Removing the restriction is deleting the key.
    expect(resolveFolderScope({ metadata: { driveFolderScope: { folderIds: [] } } })).toEqual({
      folderIds: [],
    });
    expect(resolveFolderScope({ metadata: { driveFolderScope: {} } })).toEqual({ folderIds: [] });
  });

  it('drops ids that are not plausible Drive ids', () => {
    const scope = resolveFolderScope({
      metadata: {
        driveFolderScope: {
          folderIds: ['good', '', "bad' or '1'='1", 'has space', 42, null, 'also-good'],
        },
      },
    });
    // The value is stored data, so it is treated as hostile: an id that
    // reaches a Drive query must not be able to close a quote.
    expect(scope).toEqual({ folderIds: ['good', 'also-good'] });
  });
});

describe('FolderContainment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepts the allowed folder itself without a request', async () => {
    const { fetchMock } = driveTree({});
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));
    expect(await containment.isInside('root-1')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a direct child', async () => {
    const { fetchMock } = driveTree({ 'file-1': ['root-1'] });
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));
    expect(await containment.isInside('file-1')).toBe(true);
  });

  it('accepts a file nested several folders deep', async () => {
    const { fetchMock } = driveTree({
      'file-1': ['sub-2'],
      'sub-2': ['sub-1'],
      'sub-1': ['root-1'],
    });
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));
    // Drive v3 has no recursive query, so subtree access is exactly this walk.
    expect(await containment.isInside('file-1')).toBe(true);
  });

  it('rejects a file in a sibling tree', async () => {
    const { fetchMock } = driveTree({
      'file-1': ['other-sub'],
      'other-sub': ['other-root'],
      'other-root': [],
    });
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));
    expect(await containment.isInside('file-1')).toBe(false);
  });

  it('accepts a file reachable through any one of several parents', async () => {
    const { fetchMock } = driveTree({
      'file-1': ['other-root', 'sub-1'],
      'other-root': [],
      'sub-1': ['root-1'],
    });
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));
    // A Drive file can sit in more than one folder, so this is a DAG walk.
    expect(await containment.isInside('file-1')).toBe(true);
  });

  it('rejects rather than hangs on a parent cycle', async () => {
    const { fetchMock } = driveTree({ a: ['b'], b: ['a'] });
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));
    expect(await containment.isInside('a')).toBe(false);
  });

  it('denies everything when the scope holds no folders', async () => {
    const { fetchMock } = driveTree({ 'file-1': ['root-1'] });
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set());
    expect(await containment.isInside('file-1')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a file it cannot read as outside the scope', async () => {
    const { fetchMock } = driveTree({});
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));
    expect(await containment.isInside('missing')).toBe(false);
  });

  it('throws on a Drive outage rather than answering', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));
    // A 500 is not a verdict. The caller has to deny, not cache "outside".
    await expect(containment.isInside('file-1')).rejects.toThrow(/500/);
  });

  it('surfaces a 401 so the caller can refresh the token', async () => {
    const fetchMock = vi.fn(async () => new Response('no', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));
    await expect(containment.isInside('file-1')).rejects.toThrow(/401/);
  });

  it('looks up each ancestor once across a page of siblings', async () => {
    const { fetchMock, calls } = driveTree({
      'file-1': ['sub-1'],
      'file-2': ['sub-1'],
      'file-3': ['sub-1'],
      'sub-1': ['root-1'],
    });
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));
    const kept = await containment.filterIds([{ id: 'file-1' }, { id: 'file-2' }, { id: 'file-3' }]);
    expect(kept).toHaveLength(3);
    // Three files plus their one shared parent. Without the cache the shared
    // parent would be fetched once per sibling.
    expect(calls.filter((id) => id === 'sub-1')).toHaveLength(1);
  });

  it('drops an entry with no id', async () => {
    const { fetchMock } = driveTree({ 'file-1': ['root-1'] });
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));
    const kept = await containment.filterIds([{ id: 'file-1' }, { name: 'no id' }]);
    expect(kept).toEqual([{ id: 'file-1' }]);
  });
});

describe('filterListResult', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters every collection the listing actions return and recomputes total', async () => {
    const { fetchMock } = driveTree({
      in1: ['root-1'],
      out1: ['other'],
      other: [],
    });
    vi.stubGlobal('fetch', fetchMock);
    const containment = new FolderContainment('t', new Set(['root-1']));

    for (const key of ['files', 'documents', 'folders', 'spreadsheets']) {
      const result = (await filterListResult(
        { [key]: [{ id: 'in1' }, { id: 'out1' }], total: 2, nextPageToken: 'tok' },
        containment,
      )) as Record<string, unknown>;
      expect(result[key]).toEqual([{ id: 'in1' }]);
      expect(result.total).toBe(1);
      // Drive owns paging. Dropping the token would strand the caller before
      // the end of the results, so a short page is the honest answer.
      expect(result.nextPageToken).toBe('tok');
    }
  });

  it('leaves a result with no collections alone', async () => {
    const containment = new FolderContainment('t', new Set(['root-1']));
    expect(await filterListResult({ count: 3 }, containment)).toEqual({ count: 3 });
    expect(await filterListResult(null, containment)).toBeNull();
  });
});
