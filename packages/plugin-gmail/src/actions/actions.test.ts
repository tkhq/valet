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
  ToolContext,
} from '@valet/engine';
import { gmailPlugin } from './actions.js';
import { renderMarkdownToHtml } from './markdown.js';

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

function rawMime(init: RequestInit): string {
  const request = JSON.parse(init.body as string) as { raw?: string; message?: { raw: string } };
  const raw = request.raw ?? request.message?.raw;
  if (!raw) throw new Error('Expected a raw MIME message.');
  const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

function expectMultipartAlternativeMime(mime: string, plainText: string, html: string): void {
  const normalizedHtml = html.replace(/\r\n|\r|\n/g, '\r\n');
  const boundaryMatch = mime.match(/Content-Type: multipart\/alternative; boundary="([^"]+)"/);
  expect(boundaryMatch).not.toBeNull();
  if (!boundaryMatch) throw new Error('Expected a multipart boundary.');
  const boundary = boundaryMatch[1];

  expect(mime).toContain(`--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"`);
  expect(mime).toContain(`\r\n\r\n${plainText}\r\n--${boundary}`);
  expect(mime).toContain(`--${boundary}\r\nContent-Type: text/html; charset="UTF-8"`);
  expect(mime).toContain(`\r\n\r\n${normalizedHtml}\r\n--${boundary}--`);
}

describe('renderMarkdownToHtml', () => {
  it('renders supported Markdown with Docs-compatible options', () => {
    const markdown = [
      '# Heading',
      '',
      '- first',
      '- *second* with [a link](https://example.com)',
      '',
      '> quoted',
      '',
      '```ts',
      'const name = "Valet";',
      '```',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| a | b |',
      '',
      'Visit example.com and keep word_with_underscores intact.',
    ].join('\n');

    expect(renderMarkdownToHtml(markdown)).toBe(
      '<h1>Heading</h1>\n<ul>\n<li>first</li>\n<li><em>second</em> with <a href="https://example.com">a link</a></li>\n</ul>\n<blockquote>\n<p>quoted</p>\n</blockquote>\n<pre><code class="language-ts">const name = &quot;Valet&quot;;\n</code></pre>\n<table>\n<thead>\n<tr>\n<th>Name</th>\n<th>Value</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n</tbody>\n</table>\n<p>Visit <a href="http://example.com">example.com</a> and keep word_with_underscores intact.</p>\n',
    );
  });

  it('preserves soft line breaks without changing block Markdown', () => {
    expect(renderMarkdownToHtml('Best,\nAlice')).toBe('<p>Best,<br>\nAlice</p>\n');
    expect(renderMarkdownToHtml('# Heading\n\nFirst paragraph.\n\n- one\n- two')).toBe(
      '<h1>Heading</h1>\n<p>First paragraph.</p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n',
    );
  });

  it('escapes raw HTML, bare angle brackets, and preserves Unicode', () => {
    const html = renderMarkdownToHtml('<img src=x onerror=alert(1)> <script>alert(1)</script> <not-an-email> <user@example.com> café 👋');

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;not-an-email&gt;');
    expect(html).toContain('<a href="mailto:user@example.com">user@example.com</a>');
    expect(html).toContain('café 👋');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
  });
});

describe('gmail actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['gmail.send_email', 'gmail.create_draft', 'gmail.update_draft'])(
    '%s accepts non-blank bodyHtml and rejects blank bodyHtml',
    (id) => {
      const schema = action(id).parameters;
      const args = id === 'gmail.update_draft'
        ? { draftId: 'd1', to: 'a@example.com', subject: 'Hi', body: 'hello' }
        : { to: 'a@example.com', subject: 'Hi', body: 'hello' };
      expect(Value.Check(schema, { ...args, bodyHtml: '<p>HTML</p>' })).toBe(true);
      expect(Value.Check(schema, { ...args, bodyHtml: '' })).toBe(false);
      expect(Value.Check(schema, { ...args, bodyHtml: ' \n\t ' })).toBe(false);
    },
  );

  it.each([
    ['gmail.send_email', { id: 'm1', threadId: 't1', labelIds: ['SENT'] }],
    ['gmail.create_draft', { id: 'd1', message: { id: 'm1', threadId: 't1' } }],
    ['gmail.update_draft', { id: 'd1', message: { id: 'm1', threadId: 't1' } }],
  ])('%s uses non-blank bodyHtml verbatim instead of rendering Markdown', async (id, response) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, response));
    const args = id === 'gmail.update_draft'
      ? { draftId: 'd1', to: 'a@example.com', subject: 'Hi', body: '# Markdown <em>source</em>', bodyHtml: '<section>Explicit HTML</section>' }
      : { to: 'a@example.com', subject: 'Hi', body: '# Markdown <em>source</em>', bodyHtml: '<section>Explicit HTML</section>' };

    await action(id).execute(args, pluginCtx());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const mime = rawMime(init);
    expectMultipartAlternativeMime(mime, '# Markdown <em>source</em>', '<section>Explicit HTML</section>');
    expect(mime).not.toContain('&lt;em&gt;source');
  });

  it.each([
    ['gmail.send_email', { id: 'm1', threadId: 't1', labelIds: ['SENT'] }],
    ['gmail.create_draft', { id: 'd1', message: { id: 'm1', threadId: 't1' } }],
    ['gmail.update_draft', { id: 'd1', message: { id: 'm1', threadId: 't1' } }],
  ])('%s falls back to safe Markdown rendering for blank bodyHtml', async (id, response) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, response));
    const args = id === 'gmail.update_draft'
      ? { draftId: 'd1', to: 'a@example.com', subject: 'Hi', body: '<script>unsafe</script>', bodyHtml: ' \n\t ' }
      : { to: 'a@example.com', subject: 'Hi', body: '<script>unsafe</script>', bodyHtml: ' \n\t ' };

    await action(id).execute(args, pluginCtx());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expectMultipartAlternativeMime(rawMime(init), '<script>unsafe</script>', '<p>&lt;script&gt;unsafe&lt;/script&gt;</p>\n');
  });

  it.each([
    ['gmail.send_email', { id: 'm1', threadId: 't1', labelIds: ['SENT'] }],
    ['gmail.create_draft', { id: 'd1', message: { id: 'm1', threadId: 't1' } }],
    ['gmail.update_draft', { id: 'd1', message: { id: 'm1', threadId: 't1' } }],
  ])('%s preserves multiline prose in both MIME alternatives', async (id, response) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, response));
    const args = id === 'gmail.update_draft'
      ? { draftId: 'd1', to: 'a@example.com', subject: 'Hi', body: 'Best,\nAlice' }
      : { to: 'a@example.com', subject: 'Hi', body: 'Best,\nAlice' };

    await action(id).execute(args, pluginCtx());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expectMultipartAlternativeMime(rawMime(init), 'Best,\r\nAlice', '<p>Best,<br>\nAlice</p>\n');
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
    expectMultipartAlternativeMime(rawMime(init), 'hello', '<p>hello</p>\n');
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

  it('send_email normalizes bare LF to CRLF in multipart part bodies', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'm1', threadId: 't1', labelIds: ['SENT'] }),
    );

    const result = await action('gmail.send_email').execute(
      {
        to: 'a@example.com',
        subject: 'Hi',
        body: 'line one\nline two',
        bodyHtml: '<p>line one</p>\n<p>line two</p>',
      },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const mime = rawMime(init);
    expectMultipartAlternativeMime(
      mime,
      'line one\r\nline two',
      '<p>line one</p>\r\n<p>line two</p>',
    );
    expect(mime).not.toMatch(/(^|[^\r])\n/);
    expect(result.success).toBe(true);
  });

  it('keeps reply headers at the outer multipart level', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        id: 'm0',
        threadId: 't0',
        payload: { headers: [{ name: 'Message-Id', value: '<original@example.com>' }] },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'm1', threadId: 't0', labelIds: ['SENT'] }));

    await action('gmail.send_email').execute(
      { to: 'a@example.com', subject: 'Re: Hi', body: 'Reply', replyToMessageId: 'm0' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const mime = rawMime(init);
    const headers = mime.split('\r\n\r\n')[0];
    expect(headers).toContain('In-Reply-To: <original@example.com>');
    expect(headers).toContain('References: <original@example.com>');
    expect(headers).toContain('Content-Type: multipart/alternative;');
  });

  it('send_email neutralizes CRLF header injection in the subject', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'm1', threadId: 't1', labelIds: ['SENT'] }),
    );

    await action('gmail.send_email').execute(
      {
        to: 'a@example.com',
        subject: 'Hi\r\nBcc: mole@evil.com',
        body: 'hello',
      },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = rawMime(init).split('\r\n\r\n')[0];
    // No injected header line: "Bcc:" must never start a line.
    expect(headers).not.toMatch(/(^|\r\n)Bcc:/);
    expect(headers).toContain('Subject: Hi Bcc: mole@evil.com');
  });

  it('send_email neutralizes header injection in recipient addresses', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: 'm1', threadId: 't1', labelIds: ['SENT'] }),
    );

    await action('gmail.send_email').execute(
      {
        to: 'a@example.com\r\nBcc: mole@evil.com',
        subject: 'Hi\nX-Evil: 1',
        body: 'hello',
        cc: ['c@example.com\rReply-To: mole@evil.com'],
      },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = rawMime(init).split('\r\n\r\n')[0];
    // No injected header lines: the payloads survive only as inline text.
    expect(headers).not.toMatch(/(^|\r\n)Bcc:/);
    expect(headers).not.toMatch(/(^|\r\n)X-Evil:/);
    expect(headers).not.toMatch(/(^|\r\n)Reply-To:/);
    expect(headers).toContain('To: a@example.com Bcc: mole@evil.com');
    expect(headers).toContain('Cc: c@example.com Reply-To: mole@evil.com');
    expect(headers).toContain('Subject: Hi X-Evil: 1');
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
    expectMultipartAlternativeMime(rawMime(init), 'body', '<p>body</p>\n');
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
    expectMultipartAlternativeMime(rawMime(init), 'new body', '<p>new body</p>\n');
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
