import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Value } from 'typebox/value';
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ThreadFile,
  ThreadFileStore,
  ToolContext,
} from '@valet/engine';
import { gmailPlugin } from './actions.js';
import { SIMPLE_REQUEST_MAX_BYTES } from './api.js';
import { GMAIL_ATTACHMENT_LIMIT_BYTES, buildMimeMessage } from './mime.js';

const FILE_ID = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const sow = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0xff, 0x00]);
const agreement = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]);

function threadFiles(files: Record<string, { name: string; mimeType: string; data: Uint8Array }>): ThreadFileStore {
  return {
    save: async () => { throw new Error('not used'); },
    read: async (id) => {
      const file = files[id];
      if (!file) return null;
      const webUrl = `/api/sessions/s1/threads/t1/files/${id}`;
      const described: ThreadFile = { id, name: file.name, mimeType: file.mimeType, bytes: file.data.byteLength, url: webUrl, webUrl };
      return { ...described, data: file.data };
    },
  };
}

function sandboxWith(files: Record<string, Uint8Array>, sizes: Record<string, number> = {}) {
  const readBinary = vi.fn(async (path: string) => {
    const data = files[path];
    if (!data) throw new Error(`ENOENT: ${path}`);
    return data;
  });
  const stat = vi.fn(async (path: string) => {
    const data = files[path];
    if (!data) throw new Error(`ENOENT: ${path}`);
    return { isFile: true, isDirectory: false, size: sizes[path] ?? data.byteLength };
  });
  const sandbox: Partial<Sandbox> & { id: string } = { id: 'sb-1', readBinary, stat };
  return { sandbox, readBinary };
}

function ctx(overrides: Partial<ToolContext> = {}) {
  const credentials: CredentialProvider = {
    get: async (): Promise<Credential | null> => ({ accessToken: 'test-token' }),
    request: async (): Promise<Credential> => { throw new Error('not used'); },
  };
  const base: ToolContext = {
    userId: 'u1',
    orgId: 'o1',
    sessionId: 's1',
    threadId: 't1',
    credentials,
    sandbox: sandboxWith({}).sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => { throw new Error('not used'); },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...overrides,
  };
  return { ...base, actionId: '', service: 'gmail' };
}

function action(id: string) {
  const found = gmailPlugin.actions.find((a) => a.id === id);
  if (!found) throw new Error(`action not found: ${id}`);
  return found;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function requestBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') throw new Error('Expected a JSON body.');
  const value: unknown = JSON.parse(init.body);
  if (typeof value !== 'object' || value === null) throw new Error('Expected a JSON object.');
  return { ...value };
}

function rawOf(init: RequestInit): string {
  const body = requestBody(init);
  const message = body.message;
  const raw = typeof body.raw === 'string'
    ? body.raw
    : typeof message === 'object' && message !== null && 'raw' in message && typeof message.raw === 'string' ? message.raw : undefined;
  if (!raw) throw new Error('Expected a raw message.');
  return Buffer.from(raw, 'base64url').toString('latin1');
}

function base64Of(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

const draftArgs = { to: 'client@example.com', subject: 'Contract', body: 'Attached are the SOW and the agreement.' };

describe('gmail attachments', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('accepts attachments in the create_draft, update_draft, and send_email schemas', () => {
    const attachments = [{ threadFileId: FILE_ID }, { path: '/workspace/out/SOW.pdf', filename: 'SOW.pdf' }];
    for (const id of ['gmail.create_draft', 'gmail.send_email']) {
      expect(Value.Check(action(id).parameters, { ...draftArgs, attachments })).toBe(true);
    }
    expect(Value.Check(action('gmail.update_draft').parameters, { ...draftArgs, draftId: 'd1', attachments })).toBe(true);
    expect(Value.Check(action('gmail.create_draft').parameters, { ...draftArgs, attachments: [{ url: 'https://x' }] })).toBe(false);
    expect(Value.Check(action('gmail.add_draft_attachments').parameters, { draftId: 'd1' })).toBe(false);
  });

  it('creates a draft with a thread file and a working-directory file', async () => {
    const { sandbox } = sandboxWith({ '/workspace/out/SOW Final.pdf': sow });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'd1', message: { id: 'm1', threadId: 'th1' } }));
    const result = await action('gmail.create_draft').execute(
      { ...draftArgs, attachments: [{ path: '/workspace/out/SOW Final.pdf' }, { threadFileId: `https://valet.example/api/sessions/s1/threads/t1/files/${FILE_ID}` }] },
      ctx({ sandbox: sandbox as Sandbox, threadFiles: threadFiles({ [FILE_ID]: { name: 'Agreement.pdf', mimeType: 'application/pdf', data: agreement } }) }),
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        draftId: 'd1',
        attachments: [
          { filename: 'SOW Final.pdf', mimeType: 'application/pdf', bytes: sow.byteLength },
          { filename: 'Agreement.pdf', mimeType: 'application/pdf', bytes: agreement.byteLength },
        ],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    const mime = rawOf(init);
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="valet-mixed-/);
    expect(mime).toContain('filename="SOW Final.pdf"');
    expect(mime).toContain('filename="Agreement.pdf"');
    expect(mime).toContain(base64Of(sow));
    expect(mime).toContain(base64Of(agreement));
  });

  it('sends an email with an attachment through messages.send', async () => {
    const { sandbox } = sandboxWith({ '/workspace/SOW.pdf': sow });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'm1', threadId: 'th1' }));
    const result = await action('gmail.send_email').execute({ ...draftArgs, attachments: [{ path: '/workspace/SOW.pdf' }] }, ctx({ sandbox: sandbox as Sandbox }));
    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(rawOf(init)).toContain(base64Of(sow));
  });

  it('refuses attachments over 25 MB before reading them or calling Gmail', async () => {
    const { sandbox, readBinary } = sandboxWith({ '/workspace/big.zip': new Uint8Array(1) }, { '/workspace/big.zip': GMAIL_ATTACHMENT_LIMIT_BYTES + 1 });
    const result = await action('gmail.create_draft').execute({ ...draftArgs, attachments: [{ path: '/workspace/big.zip' }] }, ctx({ sandbox: sandbox as Sandbox }));
    expect(result.success).toBe(false);
    expect(result.error).toContain("over Gmail's 25 MB limit");
    expect(result.error).toContain('Share a Google Drive link');
    expect(readBinary).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the fix for missing, ambiguous, and unknown attachment references', async () => {
    const context = ctx({ threadFiles: threadFiles({}) });
    const cases: Array<[Record<string, string>, string]> = [
      [{ path: '/workspace/missing.pdf' }, 'Check that the file exists'],
      [{ path: 'relative.pdf' }, 'use an absolute file path'],
      [{ threadFileId: FILE_ID }, 'Save it again with drive.export_file'],
      [{ threadFileId: 'not-an-id' }, 'is not a thread file ID'],
      [{ threadFileId: FILE_ID, path: '/workspace/a.pdf' }, 'give exactly one of threadFileId or path'],
    ];
    for (const [ref, message] of cases) {
      const result = await action('gmail.create_draft').execute({ ...draftArgs, attachments: [ref] }, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain(message);
    }
    const noStore = await action('gmail.create_draft').execute({ ...draftArgs, attachments: [{ threadFileId: FILE_ID }] }, ctx());
    expect(noStore.error).toContain('Attach the file by its path instead');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads a large draft with the resumable upload protocol', async () => {
    const large = new Uint8Array(SIMPLE_REQUEST_MAX_BYTES + 1024).fill(7);
    const { sandbox } = sandboxWith({ '/workspace/deck.pdf': large });
    const session = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=resumable&upload_id=abc';
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200, headers: { Location: session } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'd2', message: { id: 'm2', threadId: 'th2' } }));

    const result = await action('gmail.create_draft').execute({ ...draftArgs, attachments: [{ path: '/workspace/deck.pdf' }] }, ctx({ sandbox: sandbox as Sandbox }));

    expect(result).toMatchObject({ success: true, data: { draftId: 'd2' } });
    const [startUrl, start] = fetchMock.mock.calls[0];
    expect(startUrl).toBe('https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=resumable');
    expect(start.method).toBe('POST');
    expect(start.headers['X-Upload-Content-Type']).toBe('message/rfc822');
    expect(requestBody(start)).toEqual({ message: {} });
    const [uploadUrl, upload] = fetchMock.mock.calls[1];
    expect(String(uploadUrl)).toBe(session);
    expect(upload.method).toBe('PUT');
    expect(upload.headers['Content-Type']).toBe('message/rfc822');
    expect(upload.headers.Authorization).toBe('Bearer test-token');
    const sent = Buffer.from(upload.body).toString('latin1');
    expect(Number(start.headers['X-Upload-Content-Length'])).toBe(upload.body.byteLength);
    expect(upload.headers['Content-Range']).toBe(`bytes 0-${upload.body.byteLength - 1}/${upload.body.byteLength}`);
    expect(sent).toContain('Subject: Contract');
    expect(sent).toContain(base64Of(large).slice(0, 76));
  });

  it('does not send the token to an upload URL outside Google', async () => {
    const { sandbox } = sandboxWith({ '/workspace/deck.pdf': new Uint8Array(SIMPLE_REQUEST_MAX_BYTES + 1) });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200, headers: { Location: 'https://attacker.example/upload' } }));
    const result = await action('gmail.create_draft').execute({ ...draftArgs, attachments: [{ path: '/workspace/deck.pdf' }] }, ctx({ sandbox: sandbox as Sandbox }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('valid upload URL');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adds files to an existing draft and keeps its content and thread', async () => {
    const existing = buildMimeMessage({ to: ['client@example.com'], subject: 'Contract', body: 'Draft body', inReplyTo: '<orig@example.com>' });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'd1', message: { id: 'm1', threadId: 'th1', payload: { mimeType: 'multipart/alternative', parts: [] } } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'd1', message: { id: 'm1', threadId: 'th1', raw: Buffer.from(existing, 'utf8').toString('base64url') } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'd1', message: { id: 'm3', threadId: 'th1' } }));

    const result = await action('gmail.add_draft_attachments').execute(
      { draftId: 'd1', attachments: [{ threadFileId: FILE_ID, filename: 'MSA.pdf' }] },
      ctx({ threadFiles: threadFiles({ [FILE_ID]: { name: 'Agreement.pdf', mimeType: 'application/pdf', data: agreement } }) }),
    );

    expect(result).toMatchObject({ success: true, data: { draftId: 'd1', added: [{ filename: 'MSA.pdf', bytes: agreement.byteLength }] } });
    expect(fetchMock.mock.calls[0][0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1?format=full');
    expect(fetchMock.mock.calls[1][0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1?format=raw');
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1');
    expect(init.method).toBe('PUT');
    expect(requestBody(init).message).toMatchObject({ threadId: 'th1' });
    const mime = rawOf(init);
    expect(mime).toContain('In-Reply-To: <orig@example.com>');
    expect(mime).toContain('Draft body');
    expect(mime).toContain('filename="MSA.pdf"');
    expect(mime).toContain(base64Of(agreement));
  });

  it("counts a draft's existing files against the 25 MB limit", async () => {
    const existing = buildMimeMessage({ to: ['client@example.com'], subject: 'Contract', body: 'Draft body' });
    const payload = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative' }, { filename: 'old.zip', body: { attachmentId: 'a1', size: GMAIL_ATTACHMENT_LIMIT_BYTES - 2 } }] };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'd1', message: { id: 'm1', threadId: 'th1', payload } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'd1', message: { id: 'm1', threadId: 'th1', raw: Buffer.from(existing, 'utf8').toString('base64url') } }));
    const { sandbox } = sandboxWith({ '/workspace/SOW.pdf': sow });
    const result = await action('gmail.add_draft_attachments').execute({ draftId: 'd1', attachments: [{ path: '/workspace/SOW.pdf' }] }, ctx({ sandbox: sandbox as Sandbox }));
    expect(result.success).toBe(false);
    expect(result.error).toContain("over Gmail's 25 MB limit");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
