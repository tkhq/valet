import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeDocsAction } from '../docs-actions.js';

/** Pull the `fields` query param out of the URL passed to a fetch mock. */
function fieldsParamFrom(fetchMock: ReturnType<typeof vi.fn>): string {
  const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
  return url.searchParams.get('fields') ?? '';
}

describe('executeDocsAction — docs.list_tabs field mask', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests only tab structure (no comment-bearing fields)', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        title: 'Doc',
        tabs: [{ tabProperties: { tabId: 't1', title: 'Tab 1', index: 0 } }],
      }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDocsAction(
      'docs.list_tabs',
      { documentId: 'doc-1' },
      { credentials: { access_token: 'token' }, userId: 'user-1' },
    );

    expect(result.success).toBe(true);
    const fields = fieldsParamFrom(fetchMock);
    // The mask must not select the full Tab resource or any comment field,
    // which the Docs API rejects unless include_comments=true.
    expect(fields).not.toMatch(/comment/i);
    expect(fields).not.toMatch(/documentTab/);
    // It must still select tab properties so ids/titles come back.
    expect(fields).toContain('tabProperties');
    expect(fields).toContain('childTabs');
  });

  it('adds scoped body content (not comments) when a character count is requested', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        title: 'Doc',
        tabs: [{
          tabProperties: { tabId: 't1', title: 'Tab 1', index: 0 },
          documentTab: { body: { content: [] } },
        }],
      }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeDocsAction(
      'docs.list_tabs',
      { documentId: 'doc-1', includeContent: true },
      { credentials: { access_token: 'token' }, userId: 'user-1' },
    );

    expect(result.success).toBe(true);
    const fields = fieldsParamFrom(fetchMock);
    expect(fields).not.toMatch(/comment/i);
    expect(fields).toContain('documentTab(body(content))');
  });
});
