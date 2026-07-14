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
import { gmailPlugin } from './actions.js';

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
  return { ...makeCtx(overrides), actionId: '', service: 'gmail' };
}

function action(id: string) {
  const found = gmailPlugin.actions.find((a) => a.id === id);
  if (!found) throw new Error(`action not found: ${id}`);
  return found;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('gmail actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('send_email posts a MIME message and returns the sent message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'm1', threadId: 't1', labelIds: ['SENT'] }),
    );

    const result = await action('gmail.send_email').execute(
      { to: 'a@example.com', subject: 'Hi', body: 'hello' },
      pluginCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    const body = JSON.parse(init.body as string) as { raw: string; threadId?: string };
    expect(body.raw).toBeTruthy();
    expect(body.threadId).toBeUndefined();

    expect(result).toEqual({
      success: true,
      data: {
        id: 'm1',
        threadId: 't1',
        labelIds: ['SENT'],
        to: ['a@example.com'],
        subject: 'Hi',
        message: 'Email sent to a@example.com.',
      },
    });
  });

  it('send_email maps a 401 response to a Gmail API error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Invalid Credentials' } }), { status: 401 }),
    );

    const result = await action('gmail.send_email').execute(
      { to: 'a@example.com', subject: 'Hi', body: 'hello' },
      pluginCtx(),
    );

    expect(result).toEqual({
      success: false,
      error: 'Gmail API 401: Invalid Credentials',
    });
  });

  it('returns "Missing access token" without calling fetch when no credential is stored', async () => {
    const result = await action('gmail.send_email').execute(
      { to: 'a@example.com', subject: 'Hi', body: 'hello' },
      pluginCtx({ credentials: makeCredentials(null) }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: 'Missing access token' });
  });

  it('list_messages fetches the list then message metadata for each result', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/users/me/messages?')) {
        return jsonResponse(200, { messages: [{ id: 'm1' }], resultSizeEstimate: 1 });
      }
      if (url.includes('/users/me/messages/m1')) {
        return jsonResponse(200, {
          id: 'm1',
          threadId: 't1',
          labelIds: ['INBOX'],
          snippet: 'hi there',
          payload: {
            headers: [
              { name: 'From', value: 'a@example.com' },
              { name: 'Subject', value: 'Hello' },
            ],
          },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await action('gmail.list_messages').execute(
      { maxResults: 5, q: 'is:unread', labelIds: ['INBOX'] },
      pluginCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [listUrl] = fetchMock.mock.calls[0] as [string];
    expect(listUrl).toContain('maxResults=5');
    expect(listUrl).toContain('q=is%3Aunread');
    expect(listUrl).toContain('labelIds=INBOX');

    expect(result).toEqual({
      success: true,
      data: {
        messages: [
          {
            id: 'm1',
            threadId: 't1',
            labelIds: ['INBOX'],
            snippet: 'hi there',
            from: 'a@example.com',
            to: null,
            subject: 'Hello',
            date: null,
          },
        ],
        resultSizeEstimate: 1,
        nextPageToken: null,
      },
    });
  });

  it('get_message decodes the plain-text body and lists attachments', async () => {
    const text = 'Hello world';
    const base64url = Buffer.from(text, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'm1',
        threadId: 't1',
        labelIds: ['INBOX'],
        snippet: 'Hello',
        payload: {
          headers: [{ name: 'Subject', value: 'Hi' }],
          mimeType: 'text/plain',
          body: { data: base64url },
        },
      }),
    );

    const result = await action('gmail.get_message').execute({ messageId: 'm1' }, pluginCtx());

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=full');
    expect(result.success).toBe(true);
    const data = (result as { data: { body: { text: string }; attachments: unknown[] } }).data;
    expect(data.body.text).toBe(text);
    expect(data.attachments).toEqual([]);
  });

  it('modify_labels sends add/remove label ids', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'm1', threadId: 't1', labelIds: ['STARRED'] }),
    );

    const result = await action('gmail.modify_labels').execute(
      { messageId: 'm1', addLabelIds: ['STARRED'] },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify');
    expect(JSON.parse(init.body as string)).toEqual({ addLabelIds: ['STARRED'], removeLabelIds: undefined });
    expect(result).toEqual({
      success: true,
      data: { id: 'm1', threadId: 't1', labelIds: ['STARRED'], message: 'Labels updated on message m1.' },
    });
  });

  it('modify_labels rejects when neither addLabelIds nor removeLabelIds is set', async () => {
    const result = await action('gmail.modify_labels').execute({ messageId: 'm1' }, pluginCtx());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'Provide at least one of addLabelIds or removeLabelIds.',
    });
  });

  it('trash_message moves a message to Trash', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'm1', threadId: 't1', labelIds: ['TRASH'] }),
    );

    const result = await action('gmail.trash_message').execute({ messageId: 'm1' }, pluginCtx());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/trash');
    expect(init.method).toBe('POST');
    expect(result).toEqual({
      success: true,
      data: {
        id: 'm1',
        threadId: 't1',
        labelIds: ['TRASH'],
        message: 'Message m1 moved to Trash. Recoverable from the Trash folder in the Gmail UI.',
      },
    });
  });

  it('create_draft posts a new draft', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'd1', message: { id: 'm1', threadId: 't1' } }),
    );

    const result = await action('gmail.create_draft').execute(
      { to: 'a@example.com', subject: 'Draft', body: 'body' },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    expect(init.method).toBe('POST');
    expect(result).toEqual({
      success: true,
      data: {
        draftId: 'd1',
        messageId: 'm1',
        threadId: 't1',
        to: ['a@example.com'],
        subject: 'Draft',
        message: 'Draft created. Use send_draft with draftId="d1" to send it, or update_draft to edit it first.',
      },
    });
  });

  it('list_drafts fetches the list then draft metadata for each result', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/users/me/drafts?')) {
        return jsonResponse(200, { drafts: [{ id: 'd1' }], resultSizeEstimate: 1 });
      }
      if (url.includes('/users/me/drafts/d1')) {
        return jsonResponse(200, {
          id: 'd1',
          message: {
            id: 'm1',
            threadId: 't1',
            snippet: 'snip',
            payload: { headers: [{ name: 'Subject', value: 'Draft subject' }] },
          },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await action('gmail.list_drafts').execute({ maxResults: 10 }, pluginCtx());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      success: true,
      data: {
        drafts: [
          {
            draftId: 'd1',
            messageId: 'm1',
            threadId: 't1',
            snippet: 'snip',
            to: null,
            cc: null,
            subject: 'Draft subject',
            date: null,
          },
        ],
        resultSizeEstimate: 1,
        nextPageToken: null,
      },
    });
  });

  it('get_draft fetches a full draft', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'd1',
        message: {
          id: 'm1',
          threadId: 't1',
          labelIds: ['DRAFT'],
          snippet: 'snip',
          payload: { headers: [{ name: 'Subject', value: 'Hi' }] },
        },
      }),
    );

    const result = await action('gmail.get_draft').execute({ draftId: 'd1' }, pluginCtx());

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1?format=full');
    expect(result.success).toBe(true);
    const data = (result as { data: { draftId: string; headers: { subject: string | null } } }).data;
    expect(data.draftId).toBe('d1');
    expect(data.headers.subject).toBe('Hi');
  });

  it('update_draft replaces a draft with PUT', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'd1', message: { id: 'm1', threadId: 't1' } }),
    );

    const result = await action('gmail.update_draft').execute(
      { draftId: 'd1', to: 'a@example.com', subject: 'Updated', body: 'new body' },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1');
    expect(init.method).toBe('PUT');
    expect(result).toEqual({
      success: true,
      data: {
        draftId: 'd1',
        messageId: 'm1',
        threadId: 't1',
        to: ['a@example.com'],
        subject: 'Updated',
        message: 'Draft d1 updated.',
      },
    });
  });

  it('send_draft posts the draft id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'm1', threadId: 't1', labelIds: ['SENT'] }));

    const result = await action('gmail.send_draft').execute({ draftId: 'd1' }, pluginCtx());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ id: 'd1' });
    expect(result).toEqual({
      success: true,
      data: {
        draftId: 'd1',
        messageId: 'm1',
        threadId: 't1',
        labelIds: ['SENT'],
        message: 'Draft d1 sent. Message ID: m1.',
      },
    });
  });

  it('delete_draft issues a DELETE request', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await action('gmail.delete_draft').execute({ draftId: 'd1' }, pluginCtx());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1');
    expect(init.method).toBe('DELETE');
    expect(result).toEqual({
      success: true,
      data: { draftId: 'd1', message: 'Draft d1 permanently deleted.' },
    });
  });

  it('list_labels returns the label list', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] }),
    );

    const result = await action('gmail.list_labels').execute({}, pluginCtx());

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/labels');
    expect(result).toEqual({
      success: true,
      data: {
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system', messageListVisibility: undefined, labelListVisibility: undefined },
        ],
        count: 1,
      },
    });
  });

  it('triage_inbox fetches unread messages and computes heuristics', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/users/me/messages?')) {
        return jsonResponse(200, { messages: [{ id: 'm1' }], resultSizeEstimate: 1 });
      }
      if (url.includes('/users/me/messages/m1')) {
        return jsonResponse(200, {
          id: 'm1',
          threadId: 't1',
          labelIds: ['UNREAD'],
          snippet: 'snip',
          payload: {
            headers: [
              { name: 'From', value: 'a@example.com' },
              { name: 'Subject', value: 'Can you review this?' },
            ],
            mimeType: 'text/plain',
            body: { data: '' },
          },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await action('gmail.triage_inbox').execute({ maxResults: 5 }, pluginCtx());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [listUrl] = fetchMock.mock.calls[0] as [string];
    expect(listUrl).toContain('q=is%3Aunread');
    expect(result.success).toBe(true);
    const data = (result as {
      data: { summary: { totalUnread: number; fetched: number; actionRequestedCount: number } };
    }).data;
    expect(data.summary.totalUnread).toBe(1);
    expect(data.summary.fetched).toBe(1);
    expect(data.summary.actionRequestedCount).toBe(1);
  });
});
