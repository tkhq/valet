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
import { slackPlugin } from './actions.js';

function makeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected sandbox call in Slack action test'); };
  return {
    id: 'sb-1', readFile: unsupported, readBinary: unsupported,
    writeFile: unsupported, writeBinary: unsupported, readdir: unsupported,
    stat: unsupported, mkdir: unsupported, rm: unsupported, exec: unsupported,
    ...overrides,
  };
}

function makeCredentials(cred: Credential | null): CredentialProvider {
  return {
    get: async (): Promise<Credential | null> => cred,
    request: async (): Promise<Credential> => {
      throw new Error('not implemented in test stub');
    },
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const sandbox = makeSandbox();
  return {
    userId: 'u1',
    orgId: 'o1',
    sessionId: 's1',
    threadId: 't1',
    credentials: makeCredentials({ accessToken: 'xoxb-test-token' }),
    sandbox,
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
  return { ...makeCtx(overrides), actionId: '', service: 'slack' };
}

function action(id: string) {
  const found = slackPlugin.actions.find((a) => a.id === id);
  if (!found) throw new Error(`action not found: ${id}`);
  return found;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Every guarded action calls checkPrivateChannelAccess first, which issues its own
 *  conversations.info request. Queue a public-channel response so the guard passes
 *  before the action's own fetch mocks are consumed. */
function mockGuardAllowsPublicChannel(fetchMock: ReturnType<typeof vi.fn>): void {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, {
      ok: true,
      channel: { id: 'C1', name: 'general', is_private: false, is_im: false, is_mpim: false },
    }),
  );
}

describe('Slack search and authorized files', () => {
  const url = 'https://files.slack.com/files-pri/T1-F1/scope.docx';
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });
  function fileInfo(extra: Record<string, unknown> = {}) {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, file: {
      id: 'F1', name: 'scope.docx', url_private: url, channels: ['C1'], ...extra,
    } }));
  }
  it('finds XSET anywhere in names and ranks exact matches first across pages', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, channels: [{ id: 'C1', name: 'lead-xset' }], response_metadata: { next_cursor: 'next' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, channels: [{ id: 'C2', name: 'xset' }, { id: 'C3', name: 'other' }] }));
    const result = await action('slack.search_channels').execute({ query: '#XSET' }, pluginCtx());
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ channels: [{ id: 'C2' }, { id: 'C1' }], search_complete: true, ambiguous: true });
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=next');
  });
  it('does not describe an empty search as denied access', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, channels: [] }));
    const result = await action('slack.search_channels').execute({ query: 'xset' }, pluginCtx());
    expect(result.data).toMatchObject({ total: 0, search_complete: true, match_status: 'no_match' });
    expect(JSON.stringify(result.data)).toContain('not proof');
  });
  it.each(['team', 'org'] as const)('reads a file shared into an authorized %s channel', async (type) => {
    fileInfo();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { is_private: true, is_member: true } }));
    fetchMock.mockResolvedValueOnce(new Response('proposal', { headers: { 'Content-Type': 'text/plain' } }));
    const result = await action('slack.fetch_file').execute({ file_id: 'F1' }, pluginCtx({ owner: { type, id: 'shared' } }));
    expect(result).toMatchObject({ success: true, data: { content: 'proposal' } });
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ redirect: 'error' });
  });
  it('does not let a shared run download a DM-only file', async () => {
    fileInfo({ channels: [], ims: ['D1'] });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { is_im: true } }));
    const result = await action('slack.fetch_file').execute({ file_id: 'F1' }, pluginCtx({ owner: { type: 'team', id: 'team' } }));
    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('does not let an unlinked personal user read a private file', async () => {
    fileInfo({ channels: [], groups: ['C1'] });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { is_private: true } }));
    const result = await action('slack.fetch_file').execute({ file_id: 'F1' }, pluginCtx());
    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('fails closed when Slack does not disclose a file channel', async () => {
    fileInfo({ channels: [] });
    const result = await action('slack.fetch_file').execute({ file_id: 'F1' }, pluginCtx());
    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects an untrusted download URL returned by Slack', async () => {
    fileInfo({ url_private: 'https://evil.example/scope.docx' });
    const result = await action('slack.fetch_file').execute({ file_id: 'F1' }, pluginCtx());
    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('saves original bytes in the sandbox for editing', async () => {
    fileInfo(); mockGuardAllowsPublicChannel(fetchMock);
    const bytes = new Uint8Array([80, 75, 3, 4]);
    fetchMock.mockResolvedValueOnce(new Response(bytes));
    const writeBinary = vi.fn().mockResolvedValue(undefined);
    const result = await action('slack.fetch_file').execute({ file_id: 'F1', output_path: '/workspace/scope.docx' }, pluginCtx({ sandbox: makeSandbox({ writeBinary }) }));
    expect(result).toMatchObject({ success: true, data: { path: '/workspace/scope.docx', size: 4 } });
    expect(writeBinary).toHaveBeenCalledWith('/workspace/scope.docx', bytes);
  });
  it('preserves the corrective action for an unlinked private-file owner', async () => {
    fileInfo();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { is_private: true } }));
    const result = await action('slack.fetch_file').execute({ file_id: 'F1' }, pluginCtx());
    expect(result.error).toContain('Link Slack');
  });
  it.each([false, true])('checks linked personal DM membership (member=%s)', async (member) => {
    fileInfo({ channels: [], ims: ['D1'] });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { is_im: true } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, members: member ? ['U1'] : ['U2'] }));
    if (member) fetchMock.mockResolvedValueOnce(new Response('hello', { headers: { 'Content-Type': 'text/plain' } }));
    const writeBinary = vi.fn();
    const result = await action('slack.fetch_file').execute({ file_id: 'F1' }, pluginCtx({
      credentials: makeCredentials({ accessToken: 'token', metadata: { owner_slack_user_id: 'U1' } }),
      sandbox: makeSandbox({ writeBinary }),
    }));
    expect(result.success).toBe(member);
    expect(fetchMock).toHaveBeenCalledTimes(member ? 4 : 3);
    expect(writeBinary).not.toHaveBeenCalled();
  });
  it('rejects shared group-DM downloads without writing a file', async () => {
    fileInfo({ channels: [], groups: ['G1'] });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { is_mpim: true } }));
    const writeBinary = vi.fn();
    const result = await action('slack.fetch_file').execute({ file_id: 'F1', output_path: '/workspace/file' }, pluginCtx({ owner: { type: 'org', id: 'org' }, sandbox: makeSandbox({ writeBinary }) }));
    expect(result.success).toBe(false);
    expect(writeBinary).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('tries another verified share after a denied share', async () => {
    fileInfo({ channels: [], shares: { private: { C1: [{ ts: '1' }], C2: [{ ts: '2' }] } } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { is_private: true, is_member: false } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { is_private: true, is_member: true } }));
    fetchMock.mockResolvedValueOnce(new Response('hello', { headers: { 'Content-Type': 'text/plain' } }));
    const result = await action('slack.fetch_file').execute({ file_id: 'F1' }, pluginCtx({ owner: { type: 'team', id: 'team' } }));
    expect(result.success).toBe(true);
  });
  it('bounds streamed downloads and does not save partial files', async () => {
    fileInfo(); mockGuardAllowsPublicChannel(fetchMock);
    let chunks = 0;
    let cancelled = false;
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    })));
    const writeBinary = vi.fn();
    const result = await action('slack.fetch_file').execute({ file_id: 'F1', output_path: '/workspace/file' }, pluginCtx({ sandbox: makeSandbox({ writeBinary }) }));
    expect(result.success).toBe(false);
    expect(chunks).toBeLessThanOrEqual(27);
    expect(cancelled).toBe(true);
    expect(writeBinary).not.toHaveBeenCalled();
  });
  it.each(['http://files.slack.com/files-pri/T1-F1/x', 'https://files.slack.com.evil.test/x', 'https://user:pass@files.slack.com/x'])('rejects unsafe input URL %s', async (url) => {
    expect((await action('slack.fetch_file').execute({ url }, pluginCtx())).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reports missing files:read with a reinstall action', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: false, error: 'missing_scope' }));
    const result = await action('slack.fetch_file').execute({ file_id: 'F1' }, pluginCtx());
    expect(result.error).toContain('reinstall');
    expect(result.error).toContain('files:read');
  });

});
