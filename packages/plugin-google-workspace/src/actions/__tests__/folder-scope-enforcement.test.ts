import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  PluginActionContext,
  Sandbox,
  SessionEntry,
  ToolContext,
} from '@valet/engine';
import { googleWorkspacePlugin } from '../actions.js';
import { SCOPE_DENIAL } from '../folder-scope.js';

type FakeSandbox = Partial<Sandbox> & { id: string };

/**
 * The scope lives on the person's own Drive credential, so a scoped context
 * is a credential with `driveFolderScope` metadata.
 */
function makeCredentials(folderIds?: string[]): CredentialProvider {
  const cred: Credential = {
    accessToken: 'test-token',
    ...(folderIds ? { metadata: { driveFolderScope: { folderIds } } } : {}),
  };
  return {
    get: async (): Promise<Credential | null> => cred,
    request: async (): Promise<Credential> => {
      throw new Error('not implemented in test stub');
    },
  };
}

function ctxWithScope(folderIds?: string[]): PluginActionContext {
  const sandbox: FakeSandbox = { id: 'sb-1' };
  const base: ToolContext = {
    userId: 'u1',
    orgId: 'o1',
    sessionId: 's1',
    threadId: 't1',
    credentials: makeCredentials(folderIds),
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error('not implemented in test stub');
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
  return { ...base, actionId: '', service: 'google_workspace' };
}

function action(id: string) {
  const found = googleWorkspacePlugin.actions.find((a) => a.id === id);
  if (!found) throw new Error(`action not found: ${id}`);
  return found;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Serve a Drive tree plus a queue of non-parent responses. `tree` answers
 * every `fields=parents` lookup; anything else takes the next queued body.
 */
function serveDrive(tree: Record<string, string[] | undefined>, queue: Response[] = []) {
  const bodies = [...queue];
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const target = String(url);
    if (target.includes('fields=parents')) {
      const id = decodeURIComponent(target.split('/files/')[1].split('?')[0]);
      const parents = tree[id];
      if (parents === undefined) return json({ error: { code: 404 } }, 404);
      return json({ parents });
    }
    const next = bodies.shift();
    if (!next) throw new Error(`unexpected request: ${target}`);
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Drive folder scope enforcement', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('leaves an unscoped credential completely untouched', async () => {
    const fetchMock = serveDrive({}, [
      json({ files: [{ id: 'anywhere', name: 'Anywhere.doc', mimeType: 'application/pdf' }] }),
    ]);

    const result = await action('drive.list_files').execute({}, ctxWithScope());

    expect(result.success).toBe(true);
    expect((result.data as { files: unknown[] }).files).toHaveLength(1);
    // No scope means no containment lookups at all.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('fields=parents'))).toHaveLength(0);
  });

  it('drops a listed file that sits outside the allowed folders', async () => {
    serveDrive(
      { inside: ['root-1'], outside: ['other'], other: [] },
      [
        json({
          files: [
            { id: 'inside', name: 'Budget.doc', mimeType: 'application/vnd.google-apps.document' },
            { id: 'outside', name: 'Secrets.doc', mimeType: 'application/vnd.google-apps.document' },
          ],
        }),
      ],
    );

    const result = await action('drive.list_files').execute({}, ctxWithScope(['root-1']));

    const files = (result.data as { files: Array<{ id: string }>; total: number }).files;
    expect(files.map((f) => f.id)).toEqual(['inside']);
    expect((result.data as { total: number }).total).toBe(1);
  });

  it('keeps a file nested deep inside an allowed folder', async () => {
    serveDrive({ deep: ['sub-2'], 'sub-2': ['sub-1'], 'sub-1': ['root-1'] }, [
      json({ files: [{ id: 'deep', name: 'Q4.doc', mimeType: 'application/vnd.google-apps.document' }] }),
    ]);

    const result = await action('drive.list_files').execute({}, ctxWithScope(['root-1']));

    expect((result.data as { files: Array<{ id: string }> }).files.map((f) => f.id)).toEqual(['deep']);
  });

  it('refuses to read a file outside the scope, and never calls Drive for it', async () => {
    const fetchMock = serveDrive({ outside: ['other'], other: [] });

    const result = await action('drive.get_document_info').execute(
      { fileId: 'outside' },
      ctxWithScope(['root-1']),
    );

    expect(result).toEqual({ success: false, error: SCOPE_DENIAL });
    // The check has to happen BEFORE the read. Only parent lookups may run.
    const nonParent = fetchMock.mock.calls.filter(([u]) => !String(u).includes('fields=parents'));
    expect(nonParent).toHaveLength(0);
  });

  it('refuses to write to a file outside the scope', async () => {
    serveDrive({ outside: ['other'], other: [] });

    const result = await action('drive.delete_file').execute(
      { fileId: 'outside' },
      ctxWithScope(['root-1']),
    );

    expect(result).toEqual({ success: false, error: SCOPE_DENIAL });
  });

  it('refuses a move whose target file is outside the scope', async () => {
    serveDrive({ outside: ['other'], other: [] });

    const result = await action('drive.move_file').execute(
      { fileId: 'outside', folderId: 'root-1' },
      ctxWithScope(['root-1']),
    );

    expect(result).toEqual({ success: false, error: SCOPE_DENIAL });
  });

  it('denies every file when a scope is set with no folders', async () => {
    serveDrive({ anything: ['root-1'] });

    const result = await action('drive.get_document_info').execute(
      { fileId: 'anything' },
      ctxWithScope([]),
    );

    expect(result).toEqual({ success: false, error: SCOPE_DENIAL });
  });

  it('puts a create with no folder into the one allowed folder', async () => {
    const fetchMock = serveDrive({}, [json({ id: 'new-doc', name: 'Notes' })]);

    const result = await action('drive.create_folder').execute(
      { name: 'Notes' },
      ctxWithScope(['root-1']),
    );

    expect(result.success).toBe(true);
    // Otherwise the new file lands in the Drive root, which the scope cannot
    // contain, and the agent immediately loses track of what it made.
    const lastInit = fetchMock.mock.calls.at(-1)?.[1];
    const body = JSON.parse(String(lastInit?.body)) as { parents?: string[] };
    expect(body.parents).toEqual(['root-1']);
  });

  it('refuses a create aimed at a folder outside the scope', async () => {
    serveDrive({ elsewhere: ['other'], other: [] });

    const result = await action('drive.create_folder').execute(
      { name: 'Notes', parentFolderId: 'elsewhere' },
      ctxWithScope(['root-1']),
    );

    expect(result).toEqual({ success: false, error: SCOPE_DENIAL });
  });

  it('asks for a destination when the scope holds several folders', async () => {
    serveDrive({});

    const result = await action('drive.create_folder').execute(
      { name: 'Notes' },
      ctxWithScope(['root-1', 'root-2']),
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('parentFolderId');
  });

  it('refuses a create that can only land in the Drive root', async () => {
    serveDrive({});

    const result = await action('sheets.create_spreadsheet').execute(
      { title: 'Budget' },
      ctxWithScope(['root-1']),
    );

    // sheets.create_spreadsheet takes no folder, so nothing can place it
    // inside the scope. Saying so beats creating it outside.
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('top level of Drive');
  });

  it('refuses a template copy whose template is outside the scope', async () => {
    serveDrive({ tmpl: ['other'], other: [] });

    const result = await action('drive.create_from_template').execute(
      { templateId: 'tmpl', title: 'Copy', folderId: 'root-1' },
      ctxWithScope(['root-1']),
    );

    // The template is read to make the copy, so reading it has to be allowed.
    expect(result).toEqual({ success: false, error: SCOPE_DENIAL });
  });

  it('refuses a sheet copy when either side is outside the scope', async () => {
    serveDrive({ inside: ['root-1'], outside: ['other'], other: [] });

    const toOutside = await action('sheets.copy_sheet_to').execute(
      { sourceSpreadsheetId: 'inside', destinationSpreadsheetId: 'outside', sheetId: 0 },
      ctxWithScope(['root-1']),
    );
    expect(toOutside).toEqual({ success: false, error: SCOPE_DENIAL });

    serveDrive({ inside: ['root-1'], outside: ['other'], other: [] });
    const fromOutside = await action('sheets.copy_sheet_to').execute(
      { sourceSpreadsheetId: 'outside', destinationSpreadsheetId: 'inside', sheetId: 0 },
      ctxWithScope(['root-1']),
    );
    expect(fromOutside).toEqual({ success: false, error: SCOPE_DENIAL });
  });

  it('denies rather than allows when Drive cannot answer the check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    const result = await action('drive.get_document_info').execute(
      { fileId: 'anything' },
      ctxWithScope(['root-1']),
    );

    // An outage is not a verdict. Failing open here would hand over the
    // whole Drive whenever Google has a bad minute.
    expect(result).toEqual({ success: false, error: SCOPE_DENIAL });
  });

  it('surfaces a 401 so the token can be refreshed and the call retried', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })));

    const result = await action('drive.get_document_info').execute(
      { fileId: 'anything' },
      ctxWithScope(['root-1']),
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('401');
    expect(String(result.error)).not.toBe(SCOPE_DENIAL);
  });

  it('scopes every read, write and create action, with nothing unclassified', async () => {
    // A new action that nobody classified must be unreachable under a scope
    // rather than silently exempt. This fails when an action is added
    // without a category, which is the whole point.
    const ids = googleWorkspacePlugin.actions.map((a) => a.id);
    const { classifyAction } = await import('../labels-guard.js');
    const unclassified = ids.filter((id) => classifyAction(id) === 'unknown');
    expect(unclassified).toEqual([]);
  });
});
