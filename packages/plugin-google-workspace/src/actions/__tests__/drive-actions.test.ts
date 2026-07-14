import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from '@valet/engine';
import { driveActions } from '../drive-actions.js';

type FakeSandbox = Partial<Sandbox> & { id: string };

function makeCredentials(token: string | null): CredentialProvider {
  return {
    get: async (): Promise<Credential | null> => (token === null ? null : { accessToken: token }),
    request: async (): Promise<Credential> => {
      throw new Error('not implemented in test stub');
    },
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const sandbox: FakeSandbox = { id: 'sb-1' };
  return {
    userId: 'u1',
    orgId: 'o1',
    sessionId: 's1',
    threadId: 't1',
    credentials: makeCredentials('test-token'),
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error('not implemented in test stub');
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...overrides,
  };
}

function pluginCtx(overrides: Partial<ToolContext> = {}) {
  return { ...makeCtx(overrides), actionId: '', service: 'google_workspace' };
}

function action(id: string) {
  const found = driveActions.find((a) => a.id === id);
  if (!found) throw new Error(`action not found: ${id}`);
  return found;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('drive actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('list_files queries Drive with trashed=false and maps results', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        files: [
          {
            id: 'f1',
            name: 'Report.doc',
            mimeType: 'application/vnd.google-apps.document',
            size: '1024',
            modifiedTime: '2026-01-01T00:00:00Z',
            createdTime: '2026-01-01T00:00:00Z',
            owners: [{ displayName: 'Alice', emailAddress: 'alice@example.com' }],
            webViewLink: 'https://docs.google.com/document/d/f1',
          },
        ],
        nextPageToken: 'np1',
      }),
    );

    const result = await action('drive.list_files').execute({ maxResults: 10 }, pluginCtx());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://www.googleapis.com/drive/v3/files?');
    expect(url).toContain('q=trashed%3Dfalse');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');

    expect(result).toEqual({
      success: true,
      data: {
        files: [
          {
            id: 'f1',
            name: 'Report.doc',
            mimeType: 'application/vnd.google-apps.document',
            size: 1024,
            modifiedTime: '2026-01-01T00:00:00Z',
            createdTime: '2026-01-01T00:00:00Z',
            owner: 'Alice',
            url: 'https://docs.google.com/document/d/f1',
          },
        ],
        total: 1,
        nextPageToken: 'np1',
      },
    });
  });

  it('list_files maps a 403 response to a Drive API error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Insufficient permission' } }), { status: 403 }),
    );

    const result = await action('drive.list_files').execute({}, pluginCtx());

    expect(result).toEqual({
      success: false,
      error: 'Drive API 403: Insufficient permission',
    });
  });

  it('list_files rejects when ownedByMe and sharedWithMe are both set', async () => {
    const result = await action('drive.list_files').execute(
      { ownedByMe: true, sharedWithMe: true },
      pluginCtx(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'ownedByMe and sharedWithMe cannot both be true',
    });
  });

  it('returns "Missing access token" without calling fetch when no credential is stored', async () => {
    const result = await action('drive.list_files').execute(
      {},
      pluginCtx({ credentials: makeCredentials(null) }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: 'Missing access token' });
  });

  it('search_files searches name+content and reports hasMore', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { files: [], nextPageToken: 'np2' }));

    const result = await action('drive.search_files').execute({ query: 'budget' }, pluginCtx());

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("name+contains+%27budget%27+or+fullText+contains+%27budget%27");
    expect(result).toEqual({
      success: true,
      data: { files: [], total: 0, nextPageToken: 'np2', hasMore: true },
    });
  });

  it('list_documents filters to Google Docs mimeType', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        files: [{ id: 'd1', name: 'Doc', modifiedTime: '2026-01-01', webViewLink: 'url1' }],
      }),
    );

    const result = await action('drive.list_documents').execute({}, pluginCtx());

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("mimeType%3D%27application%2Fvnd.google-apps.document%27");
    expect(result).toEqual({
      success: true,
      data: {
        documents: [{ id: 'd1', name: 'Doc', modifiedTime: '2026-01-01', owner: null, url: 'url1' }],
        total: 1,
        nextPageToken: undefined,
      },
    });
  });

  it('search_documents restricts search to Google Docs by name/content', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { files: [] }));

    const result = await action('drive.search_documents').execute({ query: 'invoice' }, pluginCtx());

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("mimeType%3D%27application%2Fvnd.google-apps.document%27");
    expect(result).toEqual({ success: true, data: { documents: [], total: 0, nextPageToken: undefined } });
  });

  it('list_folder_contents splits folders and files', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        files: [
          { id: 'fold1', name: 'Sub', mimeType: 'application/vnd.google-apps.folder', modifiedTime: 't1' },
          { id: 'file1', name: 'Doc', mimeType: 'text/plain', modifiedTime: 't2' },
        ],
      }),
    );

    const result = await action('drive.list_folder_contents').execute({ folderId: 'root' }, pluginCtx());

    expect(result).toEqual({
      success: true,
      data: {
        folders: [{ id: 'fold1', name: 'Sub', modifiedTime: 't1' }],
        files: [{ id: 'file1', name: 'Doc', mimeType: 'text/plain', modifiedTime: 't2' }],
        nextPageToken: undefined,
      },
    });
  });

  it('get_document_info fetches metadata by fileId', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'f1',
        name: 'Doc',
        mimeType: 'application/vnd.google-apps.document',
        createdTime: 'c1',
        modifiedTime: 'm1',
        owners: [{ displayName: 'Bob' }],
        lastModifyingUser: { displayName: 'Bob' },
        shared: true,
        webViewLink: 'url1',
        description: 'desc',
      }),
    );

    const result = await action('drive.get_document_info').execute({ fileId: 'f1' }, pluginCtx());

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://www.googleapis.com/drive/v3/files/f1?fields=id%2Cname%2CmimeType%2Cdescription%2Csize%2CcreatedTime%2CmodifiedTime%2CwebViewLink%2Cowners%28displayName%2CemailAddress%29%2ClastModifyingUser%28displayName%2CemailAddress%29%2Cshared%2Cparents&supportsAllDrives=true',
    );
    expect(result).toEqual({
      success: true,
      data: {
        id: 'f1',
        name: 'Doc',
        mimeType: 'application/vnd.google-apps.document',
        createdTime: 'c1',
        modifiedTime: 'm1',
        owner: 'Bob',
        lastModifyingUser: 'Bob',
        shared: true,
        url: 'url1',
        description: 'desc',
      },
    });
  });

  it('get_folder_info rejects a non-folder file and otherwise counts children', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'fold1',
        name: 'Folder',
        mimeType: 'application/vnd.google-apps.folder',
        createdTime: 'c1',
        modifiedTime: 'm1',
        owners: [{ displayName: 'Carol' }],
        shared: false,
        webViewLink: 'url1',
        parents: ['root'],
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { files: [{ id: 'a' }, { id: 'b' }] }));

    const result = await action('drive.get_folder_info').execute({ folderId: 'fold1' }, pluginCtx());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      success: true,
      data: {
        id: 'fold1',
        name: 'Folder',
        createdTime: 'c1',
        modifiedTime: 'm1',
        owner: 'Carol',
        lastModifyingUser: null,
        shared: false,
        url: 'url1',
        description: null,
        parentFolderId: 'root',
        childCount: 2,
      },
    });
  });

  it('create_document posts file metadata and returns id/name/url', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'newdoc', name: 'Untitled', webViewLink: 'url1' }),
    );

    const result = await action('drive.create_document').execute({ title: 'Untitled' }, pluginCtx());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://www.googleapis.com/drive/v3/files?');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Untitled',
      mimeType: 'application/vnd.google-apps.document',
    });
    expect(result).toEqual({
      success: true,
      data: { id: 'newdoc', name: 'Untitled', url: 'url1' },
    });
  });

  it('create_folder posts folder metadata', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'fold1', name: 'New Folder' }));

    const result = await action('drive.create_folder').execute({ name: 'New Folder' }, pluginCtx());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'New Folder',
      mimeType: 'application/vnd.google-apps.folder',
    });
    expect(result).toEqual({ success: true, data: { id: 'fold1', name: 'New Folder' } });
  });

  it('copy_file posts to the /copy endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'copy1', name: 'Copy' }));

    const result = await action('drive.copy_file').execute({ fileId: 'f1', name: 'Copy' }, pluginCtx());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/files/f1/copy?');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Copy' });
    expect(result).toEqual({ success: true, data: { id: 'copy1', name: 'Copy' } });
  });

  it('move_file reads current parents then PATCHes addParents/removeParents', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 'f', parents: ['old'] }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'f1', name: 'f', parents: ['new'] }));

    const result = await action('drive.move_file').execute({ fileId: 'f1', folderId: 'new' }, pluginCtx());

    const [moveUrl, moveInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(moveUrl).toContain('addParents=new');
    expect(moveUrl).toContain('removeParents=old');
    expect(moveInit.method).toBe('PATCH');
    expect(result).toEqual({ success: true, data: { id: 'f1', name: 'f', parents: ['new'] } });
  });

  it('rename_file PATCHes the name field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'f1', name: 'Renamed' }));

    const result = await action('drive.rename_file').execute({ fileId: 'f1', name: 'Renamed' }, pluginCtx());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Renamed' });
    expect(result).toEqual({ success: true, data: { id: 'f1', name: 'Renamed' } });
  });

  it('delete_file trashes by default', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const result = await action('drive.delete_file').execute({ fileId: 'f1' }, pluginCtx());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ trashed: true });
    expect(result).toEqual({ success: true, data: { trashed: true, permanentlyDeleted: false } });
  });

  it('delete_file permanently deletes when permanent=true', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await action('drive.delete_file').execute({ fileId: 'f1', permanent: true }, pluginCtx());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(result).toEqual({ success: true, data: { trashed: false, permanentlyDeleted: true } });
  });

  it('download_file exports Google Workspace files as text', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'f1', name: 'Doc', mimeType: 'application/vnd.google-apps.document' }),
    );
    fetchMock.mockResolvedValueOnce(new Response('# Hello', { status: 200 }));

    const result = await action('drive.download_file').execute({ fileId: 'f1' }, pluginCtx());

    const [exportUrl] = fetchMock.mock.calls[1] as [string];
    expect(exportUrl).toContain('/files/f1/export?mimeType=text%2Fmarkdown');
    expect(result).toEqual({
      success: true,
      data: {
        name: 'Doc',
        mimeType: 'application/vnd.google-apps.document',
        exportedAs: 'text/markdown',
        content: '# Hello',
      },
    });
  });

  it('download_file rejects binary files', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'f1', name: 'image.png', mimeType: 'image/png', size: '100' }),
    );

    const result = await action('drive.download_file').execute({ fileId: 'f1' }, pluginCtx());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: false,
      error: 'Cannot download binary file (image/png). Only text-based and Google Workspace files are supported.',
    });
  });

  it('create_from_template copies the template and applies replacements', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'new1', name: 'Contract', webViewLink: 'url1' }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('drive.create_from_template').execute(
      { templateId: 'tmpl1', title: 'Contract', replacements: { '{{name}}': 'Alice' } },
      pluginCtx(),
    );

    const [copyUrl, copyInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(copyUrl).toContain('/files/tmpl1/copy?');
    expect(JSON.parse(copyInit.body as string)).toEqual({ name: 'Contract' });

    const [batchUrl, batchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(batchUrl).toBe('https://docs.googleapis.com/v1/documents/new1:batchUpdate');
    expect(JSON.parse(batchInit.body as string)).toEqual({
      requests: [
        { replaceAllText: { containsText: { text: '{{name}}', matchCase: false }, replaceText: 'Alice' } },
      ],
    });

    expect(result).toEqual({
      success: true,
      data: { id: 'new1', name: 'Contract', url: 'url1' },
    });
  });
});
