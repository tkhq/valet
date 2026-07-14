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
import { docsActions } from '../docs-actions.js';

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
  const found = docsActions.find((a) => a.id === id);
  if (!found) throw new Error(`action not found: ${id}`);
  return found;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DOCS_API = 'https://docs.googleapis.com/v1';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

describe('docs actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('read_document (text) fetches the body and extracts plain text', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        body: {
          content: [
            { paragraph: { elements: [{ textRun: { content: 'Hello world' } }] } },
          ],
        },
      }),
    );

    const result = await action('docs.read_document').execute({ documentId: 'doc1' }, pluginCtx());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${DOCS_API}/documents/doc1?fields=body%28content%28paragraph%28elements%28textRun%28content%29%29%29%29%29`,
    );
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(result).toEqual({
      success: true,
      data: { content: 'Content (11 characters):\n---\nHello world' },
    });
  });

  it('read_document maps a 404 to a Docs API error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Requested entity was not found.' } }), { status: 404 }),
    );

    const result = await action('docs.read_document').execute({ documentId: 'doc1' }, pluginCtx());

    expect(result).toEqual({
      success: false,
      error: 'Docs API 404: Requested entity was not found.',
    });
  });

  it('returns "Missing access token" without calling fetch when no credential is stored', async () => {
    const result = await action('docs.read_document').execute(
      { documentId: 'doc1' },
      pluginCtx({ credentials: makeCredentials(null) }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: 'Missing access token' });
  });

  it('insert_text sends an insertText batchUpdate request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.insert_text').execute(
      { documentId: 'doc1', text: 'Hi', index: 5 },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DOCS_API}/documents/doc1:batchUpdate`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ insertText: { location: { index: 5 }, text: 'Hi' } }],
    });
    expect(result).toEqual({
      success: true,
      data: { message: 'Successfully inserted text at index 5.' },
    });
  });

  it('append_text fetches the end index then inserts before the trailing newline', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { body: { content: [{ endIndex: 20 }] } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.append_text').execute(
      { documentId: 'doc1', text: 'More text' },
      pluginCtx(),
    );

    const [, insertInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(insertInit.body as string)).toEqual({
      requests: [{ insertText: { location: { index: 19 }, text: '\nMore text' } }],
    });
    expect(result).toEqual({
      success: true,
      data: { message: 'Successfully appended text to document.' },
    });
  });

  it('modify_text replaces a range with new text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}, {}] }));

    const result = await action('docs.modify_text').execute(
      { documentId: 'doc1', target: { startIndex: 1, endIndex: 5 }, text: 'New' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [
        { deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } },
        { insertText: { location: { index: 1 }, text: 'New' } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('modify_text rejects when neither text nor style is provided', async () => {
    const result = await action('docs.modify_text').execute(
      { documentId: 'doc1', target: { startIndex: 1, endIndex: 5 } },
      pluginCtx(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'At least one of text or style must be provided.',
    });
  });

  it('delete_range deletes content and rejects an invalid range', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.delete_range').execute(
      { documentId: 'doc1', startIndex: 1, endIndex: 10 },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 10 } } }],
    });
    expect(result).toEqual({
      success: true,
      data: { message: 'Successfully deleted content in range 1-10.' },
    });

    const invalid = await action('docs.delete_range').execute(
      { documentId: 'doc1', startIndex: 10, endIndex: 5 },
      pluginCtx(),
    );
    expect(invalid).toEqual({
      success: false,
      error: 'endIndex must be greater than startIndex for deletion.',
    });
  });

  it('find_and_replace reports occurrencesChanged from the API response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { replies: [{ replaceAllText: { occurrencesChanged: 3 } }] }),
    );

    const result = await action('docs.find_and_replace').execute(
      { documentId: 'doc1', findText: 'foo', replaceText: 'bar' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [
        {
          replaceAllText: {
            containsText: { text: 'foo', matchCase: false },
            replaceText: 'bar',
          },
        },
      ],
    });
    expect(result).toEqual({
      success: true,
      data: { message: 'Replaced 3 occurrence(s) of "foo" with "bar".', occurrencesChanged: 3 },
    });
  });

  it('append_markdown inserts spacing then converts markdown to requests', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { body: { content: [{ endIndex: 10 }] } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] })); // spacing insert
    // insertMarkdown may issue one batchUpdate call per phase (insert/format);
    // stub every remaining call generically rather than pin an exact count.
    fetchMock.mockResolvedValue(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.append_markdown').execute(
      { documentId: 'doc1', markdown: '# Title' },
      pluginCtx(),
    );

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.success).toBe(true);
    const data = (result as { data: { message: string } }).data;
    expect(data.message).toContain('Successfully appended 7 characters of markdown.');
  });

  it('replace_document_with_markdown deletes existing content then inserts markdown', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { body: { content: [{ startIndex: 1, endIndex: 20 }] } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] })); // delete
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { body: { content: [{ startIndex: 1, endIndex: 2 }] } })); // after-delete fetch
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] })); // cleanup
    // insertMarkdown may issue more than one batchUpdate call (phased); stub
    // every remaining call generically rather than pin an exact count.
    fetchMock.mockResolvedValue(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.replace_document_with_markdown').execute(
      { documentId: 'doc1', markdown: 'Body' },
      pluginCtx(),
    );

    expect(result.success).toBe(true);
    const data = (result as { data: { message: string } }).data;
    expect(data.message).toContain('Successfully replaced document content with 4 characters of markdown.');
  });

  it('insert_table inserts a table via batchUpdate', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.insert_table').execute(
      { documentId: 'doc1', rows: 2, columns: 3, index: 1 },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ insertTable: { location: { index: 1 }, rows: 2, columns: 3 } }],
    });
    expect(result).toEqual({
      success: true,
      data: { message: 'Successfully inserted a 2x3 table at index 1.' },
    });
  });

  it('insert_table_with_data rejects empty data', async () => {
    const result = await action('docs.insert_table_with_data').execute(
      { documentId: 'doc1', data: [], index: 1, hasHeaderRow: false },
      pluginCtx(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'Table data must contain at least one non-empty row with at least one cell.',
    });
  });

  it('insert_table_with_data inserts the table then populates cells', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.insert_table_with_data').execute(
      { documentId: 'doc1', data: [['a', 'b']], index: 1, hasHeaderRow: false },
      pluginCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    const data = (result as { data: { message: string } }).data;
    expect(data.message).toContain('Successfully inserted a 1x2 table with data at index 1.');
  });

  it('insert_image inserts an inline image request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.insert_image').execute(
      { documentId: 'doc1', imageUrl: 'https://example.com/img.png', index: 1 },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ insertInlineImage: { location: { index: 1 }, uri: 'https://example.com/img.png' } }],
    });
    expect(result).toEqual({
      success: true,
      data: { message: 'Successfully inserted image at index 1.' },
    });
  });

  it('insert_page_break inserts a page break request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.insert_page_break').execute(
      { documentId: 'doc1', index: 1 },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ insertPageBreak: { location: { index: 1 } } }],
    });
    expect(result).toEqual({
      success: true,
      data: { message: 'Successfully inserted page break at index 1.' },
    });
  });

  it('insert_section_break defaults sectionType to NEXT_PAGE', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.insert_section_break').execute(
      { documentId: 'doc1', index: 1 },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ insertSectionBreak: { location: { index: 1 }, sectionType: 'NEXT_PAGE' } }],
    });
    expect(result).toEqual({
      success: true,
      data: { message: 'Successfully inserted NEXT_PAGE section break at index 1.' },
    });
  });

  it('add_tab posts addDocumentTab and returns the new tab properties', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        replies: [{ addDocumentTab: { tabProperties: { tabId: 't2', title: 'New Tab', index: 1 } } }],
      }),
    );

    const result = await action('docs.add_tab').execute(
      { documentId: 'doc1', title: 'New Tab' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [{ addDocumentTab: { tabProperties: { title: 'New Tab' } } }],
    });
    expect(result).toEqual({
      success: true,
      data: {
        message: 'Successfully added new tab "New Tab".',
        tabId: 't2',
        title: 'New Tab',
        index: 1,
        parentTabId: undefined,
      },
    });
  });

  it('list_tabs returns tab hierarchy with title/id', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        title: 'My Doc',
        tabs: [{ tabProperties: { tabId: 't1', title: 'Tab 1', index: 0 } }],
      }),
    );

    const result = await action('docs.list_tabs').execute({ documentId: 'doc1' }, pluginCtx());

    expect(result).toEqual({
      success: true,
      data: {
        documentTitle: 'My Doc',
        tabs: [{ id: 't1', title: 'Tab 1', index: 0 }],
      },
    });
  });

  it('rename_tab looks up the old title then updates tab properties', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { tabs: [{ tabProperties: { tabId: 't1', title: 'Old' } }] }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.rename_tab').execute(
      { documentId: 'doc1', tabId: 't1', newTitle: 'New' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [
        { updateDocumentTabProperties: { tabProperties: { tabId: 't1', title: 'New' }, fields: 'title' } },
      ],
    });
    expect(result).toEqual({
      success: true,
      data: { message: 'Successfully renamed tab from "Old" to "New".' },
    });
  });

  it('rename_tab errors when the tab is not found', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tabs: [] }));

    const result = await action('docs.rename_tab').execute(
      { documentId: 'doc1', tabId: 'missing', newTitle: 'New' },
      pluginCtx(),
    );

    expect(result).toEqual({
      success: false,
      error: 'Tab with ID "missing" not found in document.',
    });
  });

  it('apply_text_style builds an updateTextStyle request for an explicit range', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.apply_text_style').execute(
      { documentId: 'doc1', target: { startIndex: 1, endIndex: 5 }, style: { bold: true } },
      pluginCtx(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    const data = (result as { data: { message: string } }).data;
    expect(data.message).toContain('Successfully applied text style (bold) to range 1-5.');
  });

  it('apply_paragraph_style formats a paragraph by explicit range', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));

    const result = await action('docs.apply_paragraph_style').execute(
      {
        documentId: 'doc1',
        target: { startIndex: 1, endIndex: 10 },
        style: { alignment: 'CENTER' },
      },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      requests: Array<{ updateParagraphStyle: { range: unknown; paragraphStyle: unknown; fields: string } }>;
    };
    expect(body.requests[0].updateParagraphStyle.fields).toContain('alignment');
    expect(result.success).toBe(true);
  });

  it('update_section_style requires at least one option and validates the range', async () => {
    const invalidRange = await action('docs.update_section_style').execute(
      { documentId: 'doc1', startIndex: 10, endIndex: 5 },
      pluginCtx(),
    );
    expect(invalidRange).toEqual({ success: false, error: 'endIndex must be greater than startIndex.' });

    const noOptions = await action('docs.update_section_style').execute(
      { documentId: 'doc1', startIndex: 1, endIndex: 10 },
      pluginCtx(),
    );
    expect(noOptions).toEqual({
      success: false,
      error:
        'No section style options provided. Set at least one of: flipPageOrientation, sectionType, marginTop, marginBottom, marginLeft, marginRight, pageNumberStart.',
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { replies: [{}] }));
    const result = await action('docs.update_section_style').execute(
      { documentId: 'doc1', startIndex: 1, endIndex: 10, flipPageOrientation: true },
      pluginCtx(),
    );
    expect(result).toEqual({
      success: true,
      data: {
        message: 'Successfully updated section style (flipPageOrientation) for range 1-10.',
      },
    });
  });

  it('list_comments paginates through the Drive comments endpoint', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, {
        comments: [
          {
            id: 'c1',
            content: 'Nice',
            author: { displayName: 'Alice' },
            quotedFileContent: { value: 'quoted' },
            resolved: false,
            createdTime: 't1',
            replies: [],
          },
        ],
      }),
    );

    const result = await action('docs.list_comments').execute({ documentId: 'doc1' }, pluginCtx());

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(`${DRIVE_API}/files/doc1/comments?`);
    expect(result).toEqual({
      success: true,
      data: {
        comments: [
          {
            id: 'c1',
            author: 'Alice',
            content: 'Nice',
            quotedText: 'quoted',
            resolved: false,
            createdTime: 't1',
            replyCount: 0,
          },
        ],
      },
    });
  });

  it('get_comment fetches a comment with its reply thread', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'c1',
        content: 'Nice',
        author: { displayName: 'Alice' },
        resolved: false,
        createdTime: 't1',
        replies: [{ id: 'r1', author: { displayName: 'Bob' }, content: 'Thanks', createdTime: 't2' }],
      }),
    );

    const result = await action('docs.get_comment').execute(
      { documentId: 'doc1', commentId: 'c1' },
      pluginCtx(),
    );

    expect(result).toEqual({
      success: true,
      data: {
        id: 'c1',
        author: 'Alice',
        content: 'Nice',
        quotedText: null,
        resolved: false,
        createdTime: 't1',
        replies: [{ id: 'r1', author: 'Bob', content: 'Thanks', createdTime: 't2' }],
      },
    });
  });

  it('add_comment quotes the matching text range and posts to Drive comments', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        body: {
          content: [
            {
              paragraph: {
                elements: [{ startIndex: 1, endIndex: 12, textRun: { content: 'Hello world' } }],
              },
            },
          ],
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'c1' }));

    const result = await action('docs.add_comment').execute(
      { documentId: 'doc1', startIndex: 1, endIndex: 6, content: 'Comment' },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain(`${DRIVE_API}/files/doc1/comments?`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { content: string; quotedFileContent: { value: string } };
    expect(body.content).toBe('Comment');
    expect(body.quotedFileContent.value).toBe('Hello');
    expect(result).toEqual({
      success: true,
      data: { message: 'Comment added successfully. Comment ID: c1' },
    });
  });

  it('add_comment rejects an invalid range', async () => {
    const result = await action('docs.add_comment').execute(
      { documentId: 'doc1', startIndex: 10, endIndex: 5, content: 'x' },
      pluginCtx(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: 'endIndex must be greater than startIndex.' });
  });

  it('reply_to_comment posts a reply', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'r1' }));

    const result = await action('docs.reply_to_comment').execute(
      { documentId: 'doc1', commentId: 'c1', content: 'Thanks' },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DRIVE_API}/files/doc1/comments/c1/replies?fields=id,content,author,createdTime`);
    expect(JSON.parse(init.body as string)).toEqual({ content: 'Thanks' });
    expect(result).toEqual({
      success: true,
      data: { message: 'Reply added successfully. Reply ID: r1' },
    });
  });

  it('delete_comment issues a DELETE request', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await action('docs.delete_comment').execute(
      { documentId: 'doc1', commentId: 'c1' },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DRIVE_API}/files/doc1/comments/c1`);
    expect(init.method).toBe('DELETE');
    expect(result).toEqual({
      success: true,
      data: { message: 'Comment c1 has been deleted.' },
    });
  });

  it('resolve_comment posts a resolve reply', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'r1' }));

    const result = await action('docs.resolve_comment').execute(
      { documentId: 'doc1', commentId: 'c1' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ content: '', action: 'resolve' });
    expect(result).toEqual({
      success: true,
      data: { message: 'Comment c1 has been marked as resolved.' },
    });
  });

  it('find_text_index locates a text range', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        body: {
          content: [
            { paragraph: { elements: [{ startIndex: 1, endIndex: 12, textRun: { content: 'Hello world' } }] } },
          ],
        },
      }),
    );

    const result = await action('docs.find_text_index').execute(
      { documentId: 'doc1', textToFind: 'world' },
      pluginCtx(),
    );

    expect(result).toEqual({
      success: true,
      data: {
        startIndex: 7,
        endIndex: 12,
        text: 'world',
        instance: 1,
        message: 'Found "world" (instance 1) at character range [7, 12).',
      },
    });
  });

  it('find_text_index errors when the text is not found', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { body: { content: [] } }));

    const result = await action('docs.find_text_index').execute(
      { documentId: 'doc1', textToFind: 'missing' },
      pluginCtx(),
    );

    expect(result).toEqual({
      success: false,
      error: 'Could not find instance 1 of text "missing".',
    });
  });
});
