import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  PluginActionResult,
  Sandbox,
  SessionEntry,
  ToolContext,
} from '@valet/engine';
import { figmaPlugin, parseFigmaFile, normalizeNodeId } from './actions.js';

const fetchMock = vi.fn<typeof fetch>();

type FakeSandbox = Partial<Sandbox> & { id: string };

function makeCredentials(token: string | null): CredentialProvider {
  return {
    get: async (): Promise<Credential | null> => (token === null ? null : { accessToken: token }),
    request: async (): Promise<Credential> => {
      throw new Error('not implemented in test stub');
    },
  };
}

function ctx(token: string | null = 'figma-token') {
  const sandbox: FakeSandbox = { id: 'sb-1' };
  const base: ToolContext = {
    userId: 'u1',
    orgId: 'o1',
    sessionId: 's1',
    threadId: 't1',
    credentials: makeCredentials(token),
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error('not implemented in test stub');
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
  return { ...base, actionId: '', service: 'figma' };
}

/** Run one action the way the catalog does, after schema validation. */
async function run(id: string, args: Record<string, unknown>, token: string | null = 'figma-token'): Promise<PluginActionResult> {
  const found = figmaPlugin.actions.find((a) => a.id === id);
  if (!found) throw new Error(`action not found: ${id}`);
  return found.execute(args as never, ctx(token));
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function png(size: number): Response {
  return new Response(new Uint8Array(size).fill(7), {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(size) },
  });
}

function requestUrl(call: number): string {
  return String(fetchMock.mock.calls[call][0]);
}

function requestHeaders(call: number): Headers {
  return new Headers(fetchMock.mock.calls[call][1]?.headers);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('parseFigmaFile', () => {
  it('accepts a bare file key', () => {
    expect(parseFigmaFile('  AbC123xyz  ')).toEqual({ fileKey: 'AbC123xyz' });
  });

  it('parses /design URLs and normalizes the node id', () => {
    expect(parseFigmaFile('https://www.figma.com/design/AbC123/My-File?node-id=123-456&t=x')).toEqual({
      fileKey: 'AbC123',
      nodeId: '123:456',
    });
  });

  it('parses /file URLs with an encoded colon node id', () => {
    expect(parseFigmaFile('https://figma.com/file/Key987/Title?node-id=1%3A2')).toEqual({
      fileKey: 'Key987',
      nodeId: '1:2',
    });
  });

  it('uses the branch key for branch URLs', () => {
    expect(parseFigmaFile('https://www.figma.com/design/Main1/branch/Branch2/Title')).toEqual({ fileKey: 'Branch2' });
  });

  it('rejects other hosts and URL forms', () => {
    expect(() => parseFigmaFile('https://example.com/design/AbC123/x')).toThrow('figma.com');
    expect(() => parseFigmaFile('https://www.figma.com/proto/AbC123/x')).toThrow('figma.com');
    expect(() => parseFigmaFile('not a url')).toThrow('Not a Figma URL');
  });

  it('normalizes instance node ids', () => {
    expect(normalizeNodeId('I1-2;3-4')).toBe('I1:2;3:4');
  });
});

describe('figma.render_frames', () => {
  it('renders the URL node and returns the PNG as an attachment, not in data', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ err: null, images: { '1:2': 'https://cdn.example/1.png' } }))
      .mockResolvedValueOnce(png(10));

    const result = await run('figma.render_frames', { file: 'https://www.figma.com/design/AbC123/File?node-id=1-2', scale: 2 });

    expect(result.success).toBe(true);
    const api = new URL(requestUrl(0));
    expect(api.pathname).toBe('/v1/images/AbC123');
    expect(api.searchParams.get('ids')).toBe('1:2');
    expect(api.searchParams.get('format')).toBe('png');
    expect(api.searchParams.get('scale')).toBe('2');
    expect(requestHeaders(0).get('Authorization')).toBe('Bearer figma-token');

    expect(requestUrl(1)).toBe('https://cdn.example/1.png');
    expect(requestHeaders(1).get('Authorization')).toBeNull();

    expect(result.attachments).toEqual([
      { type: 'image', data: new Uint8Array(10).fill(7), mimeType: 'image/png', name: 'figma-AbC123-1-2.png' },
    ]);
    expect(result.data).toEqual({ file_key: 'AbC123', scale: 2, rendered: [{ node_id: '1:2', bytes: 10 }], failed: [] });
  });

  it('prefers node_ids over the URL node and normalizes them', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ images: { '3:4': 'https://cdn.example/a.png', '5:6': 'https://cdn.example/b.png' } }))
      .mockResolvedValueOnce(png(4))
      .mockResolvedValueOnce(png(4));

    const result = await run('figma.render_frames', { file: 'https://www.figma.com/design/AbC123/File?node-id=1-2', node_ids: ['3-4', '5:6', '3:4'] });

    expect(new URL(requestUrl(0)).searchParams.get('ids')).toBe('3:4,5:6');
    expect(new URL(requestUrl(0)).searchParams.get('scale')).toBe('1');
    expect(result.attachments).toHaveLength(2);
  });

  it('asks for list_frames when no node is given and never calls Figma', async () => {
    const result = await run('figma.render_frames', { file: 'AbC123' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('figma.list_frames');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects more than 4 nodes', async () => {
    const result = await run('figma.render_frames', { file: 'AbC123', node_ids: ['1:1', '1:2', '1:3', '1:4', '1:5'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('At most 4');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a scale outside 0.01–4', async () => {
    const result = await run('figma.render_frames', { file: 'AbC123', node_ids: ['1:2'], scale: 5 });
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports null render URLs alongside successful renders', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ images: { '1:2': 'https://cdn.example/ok.png', '3:4': null } }))
      .mockResolvedValueOnce(png(8));

    const result = await run('figma.render_frames', { file: 'AbC123', node_ids: ['1:2', '3:4'] });

    expect(result.success).toBe(true);
    expect(result.attachments).toHaveLength(1);
    expect(result.data).toMatchObject({
      rendered: [{ node_id: '1:2', bytes: 8 }],
      failed: [{ node_id: '3:4', error: expect.stringContaining('could not render') }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails when every node fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ images: { '1:2': null, '3:4': 'https://cdn.example/x.png' } }))
      .mockResolvedValueOnce(new Response('gone', { status: 403 }));

    const result = await run('figma.render_frames', { file: 'AbC123', node_ids: ['1:2', '3:4'] });

    expect(result.success).toBe(false);
    expect(result.error).toContain('1:2: Figma could not render');
    expect(result.error).toContain('3:4: Image download failed: HTTP 403');
    expect(result.attachments).toBeUndefined();
  });

  it('returns a lower-scale hint when a PNG is over 1 MiB', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ images: { '1:2': 'https://cdn.example/big.png' } }))
      .mockResolvedValueOnce(png(4 * 1024 * 1024));

    const result = await run('figma.render_frames', { file: 'AbC123', node_ids: ['1:2'], scale: 2 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('over the 1 MiB limit');
    expect(result.error).toContain('lower scale (try 0.9)');
  });

  it('checks the real size when Content-Length is missing', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ images: { '1:2': 'https://cdn.example/big.png' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 }));

    const result = await run('figma.render_frames', { file: 'AbC123', node_ids: ['1:2'] });

    expect(result.success).toBe(false);
    expect(result.error).toContain('over the 1 MiB limit');
  });

  it('surfaces Figma render errors in the response body', async () => {
    fetchMock.mockResolvedValueOnce(json({ err: 'Render timeout', images: {} }));
    const result = await run('figma.render_frames', { file: 'AbC123', node_ids: ['1:2'] });
    expect(result).toEqual({ success: false, error: 'Figma render failed: Render timeout' });
  });

  it.each([
    [403, {}, 'may have expired, or this account cannot open the file'],
    [404, {}, 'file or node not found'],
    [429, { 'Retry-After': '60' }, 'Retry after 60 seconds'],
  ])('maps HTTP %i to an actionable error', async (status, headers, message) => {
    fetchMock.mockResolvedValueOnce(json({ status, err: 'Invalid token' }, { status, headers }));
    const result = await run('figma.render_frames', { file: 'AbC123', node_ids: ['1:2'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
    expect(result.error).toContain('Figma said: Invalid token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('names the fix when no Figma token is connected', async () => {
    const result = await run('figma.render_frames', { file: 'AbC123', node_ids: ['1:2'] }, null);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Integrations page');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('figma.list_frames', () => {
  const file = {
    name: 'Design System',
    document: {
      id: '0:0',
      type: 'DOCUMENT',
      children: [
        {
          id: '0:1',
          name: 'Page 1',
          type: 'CANVAS',
          children: [
            { id: '1:1', name: 'Home', type: 'FRAME', children: [{ id: '9:9', name: 'deep', type: 'TEXT' }] },
            { id: '1:2', name: 'Note', type: 'TEXT' },
            { id: '1:3', name: 'Button', type: 'COMPONENT' },
            { id: '1:4', name: 'Flows', type: 'SECTION' },
            { id: '1:5', name: 'Blob', type: 'VECTOR' },
          ],
        },
        { id: '0:2', name: 'Archive', type: 'CANVAS', children: [{ id: '2:1', name: 'Old', type: 'FRAME' }] },
      ],
    },
  };

  it('returns pages with top-level frames only', async () => {
    fetchMock.mockResolvedValueOnce(json(file));

    const result = await run('figma.list_frames', { file: 'https://www.figma.com/design/AbC123/x?node-id=1-1' });

    const url = new URL(requestUrl(0));
    expect(url.pathname).toBe('/v1/files/AbC123');
    expect(url.searchParams.get('depth')).toBe('2');
    expect(result).toEqual({
      success: true,
      data: {
        file_key: 'AbC123',
        name: 'Design System',
        pages: [
          {
            id: '0:1',
            name: 'Page 1',
            frames: [
              { id: '1:1', name: 'Home', type: 'FRAME' },
              { id: '1:3', name: 'Button', type: 'COMPONENT' },
              { id: '1:4', name: 'Flows', type: 'SECTION' },
            ],
          },
          { id: '0:2', name: 'Archive', frames: [{ id: '2:1', name: 'Old', type: 'FRAME' }] },
        ],
      },
    });
  });

  it('filters to one page', async () => {
    fetchMock.mockResolvedValueOnce(json(file));
    const result = await run('figma.list_frames', { file: 'AbC123', page_id: '0-2' });
    expect(result.data).toEqual({
      file_key: 'AbC123',
      name: 'Design System',
      pages: [{ id: '0:2', name: 'Archive', frames: [{ id: '2:1', name: 'Old', type: 'FRAME' }] }],
    });
  });

  it('lists available pages when page_id is unknown', async () => {
    fetchMock.mockResolvedValueOnce(json(file));
    const result = await run('figma.list_frames', { file: 'AbC123', page_id: '7:7' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('0:1 (Page 1), 0:2 (Archive)');
  });

  it('maps a 404', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 404, err: 'Not found' }, { status: 404 }));
    const result = await run('figma.list_frames', { file: 'AbC123' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('file or node not found');
  });
});
