/**
 * Google Docs actions — 26 total (read/write, content insertion, tabs,
 * formatting, comments).
 *
 * Ported from the reference MCP server tools. Uses raw fetch() via
 * docs-helpers.ts and markdown conversion via docs-markdown.ts.
 * Comments use the Drive API v3 (not the Docs API).
 */

import { Type } from 'typebox';
import type { Static, TSchema } from 'typebox';
import type {
  PluginAction,
  PluginActionContext,
  PluginActionResult,
} from '@valet/engine';
import {
  docsFetch,
  driveFetchForDocs,
  apiError,
  normalizeDocumentId,
  executeBatchUpdate,
  executeBatchUpdateWithSplitting,
  findTextRange,
  findTabById,
  getAllTabs,
  getTabTextLength,
  getParagraphRange,
  buildUpdateTextStyleRequest,
  buildUpdateParagraphStyleRequest,
  createTable,
  insertInlineImage,
} from './docs-helpers.js';
import type { DocsRequest } from './docs-markdown.js';
import {
  docsJsonToMarkdown,
  insertMarkdown,
  formatInsertResult,
} from './docs-markdown.js';
import type { DocsBody, DocsLists } from './docs-markdown.js';

/**
 * Curried action builder. The first call binds T from the parameters
 * schema; the second call types `execute`'s args via Static<T>. Splitting
 * the inference into two phases sidesteps TS's contextual-inference depth
 * limit, which otherwise gives up on `args: any` once the file gets long.
 */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction['riskLevel'];
    execute: (
      args: Static<TParams>,
      ctx: PluginActionContext,
    ) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

// ─── Credential Helper ─────────────────────────────────────────────────────────

async function getAccessToken(ctx: PluginActionContext): Promise<string> {
  const cred = await ctx.credentials.get();
  return cred?.accessToken ?? '';
}

// ─── Shared style schemas ────────────────────────────────────────────────────

const textStyleSchema = Type.Object({
  bold: Type.Optional(Type.Boolean()),
  italic: Type.Optional(Type.Boolean()),
  underline: Type.Optional(Type.Boolean()),
  strikethrough: Type.Optional(Type.Boolean()),
  fontSize: Type.Optional(Type.Number()),
  fontFamily: Type.Optional(Type.String()),
  foregroundColor: Type.Optional(Type.String()),
  backgroundColor: Type.Optional(Type.String()),
  linkUrl: Type.Optional(Type.String()),
});

const paragraphStyleSchema = Type.Object({
  alignment: Type.Optional(
    Type.Union([Type.Literal('START'), Type.Literal('END'), Type.Literal('CENTER'), Type.Literal('JUSTIFIED')]),
  ),
  indentStart: Type.Optional(Type.Number()),
  indentEnd: Type.Optional(Type.Number()),
  spaceAbove: Type.Optional(Type.Number()),
  spaceBelow: Type.Optional(Type.Number()),
  namedStyleType: Type.Optional(
    Type.Union([
      Type.Literal('NORMAL_TEXT'),
      Type.Literal('TITLE'),
      Type.Literal('SUBTITLE'),
      Type.Literal('HEADING_1'),
      Type.Literal('HEADING_2'),
      Type.Literal('HEADING_3'),
      Type.Literal('HEADING_4'),
      Type.Literal('HEADING_5'),
      Type.Literal('HEADING_6'),
    ]),
  ),
  keepWithNext: Type.Optional(Type.Boolean()),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Raw doc JSON from API
type DocJson = Record<string, any>;

/** Fetch a full document and return the parsed JSON. */
async function fetchDocument(
  token: string,
  documentId: string,
  options?: { includeTabsContent?: boolean; fields?: string },
): Promise<{ ok: true; doc: DocJson } | { ok: false; result: PluginActionResult }> {
  const qs = new URLSearchParams();
  if (options?.fields) qs.set('fields', options.fields);
  if (options?.includeTabsContent) qs.set('includeTabsContent', 'true');

  const qsStr = qs.toString();
  const path = `/documents/${encodeURIComponent(documentId)}${qsStr ? `?${qsStr}` : ''}`;
  const res = await docsFetch(path, token);
  if (!res.ok) {
    return { ok: false, result: await apiError(res, 'Docs') };
  }
  return { ok: true, doc: (await res.json()) as DocJson };
}

/** Get the body content from a doc response, optionally from a specific tab. */
function getBodyContent(
  doc: DocJson,
  tabId?: string,
): { body: unknown[]; lists?: DocsLists } | { error: string } {
  if (tabId) {
    const tab = findTabById(doc, tabId);
    if (!tab) return { error: `Tab with ID "${tabId}" not found in document.` };
    const dt = (tab as DocJson).documentTab as
      | { body?: { content?: unknown[] }; lists?: DocsLists }
      | undefined;
    if (!dt?.body?.content) {
      return { error: `Tab "${tabId}" does not have content.` };
    }
    return { body: dt.body.content, lists: dt.lists };
  }
  const body = (doc.body as { content?: unknown[] })?.content;
  if (!body) return { error: 'Document has no body content.' };
  return { body, lists: doc.lists as DocsLists | undefined };
}

/** Get the end index (last element's endIndex) from body content. */
function getEndIndex(bodyContent: unknown[]): number {
  if (bodyContent.length === 0) return 1;
  const lastElement = bodyContent[bodyContent.length - 1] as { endIndex?: number };
  return lastElement.endIndex ?? 1;
}

/** Extract plain text from body content elements. */
function extractPlainText(bodyContent: unknown[]): string {
  let text = '';
  for (const element of bodyContent as Record<string, unknown>[]) {
    const para = element.paragraph as { elements?: Record<string, unknown>[] } | undefined;
    if (para?.elements) {
      for (const pe of para.elements) {
        const textRun = pe.textRun as { content?: string } | undefined;
        if (textRun?.content) {
          text += textRun.content;
        }
      }
    }
    const table = element.table as { tableRows?: Record<string, unknown>[] } | undefined;
    if (table?.tableRows) {
      for (const row of table.tableRows) {
        const cells = (row as { tableCells?: Record<string, unknown>[] }).tableCells;
        if (cells) {
          for (const cell of cells) {
            const content = (cell as { content?: unknown[] }).content;
            if (content) {
              text += extractPlainText(content);
            }
          }
        }
      }
    }
  }
  return text;
}

// ─── docs.read_document ────────────────────────────────────────────────────

const readDocument = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    format: Type.Optional(
      Type.Union([Type.Literal('text'), Type.Literal('json'), Type.Literal('markdown')], {
        default: 'text',
      }),
    ),
    maxLength: Type.Optional(Type.Number({ description: 'Maximum character limit for output' })),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.read_document',
  name: 'Read Document',
  description:
    'Read document content as text, markdown, or JSON (JSON includes character indices for surgical editing)',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);
      const format = p.format ?? 'text';
      const needsTabsContent = !!p.tabId;

      // Determine fields to fetch
      const fields =
        format === 'json' || format === 'markdown'
          ? '*'
          : 'body(content(paragraph(elements(textRun(content)))))';

      const fetchResult = await fetchDocument(token, docId, {
        includeTabsContent: needsTabsContent,
        fields: needsTabsContent ? '*' : fields,
      });
      if (!fetchResult.ok) return fetchResult.result;
      const doc = fetchResult.doc;

      // Resolve content source (tab or root body)
      let contentSource: DocJson;
      if (p.tabId) {
        const tab = findTabById(doc, p.tabId);
        if (!tab) {
          return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
        }
        const dt = (tab as DocJson).documentTab;
        if (!dt) {
          return {
            success: false,
            error: `Tab "${p.tabId}" does not have content (may not be a document tab).`,
          };
        }
        contentSource = { body: dt.body, lists: dt.lists };
      } else {
        contentSource = doc;
      }

      // JSON format
      if (format === 'json') {
        // Strip top-level metadata and empty objects to reduce output size.
        // documentStyle, namedStyles, revisionId, suggestedNamedStylesChanges,
        // etc. add significant bulk but aren't useful for editing operations.
        const slimSource = { ...(contentSource as Record<string, unknown>) };
        delete slimSource.documentStyle;
        delete slimSource.namedStyles;
        delete slimSource.revisionId;
        delete slimSource.documentId;
        delete slimSource.suggestedDocumentStyleChanges;
        delete slimSource.suggestedNamedStylesChanges;
        // Keep inlineObjects and positionedObjects -- paragraph elements
        // reference these by ID for inline/anchored images.
        delete slimSource.headers;
        delete slimSource.footers;
        delete slimSource.footnotes;

        const jsonContent = JSON.stringify(
          slimSource,
          (_key, value) => {
            // Prune empty objects (e.g. textStyle: {}, paragraphStyle: {})
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              if (Object.keys(value).length === 0) return undefined;
            }
            return value;
          },
          2,
        );
        if (p.maxLength && jsonContent.length > p.maxLength) {
          return {
            success: true,
            data: {
              content:
                jsonContent.substring(0, p.maxLength) +
                `\n... [JSON truncated: ${jsonContent.length} total chars]`,
            },
          };
        }
        return { success: true, data: { content: jsonContent } };
      }

      // Markdown format
      if (format === 'markdown') {
        const body = (contentSource.body ?? {}) as DocsBody;
        const lists = contentSource.lists as DocsLists | undefined;
        const markdownContent = docsJsonToMarkdown(body, lists);
        const totalLength = markdownContent.length;

        if (p.maxLength && totalLength > p.maxLength) {
          return {
            success: true,
            data: {
              content:
                markdownContent.substring(0, p.maxLength) +
                `\n\n... [Markdown truncated to ${p.maxLength} chars of ${totalLength} total.]`,
            },
          };
        }
        return { success: true, data: { content: markdownContent } };
      }

      // Text format (default)
      const bodyContent = (contentSource.body as { content?: unknown[] })?.content;
      if (!bodyContent) {
        return { success: true, data: { content: 'Document found, but appears empty.' } };
      }

      const textContent = extractPlainText(bodyContent);
      if (!textContent.trim()) {
        return { success: true, data: { content: 'Document found, but appears empty.' } };
      }

      const totalLength = textContent.length;
      if (p.maxLength && totalLength > p.maxLength) {
        return {
          success: true,
          data: {
            content:
              `Content (truncated to ${p.maxLength} chars of ${totalLength} total):\n---\n` +
              textContent.substring(0, p.maxLength) +
              `\n\n... [Document continues for ${totalLength - p.maxLength} more characters.]`,
          },
        };
      }

      return {
        success: true,
        data: { content: `Content (${totalLength} characters):\n---\n${textContent}` },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.insert_text ───────────────────────────────────────────────────────

const insertText = action(
  Type.Object({
    documentId: Type.String(),
    text: Type.String({ minLength: 1 }),
    index: Type.Integer({ minimum: 1 }),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.insert_text',
  name: 'Insert Text',
  description: 'Insert text at a specific 1-based character index',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      // Verify tab exists if specified
      if (p.tabId) {
        const tabCheck = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields: 'tabs(tabProperties,documentTab)',
        });
        if (!tabCheck.ok) return tabCheck.result;
        const tab = findTabById(tabCheck.doc, p.tabId);
        if (!tab) {
          return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
        }
      }

      const location: Record<string, unknown> = { index: p.index };
      if (p.tabId) location.tabId = p.tabId;

      const request: DocsRequest = {
        insertText: { location, text: p.text },
      };

      const batchResult = await executeBatchUpdate(docId, token, [request]);
      if (!batchResult.success) {
        return { success: false, error: batchResult.error || 'Failed to insert text' };
      }

      return {
        success: true,
        data: {
          message: `Successfully inserted text at index ${p.index}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.append_text ───────────────────────────────────────────────────────

const appendText = action(
  Type.Object({
    documentId: Type.String(),
    text: Type.String({ minLength: 1 }),
    addNewlineIfNeeded: Type.Optional(Type.Boolean({ default: true })),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.append_text',
  name: 'Append Text',
  description: 'Append plain text to the end of a document',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      // Get the current document body
      const fetchResult = await fetchDocument(token, docId, {
        includeTabsContent: !!p.tabId,
        fields: p.tabId ? 'tabs' : 'body(content(endIndex))',
      });
      if (!fetchResult.ok) return fetchResult.result;

      const bodyResult = getBodyContent(fetchResult.doc, p.tabId);
      if ('error' in bodyResult) return { success: false, error: bodyResult.error };

      let endIndex = getEndIndex(bodyResult.body);
      // Insert before the final newline
      endIndex = Math.max(1, endIndex - 1);

      const textToInsert = ((p.addNewlineIfNeeded ?? true) && endIndex > 1 ? '\n' : '') + p.text;
      if (!textToInsert) {
        return { success: true, data: { message: 'Nothing to append.' } };
      }

      const location: Record<string, unknown> = { index: endIndex };
      if (p.tabId) location.tabId = p.tabId;

      const request: DocsRequest = {
        insertText: { location, text: textToInsert },
      };
      const batchResult = await executeBatchUpdate(docId, token, [request]);
      if (!batchResult.success) {
        return { success: false, error: batchResult.error || 'Failed to append text' };
      }

      return {
        success: true,
        data: {
          message: `Successfully appended text to ${p.tabId ? `tab ${p.tabId} in ` : ''}document.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.modify_text ───────────────────────────────────────────────────────

const modifyTextTarget = Type.Union([
  Type.Object({
    startIndex: Type.Integer({ minimum: 1 }),
    endIndex: Type.Integer({ minimum: 1 }),
  }),
  Type.Object({
    textToFind: Type.String({ minLength: 1 }),
    matchInstance: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  Type.Object({
    insertionIndex: Type.Integer({ minimum: 1 }),
  }),
]);

const modifyText = action(
  Type.Object({
    documentId: Type.String(),
    target: modifyTextTarget,
    text: Type.Optional(Type.String()),
    style: Type.Optional(textStyleSchema),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.modify_text',
  name: 'Modify Text',
  description:
    'Replace, insert, or format text in one atomic operation. Target by character range, text search, or insertion index.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      if (p.text === undefined && p.style === undefined) {
        return { success: false, error: 'At least one of text or style must be provided.' };
      }

      const docId = normalizeDocumentId(p.documentId);

      // Verify tab exists if specified
      if (p.tabId) {
        const tabCheck = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields: 'tabs(tabProperties,documentTab)',
        });
        if (!tabCheck.ok) return tabCheck.result;
        const tab = findTabById(tabCheck.doc, p.tabId);
        if (!tab) {
          return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
        }
      }

      // Resolve target to numeric indices
      let startIndex: number;
      let endIndex: number | undefined;

      if ('insertionIndex' in p.target) {
        if (p.text === undefined) {
          return {
            success: false,
            error: 'text is required when using insertionIndex target (no existing range to format).',
          };
        }
        startIndex = p.target.insertionIndex;
        endIndex = undefined;
      } else if ('textToFind' in p.target) {
        const range = await findTextRange(
          token,
          docId,
          p.target.textToFind,
          p.target.matchInstance ?? 1,
          p.tabId,
        );
        if (!range) {
          return {
            success: false,
            error: `Could not find instance ${p.target.matchInstance ?? 1} of text "${p.target.textToFind}"${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          };
        }
        startIndex = range.startIndex;
        endIndex = range.endIndex;
      } else {
        startIndex = p.target.startIndex;
        endIndex = p.target.endIndex;
      }

      if (startIndex < 1) startIndex = 1;

      // Build requests
      const requests: DocsRequest[] = [];

      // 1. Delete existing content (only when replacing, not insert-only)
      if (endIndex !== undefined && p.text !== undefined) {
        const range: Record<string, unknown> = { startIndex, endIndex };
        if (p.tabId) range.tabId = p.tabId;
        requests.push({ deleteContentRange: { range } });
      }

      // 2. Insert new text
      if (p.text !== undefined) {
        const location: Record<string, unknown> = { index: startIndex };
        if (p.tabId) location.tabId = p.tabId;
        requests.push({ insertText: { location, text: p.text } });
      }

      // 3. Apply formatting
      if (p.style) {
        const formatStart = startIndex;
        const formatEnd =
          p.text !== undefined
            ? startIndex + p.text.length
            : endIndex !== undefined
              ? endIndex
              : startIndex;

        if (formatEnd > formatStart) {
          const requestInfo = buildUpdateTextStyleRequest(
            formatStart,
            formatEnd,
            p.style,
            p.tabId,
          );
          if (requestInfo) {
            requests.push(requestInfo.request);
          }
        }
      }

      if (requests.length === 0) {
        return { success: true, data: { message: 'No operations to perform.' } };
      }

      const batchResult = await executeBatchUpdate(docId, token, requests, {
        preserveOrder: true,
      });
      if (!batchResult.success) {
        return { success: false, error: batchResult.error || 'Failed to modify text' };
      }

      const actionsDone: string[] = [];
      if (endIndex !== undefined && p.text !== undefined) actionsDone.push('replaced text');
      else if (p.text !== undefined) actionsDone.push('inserted text');
      if (p.style) actionsDone.push('applied formatting');

      return {
        success: true,
        data: {
          message: `Successfully ${actionsDone.join(' and ')} at range ${startIndex}-${endIndex ?? startIndex + (p.text?.length ?? 0)}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.delete_range ──────────────────────────────────────────────────────

const deleteRange = action(
  Type.Object({
    documentId: Type.String(),
    startIndex: Type.Integer({ minimum: 1 }),
    endIndex: Type.Integer({ minimum: 1 }),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.delete_range',
  name: 'Delete Range',
  description: 'Delete content within a character range [startIndex, endIndex)',
  riskLevel: 'high',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      if (p.endIndex <= p.startIndex) {
        return { success: false, error: 'endIndex must be greater than startIndex for deletion.' };
      }

      // Verify tab exists if specified
      if (p.tabId) {
        const tabCheck = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields: 'tabs(tabProperties,documentTab)',
        });
        if (!tabCheck.ok) return tabCheck.result;
        const tab = findTabById(tabCheck.doc, p.tabId);
        if (!tab) {
          return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
        }
      }

      const range: Record<string, unknown> = {
        startIndex: p.startIndex,
        endIndex: p.endIndex,
      };
      if (p.tabId) range.tabId = p.tabId;

      const request: DocsRequest = { deleteContentRange: { range } };
      const batchResult = await executeBatchUpdate(docId, token, [request]);
      if (!batchResult.success) {
        return { success: false, error: batchResult.error || 'Failed to delete range' };
      }

      return {
        success: true,
        data: {
          message: `Successfully deleted content in range ${p.startIndex}-${p.endIndex}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.find_and_replace ──────────────────────────────────────────────────

const findAndReplace = action(
  Type.Object({
    documentId: Type.String(),
    findText: Type.String({ minLength: 1 }),
    replaceText: Type.String(),
    matchCase: Type.Optional(Type.Boolean()),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.find_and_replace',
  name: 'Find and Replace',
  description: 'Replace all occurrences of a text string throughout the document',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      const request: DocsRequest = {
        replaceAllText: {
          containsText: {
            text: p.findText,
            matchCase: p.matchCase ?? false,
          },
          replaceText: p.replaceText,
          ...(p.tabId && { tabsCriteria: { tabIds: [p.tabId] } }),
        },
      };

      const batchResult = await executeBatchUpdate(docId, token, [request]);
      if (!batchResult.success) {
        return { success: false, error: batchResult.error || 'Failed to find and replace' };
      }

      // Extract occurrencesChanged from the API response
      const responseData = batchResult.data as
        | { replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }> }
        | undefined;
      const occurrencesChanged = responseData?.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;

      return {
        success: true,
        data: {
          message: `Replaced ${occurrencesChanged} occurrence(s) of "${p.findText}" with "${p.replaceText}".`,
          occurrencesChanged,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.append_markdown ───────────────────────────────────────────────────

const appendMarkdown = action(
  Type.Object({
    documentId: Type.String(),
    markdown: Type.String({ minLength: 1 }),
    addNewlineIfNeeded: Type.Optional(Type.Boolean({ default: true })),
    tabId: Type.Optional(Type.String()),
    firstHeadingAsTitle: Type.Optional(Type.Boolean()),
  }),
)({
  id: 'docs.append_markdown',
  name: 'Append Markdown',
  description: 'Append formatted markdown content to the end of a document',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      // 1. Get document end index
      const fetchResult = await fetchDocument(token, docId, {
        includeTabsContent: !!p.tabId,
        fields: p.tabId ? 'tabs' : 'body(content(endIndex))',
      });
      if (!fetchResult.ok) return fetchResult.result;

      const bodyResult = getBodyContent(fetchResult.doc, p.tabId);
      if ('error' in bodyResult) return { success: false, error: bodyResult.error };

      let startIndex = getEndIndex(bodyResult.body) - 1;

      // 2. Add spacing if needed
      if ((p.addNewlineIfNeeded ?? true) && startIndex > 1) {
        const location: Record<string, unknown> = { index: startIndex };
        if (p.tabId) location.tabId = p.tabId;

        const spacingResult = await executeBatchUpdate(docId, token, [
          { insertText: { location, text: '\n\n' } },
        ]);
        if (!spacingResult.success) {
          return { success: false, error: spacingResult.error || 'Failed to add spacing' };
        }
        startIndex += 2;
      }

      // 3. Convert and append markdown
      const result = await insertMarkdown(token, docId, p.markdown, {
        startIndex,
        tabId: p.tabId,
        firstHeadingAsTitle: p.firstHeadingAsTitle,
      });

      const debugSummary = formatInsertResult(result);
      return {
        success: true,
        data: {
          message: `Successfully appended ${p.markdown.length} characters of markdown.\n\n${debugSummary}`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.replace_document_with_markdown ────────────────────────────────────

const replaceDocumentWithMarkdown = action(
  Type.Object({
    documentId: Type.String(),
    markdown: Type.String({ minLength: 1 }),
    preserveTitle: Type.Optional(Type.Boolean()),
    tabId: Type.Optional(Type.String()),
    firstHeadingAsTitle: Type.Optional(Type.Boolean()),
  }),
)({
  id: 'docs.replace_document_with_markdown',
  name: 'Replace Document with Markdown',
  description: 'Replace the entire document body with formatted markdown content',
  riskLevel: 'high',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      // 1. Get document structure
      const fetchResult = await fetchDocument(token, docId, {
        includeTabsContent: !!p.tabId,
        fields: p.tabId ? 'tabs' : 'body(content(startIndex,endIndex))',
      });
      if (!fetchResult.ok) return fetchResult.result;

      const bodyResult = getBodyContent(fetchResult.doc, p.tabId);
      if ('error' in bodyResult) return { success: false, error: bodyResult.error };

      // 2. Calculate replacement range
      let startIndex = 1;
      const endIndex = getEndIndex(bodyResult.body) - 1;

      if (p.preserveTitle) {
        // Find first content element that's a heading or paragraph, skip past it
        for (const element of bodyResult.body as Record<string, unknown>[]) {
          const elemEnd = (element as { endIndex?: number }).endIndex;
          if ((element as { paragraph?: unknown }).paragraph && elemEnd) {
            startIndex = elemEnd;
            break;
          }
        }
      }

      // 3. Delete existing content
      if (endIndex > startIndex) {
        const deleteRangeObj: Record<string, unknown> = { startIndex, endIndex };
        if (p.tabId) deleteRangeObj.tabId = p.tabId;

        const deleteResult = await executeBatchUpdate(docId, token, [
          { deleteContentRange: { range: deleteRangeObj } },
        ]);
        if (!deleteResult.success) {
          return { success: false, error: deleteResult.error || 'Failed to delete existing content' };
        }
      }

      // 4. Clean the surviving trailing paragraph
      //    deleteContentRange always leaves one trailing paragraph that cannot
      //    be deleted. If it has bullet list membership or text formatting from
      //    the old content, all subsequently inserted text inherits those
      //    properties. We strip both bullets and text styles from the survivor.
      {
        const afterDeleteResult = await fetchDocument(token, docId, {
          includeTabsContent: !!p.tabId,
          fields: p.tabId ? 'tabs' : 'body(content(startIndex,endIndex))',
        });
        if (!afterDeleteResult.ok) {
          // Non-fatal: proceed with insert anyway
        } else {
          const afterBody = getBodyContent(afterDeleteResult.doc, p.tabId);
          if (!('error' in afterBody)) {
            const survivorEnd = getEndIndex(afterBody.body);
            const survivorRange: Record<string, unknown> = {
              startIndex,
              endIndex: survivorEnd,
            };
            if (p.tabId) survivorRange.tabId = p.tabId;

            const cleanupRequests: DocsRequest[] = [
              { deleteParagraphBullets: { range: survivorRange } },
              {
                updateTextStyle: {
                  range: survivorRange,
                  textStyle: {
                    underline: false,
                    bold: false,
                    italic: false,
                    strikethrough: false,
                    // Explicit black — an empty foregroundColor ({}) means
                    // "no direct formatting" which the Docs renderer treats
                    // as "continue the previous run's color," causing
                    // inserted text to inherit stale colors from the old doc.
                    foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
                    backgroundColor: {},
                  },
                  fields:
                    'underline,bold,italic,strikethrough,foregroundColor,backgroundColor,link,weightedFontFamily,fontSize',
                },
              },
            ];

            // Non-fatal cleanup
            try {
              await executeBatchUpdate(docId, token, cleanupRequests, {
                preserveOrder: true,
              });
            } catch {
              // Cleanup is best-effort
            }
          }
        }
      }

      // 5. Convert markdown and insert
      const result = await insertMarkdown(token, docId, p.markdown, {
        startIndex,
        tabId: p.tabId,
        firstHeadingAsTitle: p.firstHeadingAsTitle,
      });

      const debugSummary = formatInsertResult(result);
      return {
        success: true,
        data: {
          message: `Successfully replaced document content with ${p.markdown.length} characters of markdown.\n\n${debugSummary}`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.insert_table ──────────────────────────────────────────────────────

const insertTable = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    rows: Type.Integer({ minimum: 1, description: 'Number of rows' }),
    columns: Type.Integer({ minimum: 1, description: 'Number of columns' }),
    index: Type.Integer({ minimum: 1, description: '1-based character index' }),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.insert_table',
  name: 'Insert Table',
  description: 'Insert an empty table with the specified number of rows and columns at a character index',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      if (p.tabId) {
        const tabCheck = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields: 'tabs(tabProperties,documentTab)',
        });
        if (!tabCheck.ok) return tabCheck.result;
        const tab = findTabById(tabCheck.doc, p.tabId);
        if (!tab) {
          return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
        }
      }

      const result = await createTable(token, docId, p.rows, p.columns, p.index, p.tabId);
      if (!result.success) {
        return { success: false, error: result.error || 'Failed to insert table' };
      }

      return {
        success: true,
        data: {
          message: `Successfully inserted a ${p.rows}x${p.columns} table at index ${p.index}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.insert_table_with_data ────────────────────────────────────────────

const insertTableWithData = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    data: Type.Array(Type.Array(Type.String(), { maxItems: 50 }), {
      minItems: 1,
      maxItems: 200,
      description: '2D array of strings — each inner array is one row',
    }),
    index: Type.Integer({ minimum: 1, description: '1-based character index' }),
    hasHeaderRow: Type.Optional(
      Type.Boolean({ default: false, description: 'If true, bold the first row as a header' }),
    ),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.insert_table_with_data',
  name: 'Insert Table with Data',
  description:
    'Insert a table pre-populated with data. Optionally bolds the first row as a header. Ragged rows are padded with empty cells.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      const numRows = p.data.length;
      const numCols = p.data.reduce((max, row) => Math.max(max, row.length), 0);

      if (numRows === 0 || numCols === 0) {
        return { success: false, error: 'Table data must contain at least one non-empty row with at least one cell.' };
      }

      if (p.tabId) {
        const tabCheck = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields: 'tabs(tabProperties,documentTab)',
        });
        if (!tabCheck.ok) return tabCheck.result;
        const tab = findTabById(tabCheck.doc, p.tabId);
        if (!tab) {
          return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
        }
      }

      // Pad ragged rows
      const normalizedData = p.data.map((row) => {
        const padded = [...row];
        while (padded.length < numCols) padded.push('');
        return padded;
      });

      // Build requests: insert table + populate cells + optional header bold
      const requests: DocsRequest[] = [];
      const formatRequests: DocsRequest[] = [];

      const location: Record<string, unknown> = { index: p.index };
      if (p.tabId) location.tabId = p.tabId;
      requests.push({ insertTable: { location, rows: numRows, columns: numCols } });

      // Cell index math: cellContentIndex(T, r, c, C) = T + 4 + r * (1 + 2*C) + 2*c
      let cumulativeTextLength = 0;
      for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
          const cellText = normalizedData[r][c];
          if (!cellText) continue;

          const baseCellIndex = p.index + 4 + r * (1 + 2 * numCols) + 2 * c;
          const adjustedIndex = baseCellIndex + cumulativeTextLength;

          const cellLocation: Record<string, unknown> = { index: adjustedIndex };
          if (p.tabId) cellLocation.tabId = p.tabId;

          requests.push({ insertText: { location: cellLocation, text: cellText } });

          if (p.hasHeaderRow && r === 0) {
            const styleReq = buildUpdateTextStyleRequest(
              adjustedIndex,
              adjustedIndex + cellText.length,
              { bold: true },
              p.tabId,
            );
            if (styleReq) formatRequests.push(styleReq.request);
          }

          cumulativeTextLength += cellText.length;
        }
      }

      const allRequests = [...requests, ...formatRequests];
      const meta = await executeBatchUpdateWithSplitting(token, docId, allRequests);

      return {
        success: true,
        data: {
          message: `Successfully inserted a ${numRows}x${numCols} table with data at index ${p.index}${p.tabId ? ` in tab ${p.tabId}` : ''}. ${p.hasHeaderRow ? 'Header row bolded. ' : ''}(${meta.totalRequests} requests in ${meta.totalApiCalls} API calls, ${meta.totalElapsedMs}ms)`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.insert_image ───────────────────────────────────────────────────────

const insertImage = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    imageUrl: Type.String({ format: 'uri', description: 'Publicly accessible image URL' }),
    index: Type.Integer({ minimum: 1, description: '1-based character index' }),
    width: Type.Optional(Type.Number({ minimum: 1, description: 'Width in points' })),
    height: Type.Optional(Type.Number({ minimum: 1, description: 'Height in points' })),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.insert_image',
  name: 'Insert Image',
  description: 'Insert an inline image from a publicly accessible URL at a character index',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      if (p.tabId) {
        const tabCheck = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields: 'tabs(tabProperties,documentTab)',
        });
        if (!tabCheck.ok) return tabCheck.result;
        const tab = findTabById(tabCheck.doc, p.tabId);
        if (!tab) {
          return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
        }
      }

      const result = await insertInlineImage(
        token,
        docId,
        p.imageUrl,
        p.index,
        p.width,
        p.height,
        p.tabId,
      );
      if (!result.success) {
        return { success: false, error: result.error || 'Failed to insert image' };
      }

      let sizeInfo = '';
      if (p.width && p.height) sizeInfo = ` with size ${p.width}x${p.height}pt`;

      return {
        success: true,
        data: {
          message: `Successfully inserted image at index ${p.index}${sizeInfo}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.insert_page_break ──────────────────────────────────────────────────

const insertPageBreak = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    index: Type.Integer({ minimum: 1, description: '1-based character index' }),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.insert_page_break',
  name: 'Insert Page Break',
  description: 'Insert a page break at a character index',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      if (p.tabId) {
        const tabCheck = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields: 'tabs(tabProperties,documentTab)',
        });
        if (!tabCheck.ok) return tabCheck.result;
        const tab = findTabById(tabCheck.doc, p.tabId);
        if (!tab) {
          return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
        }
      }

      const loc: Record<string, unknown> = { index: p.index };
      if (p.tabId) loc.tabId = p.tabId;

      const batchResult = await executeBatchUpdate(docId, token, [
        { insertPageBreak: { location: loc } },
      ]);
      if (!batchResult.success) {
        return { success: false, error: batchResult.error || 'Failed to insert page break' };
      }

      return {
        success: true,
        data: {
          message: `Successfully inserted page break at index ${p.index}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.insert_section_break ───────────────────────────────────────────────

const insertSectionBreak = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    index: Type.Integer({ minimum: 1, description: '1-based character index' }),
    sectionType: Type.Optional(
      Type.Union([Type.Literal('NEXT_PAGE'), Type.Literal('CONTINUOUS')], {
        default: 'NEXT_PAGE',
        description: 'Section break type',
      }),
    ),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.insert_section_break',
  name: 'Insert Section Break',
  description:
    'Insert a section break. Use NEXT_PAGE when you need a fresh page (e.g. mixing portrait/landscape). Use CONTINUOUS for inline section changes.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);
      const sectionType = p.sectionType ?? 'NEXT_PAGE';

      if (p.tabId) {
        const tabCheck = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields: 'tabs(tabProperties,documentTab)',
        });
        if (!tabCheck.ok) return tabCheck.result;
        const tab = findTabById(tabCheck.doc, p.tabId);
        if (!tab) {
          return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
        }
      }

      const loc: Record<string, unknown> = { index: p.index };
      if (p.tabId) loc.tabId = p.tabId;

      const batchResult = await executeBatchUpdate(docId, token, [
        { insertSectionBreak: { location: loc, sectionType } },
      ]);
      if (!batchResult.success) {
        return { success: false, error: batchResult.error || 'Failed to insert section break' };
      }

      return {
        success: true,
        data: {
          message: `Successfully inserted ${sectionType} section break at index ${p.index}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.add_tab ────────────────────────────────────────────────────────────

const addTab = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    title: Type.Optional(Type.String({ description: 'Title for the new tab' })),
    parentTabId: Type.Optional(
      Type.String({ description: 'ID of existing tab to nest under as a child' }),
    ),
    index: Type.Optional(
      Type.Integer({ minimum: 0, description: 'Zero-based position among sibling tabs' }),
    ),
  }),
)({
  id: 'docs.add_tab',
  name: 'Add Tab',
  description: 'Add a new tab to a document. Optionally set title, position, and parent tab for nesting.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      // Verify parent tab exists if specified
      if (p.parentTabId) {
        const tabCheck = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields: 'tabs(tabProperties,documentTab)',
        });
        if (!tabCheck.ok) return tabCheck.result;
        const parentTab = findTabById(tabCheck.doc, p.parentTabId);
        if (!parentTab) {
          return { success: false, error: `Parent tab with ID "${p.parentTabId}" not found in document.` };
        }
      }

      const tabProperties: Record<string, unknown> = {};
      if (p.title !== undefined) tabProperties.title = p.title;
      if (p.parentTabId !== undefined) tabProperties.parentTabId = p.parentTabId;
      if (p.index !== undefined) tabProperties.index = p.index;

      const res = await docsFetch(
        `/documents/${encodeURIComponent(docId)}:batchUpdate`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            requests: [{ addDocumentTab: { tabProperties } }],
          }),
        },
      );
      if (!res.ok) return await apiError(res, 'Docs batchUpdate');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resBody = (await res.json()) as any;
      const newTabProps = resBody?.replies?.[0]?.addDocumentTab?.tabProperties;

      if (newTabProps) {
        return {
          success: true,
          data: {
            message: `Successfully added new tab "${newTabProps.title || '(untitled)'}".`,
            tabId: newTabProps.tabId,
            title: newTabProps.title,
            index: newTabProps.index,
            parentTabId: newTabProps.parentTabId,
          },
        };
      }

      return { success: true, data: { message: 'Tab created but could not retrieve details.' } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.list_tabs ──────────────────────────────────────────────────────────

const listTabs = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    includeContent: Type.Optional(
      Type.Boolean({ default: false, description: 'Include character count per tab' }),
    ),
  }),
)({
  id: 'docs.list_tabs',
  name: 'List Tabs',
  description: 'List all tabs in a document with IDs, titles, and hierarchy. Use tab IDs with other tools.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);
      const includeContent = p.includeContent ?? false;

      const fields = includeContent
        ? 'title,tabs'
        : 'title,tabs(tabProperties,childTabs)';
      const fetchResult = await fetchDocument(token, docId, {
        includeTabsContent: true,
        fields,
      });
      if (!fetchResult.ok) return fetchResult.result;

      const docTitle = (fetchResult.doc.title as string) || 'Untitled Document';
      const allTabsList = getAllTabs(fetchResult.doc);

      const tabs = allTabsList.map((tab) => {
        const tp = tab.tabProperties || {};
        const tabObj: Record<string, unknown> = {
          id: tp.tabId || null,
          title: tp.title || null,
          index: tp.index ?? null,
        };
        if (tp.parentTabId) tabObj.parentTabId = tp.parentTabId;
        if (includeContent && tab.documentTab) {
          tabObj.characterCount = getTabTextLength(tab.documentTab);
        }
        return tabObj;
      });

      return { success: true, data: { documentTitle: docTitle, tabs } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.rename_tab ──────────────────────────────────────────────────────────

const renameTab = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    tabId: Type.String({ description: 'ID of the tab to rename' }),
    newTitle: Type.String({ minLength: 1, description: 'New title for the tab' }),
  }),
)({
  id: 'docs.rename_tab',
  name: 'Rename Tab',
  description: 'Rename a tab in a document',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      // Verify tab exists and get old title — include childTabs for nested tab lookup
      const tabCheck = await fetchDocument(token, docId, {
        includeTabsContent: true,
        fields: 'tabs(tabProperties,childTabs(tabProperties,childTabs(tabProperties,childTabs(tabProperties))))',
      });
      if (!tabCheck.ok) return tabCheck.result;
      const targetTab = findTabById(tabCheck.doc, p.tabId);
      if (!targetTab) {
        return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
      }
      const oldTitle =
        (targetTab as DocJson).tabProperties?.title || '(untitled)';

      const batchResult = await executeBatchUpdate(docId, token, [
        {
          updateDocumentTabProperties: {
            tabProperties: { tabId: p.tabId, title: p.newTitle },
            fields: 'title',
          },
        },
      ]);
      if (!batchResult.success) {
        return { success: false, error: batchResult.error || 'Failed to rename tab' };
      }

      return {
        success: true,
        data: {
          message: `Successfully renamed tab from "${oldTitle}" to "${p.newTitle}".`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.apply_text_style ───────────────────────────────────────────────────

const applyTextStyleTarget = Type.Union([
  Type.Object({
    startIndex: Type.Integer({ minimum: 1 }),
    endIndex: Type.Integer({ minimum: 1 }),
  }),
  Type.Object({
    textToFind: Type.String({ minLength: 1 }),
    matchInstance: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: 'Which occurrence to match (default: 1). Ignored when allOccurrences is true.',
      }),
    ),
    allOccurrences: Type.Optional(
      Type.Boolean({ description: 'Apply style to ALL occurrences of textToFind (default: false)' }),
    ),
  }),
]);

const applyTextStyle = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    target: applyTextStyleTarget,
    style: textStyleSchema,
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.apply_text_style',
  name: 'Apply Text Style',
  description:
    'Apply character-level formatting (bold, italic, color, font, etc.) to text identified by range or text search',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      // Collect all ranges to style
      const ranges: Array<{ startIndex: number; endIndex: number }> = [];

      if ('textToFind' in p.target) {
        if (p.target.allOccurrences) {
          // Find ALL occurrences and batch-style them
          let instance = 1;
          while (true) {
            // fix: cap iterations to prevent quota exhaustion / unbounded loop
            if (instance > 1000) break;
            const range = await findTextRange(token, docId, p.target.textToFind, instance, p.tabId);
            if (!range) break;
            ranges.push(range);
            instance++;
          }
          if (ranges.length === 0) {
            return {
              success: false,
              error: `Could not find any occurrences of text "${p.target.textToFind}"${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
            };
          }
        } else {
          const range = await findTextRange(
            token, docId, p.target.textToFind, p.target.matchInstance ?? 1, p.tabId,
          );
          if (!range) {
            return {
              success: false,
              error: `Could not find instance ${p.target.matchInstance ?? 1} of text "${p.target.textToFind}"${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
            };
          }
          ranges.push(range);
        }
      } else {
        ranges.push({ startIndex: p.target.startIndex, endIndex: p.target.endIndex });
      }

      // Build batch update requests for all ranges
      const requests: DocsRequest[] = [];
      let fields: string[] = [];
      for (const range of ranges) {
        if (range.endIndex <= range.startIndex) continue;
        const requestInfo = buildUpdateTextStyleRequest(range.startIndex, range.endIndex, p.style, p.tabId);
        if (requestInfo) {
          requests.push(requestInfo.request);
          fields = requestInfo.fields; // all have the same fields
        }
      }

      if (requests.length === 0) {
        const validKeys = ['bold', 'italic', 'underline', 'strikethrough', 'fontSize', 'fontFamily', 'foregroundColor', 'backgroundColor', 'linkUrl'];
        const rawStyle = (args as Record<string, unknown>)?.style;
        const unrecognized = rawStyle && typeof rawStyle === 'object'
          ? Object.keys(rawStyle).filter((k) => !validKeys.includes(k))
          : [];
        const hint = unrecognized.length > 0
          ? ` Unrecognized properties: ${unrecognized.join(', ')}. Valid style properties: ${validKeys.join(', ')}.`
          : ` Valid style properties: ${validKeys.join(', ')}.`;
        return { success: true, data: { message: `No valid text styling options were provided.${hint}` } };
      }

      const batchResult = await executeBatchUpdate(docId, token, requests);
      if (!batchResult.success) {
        return { success: false, error: batchResult.error || 'Failed to apply text style' };
      }

      const rangeDesc = ranges.length === 1
        ? `range ${ranges[0].startIndex}-${ranges[0].endIndex}`
        : `${ranges.length} occurrences`;
      return {
        success: true,
        data: {
          message: `Successfully applied text style (${fields.join(', ')}) to ${rangeDesc}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.apply_paragraph_style ──────────────────────────────────────────────

const applyParagraphStyleTarget = Type.Union([
  Type.Object({
    startIndex: Type.Integer({ minimum: 1 }),
    endIndex: Type.Integer({ minimum: 1 }),
  }),
  Type.Object({
    textToFind: Type.String({ minLength: 1 }),
    matchInstance: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  Type.Object({
    indexWithinParagraph: Type.Integer({ minimum: 1 }),
  }),
]);

const applyParagraphStyle = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    target: applyParagraphStyleTarget,
    style: paragraphStyleSchema,
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.apply_paragraph_style',
  name: 'Apply Paragraph Style',
  description:
    'Apply paragraph-level formatting (alignment, spacing, heading styles) to paragraphs identified by range, text search, or index',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      let startIndex: number | undefined;
      let endIndex: number | undefined;

      if ('textToFind' in p.target) {
        const textRange = await findTextRange(
          token,
          docId,
          p.target.textToFind,
          p.target.matchInstance ?? 1,
          p.tabId,
        );
        if (!textRange) {
          return {
            success: false,
            error: `Could not find "${p.target.textToFind}" in the document${p.tabId ? ` (tab: ${p.tabId})` : ''}.`,
          };
        }
        const paraRange = await getParagraphRange(token, docId, textRange.startIndex, p.tabId);
        if (!paraRange) {
          return { success: false, error: 'Found text but could not determine paragraph boundaries.' };
        }
        startIndex = paraRange.startIndex;
        endIndex = paraRange.endIndex;
      } else if ('indexWithinParagraph' in p.target) {
        const paraRange = await getParagraphRange(
          token,
          docId,
          p.target.indexWithinParagraph,
          p.tabId,
        );
        if (!paraRange) {
          return {
            success: false,
            error: `Could not find paragraph containing index ${p.target.indexWithinParagraph}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
          };
        }
        startIndex = paraRange.startIndex;
        endIndex = paraRange.endIndex;
      } else {
        startIndex = p.target.startIndex;
        endIndex = p.target.endIndex;
      }

      if (startIndex === undefined || endIndex === undefined) {
        return { success: false, error: 'Could not determine target paragraph range.' };
      }
      if (endIndex <= startIndex) {
        return { success: false, error: `Invalid range: endIndex (${endIndex}) must be > startIndex (${startIndex}).` };
      }

      const requestInfo = buildUpdateParagraphStyleRequest(startIndex, endIndex, p.style, p.tabId);
      if (!requestInfo) {
        return { success: true, data: { message: 'No valid paragraph styling options were provided.' } };
      }

      const batchResult = await executeBatchUpdate(docId, token, [requestInfo.request]);
      if (!batchResult.success) {
        return { success: false, error: batchResult.error || 'Failed to apply paragraph style' };
      }

      return {
        success: true,
        data: {
          message: `Successfully applied paragraph styles (${requestInfo.fields.join(', ')})${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.update_section_style ───────────────────────────────────────────────

const updateSectionStyle = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    startIndex: Type.Integer({ minimum: 1 }),
    endIndex: Type.Integer({ minimum: 1 }),
    flipPageOrientation: Type.Optional(Type.Boolean()),
    sectionType: Type.Optional(
      Type.Union([
        Type.Literal('SECTION_TYPE_UNSPECIFIED'),
        Type.Literal('CONTINUOUS'),
        Type.Literal('NEXT_PAGE'),
      ]),
    ),
    marginTop: Type.Optional(Type.Number({ minimum: 0, description: 'Points' })),
    marginBottom: Type.Optional(Type.Number({ minimum: 0, description: 'Points' })),
    marginLeft: Type.Optional(Type.Number({ minimum: 0, description: 'Points' })),
    marginRight: Type.Optional(Type.Number({ minimum: 0, description: 'Points' })),
    pageNumberStart: Type.Optional(Type.Integer({ minimum: 1 })),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.update_section_style',
  name: 'Update Section Style',
  description:
    'Update the style of a section identified by range — supports page orientation, margins, and section type',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      if (p.endIndex <= p.startIndex) {
        return { success: false, error: 'endIndex must be greater than startIndex.' };
      }

      if (p.tabId) {
        const tabCheck = await fetchDocument(token, docId, {
          includeTabsContent: true,
          fields: 'tabs(tabProperties,documentTab)',
        });
        if (!tabCheck.ok) return tabCheck.result;
        const tab = findTabById(tabCheck.doc, p.tabId);
        if (!tab) {
          return { success: false, error: `Tab with ID "${p.tabId}" not found in document.` };
        }
      }

      // Build section style
      const sectionStyle: Record<string, unknown> = {};
      const fieldsToUpdate: string[] = [];

      if (p.flipPageOrientation !== undefined) {
        sectionStyle.flipPageOrientation = p.flipPageOrientation;
        fieldsToUpdate.push('flipPageOrientation');
      }
      if (p.sectionType !== undefined) {
        sectionStyle.sectionType = p.sectionType;
        fieldsToUpdate.push('sectionType');
      }
      if (p.marginTop !== undefined) {
        sectionStyle.marginTop = { magnitude: p.marginTop, unit: 'PT' };
        fieldsToUpdate.push('marginTop');
      }
      if (p.marginBottom !== undefined) {
        sectionStyle.marginBottom = { magnitude: p.marginBottom, unit: 'PT' };
        fieldsToUpdate.push('marginBottom');
      }
      if (p.marginLeft !== undefined) {
        sectionStyle.marginLeft = { magnitude: p.marginLeft, unit: 'PT' };
        fieldsToUpdate.push('marginLeft');
      }
      if (p.marginRight !== undefined) {
        sectionStyle.marginRight = { magnitude: p.marginRight, unit: 'PT' };
        fieldsToUpdate.push('marginRight');
      }
      if (p.pageNumberStart !== undefined) {
        sectionStyle.pageNumberStart = p.pageNumberStart;
        fieldsToUpdate.push('pageNumberStart');
      }

      if (fieldsToUpdate.length === 0) {
        return {
          success: false,
          error: 'No section style options provided. Set at least one of: flipPageOrientation, sectionType, marginTop, marginBottom, marginLeft, marginRight, pageNumberStart.',
        };
      }

      const range: Record<string, unknown> = {
        startIndex: p.startIndex,
        endIndex: p.endIndex,
      };
      if (p.tabId) range.tabId = p.tabId;

      const batchResult = await executeBatchUpdate(docId, token, [
        {
          updateSectionStyle: {
            range,
            sectionStyle,
            fields: fieldsToUpdate.join(','),
          },
        },
      ]);
      if (!batchResult.success) {
        return { success: false, error: batchResult.error || 'Failed to update section style' };
      }

      return {
        success: true,
        data: {
          message: `Successfully updated section style (${fieldsToUpdate.join(', ')}) for range ${p.startIndex}-${p.endIndex}${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.list_comments ──────────────────────────────────────────────────────

const listComments = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
  }),
)({
  id: 'docs.list_comments',
  name: 'List Comments',
  description: 'List all comments in a document with IDs, authors, status, and quoted text',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allComments: any[] = [];
      let pageToken: string | undefined;
      do {
        const qs = new URLSearchParams({
          fields: 'nextPageToken,comments(id,content,quotedFileContent,author,createdTime,resolved,replies)',
          includeDeleted: 'false',
          pageSize: '100',
        });
        if (pageToken) qs.set('pageToken', pageToken);
        const res = await driveFetchForDocs(
          `/files/${encodeURIComponent(docId)}/comments?${qs}`,
          token,
        );
        if (!res.ok) return await apiError(res, 'Drive comments');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await res.json()) as any;
        allComments.push(...(data.comments ?? []));
        pageToken = data.nextPageToken;
      } while (pageToken);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const comments = allComments.map((c: any) => ({
        id: c.id,
        author: c.author?.displayName || null,
        content: c.content,
        quotedText: c.quotedFileContent?.value || null,
        resolved: c.resolved || false,
        createdTime: c.createdTime,
        replyCount: c.replies?.length || 0,
      }));

      return { success: true, data: { comments } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.get_comment ─────────────────────────────────────────────────────────

const getComment = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    commentId: Type.String({ description: 'Comment ID' }),
  }),
)({
  id: 'docs.get_comment',
  name: 'Get Comment',
  description: 'Get a specific comment and its full reply thread',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      const res = await driveFetchForDocs(
        `/files/${encodeURIComponent(docId)}/comments/${encodeURIComponent(p.commentId)}?fields=id,content,quotedFileContent,author,createdTime,resolved,replies(id,content,author,createdTime)`,
        token,
      );
      if (!res.ok) return await apiError(res, 'Drive comments');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (await res.json()) as any;
      return {
        success: true,
        data: {
          id: c.id,
          author: c.author?.displayName || null,
          content: c.content,
          quotedText: c.quotedFileContent?.value || null,
          resolved: c.resolved || false,
          createdTime: c.createdTime,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          replies: ((c.replies || []) as any[]).map((r) => ({
            id: r.id,
            author: r.author?.displayName || null,
            content: r.content,
            createdTime: r.createdTime,
          })),
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.add_comment ─────────────────────────────────────────────────────────

const addComment = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    startIndex: Type.Integer({ minimum: 1, description: 'Start of text range (inclusive, 1-based)' }),
    endIndex: Type.Integer({ minimum: 1, description: 'End of text range (exclusive)' }),
    content: Type.String({ minLength: 1, description: 'Comment text' }),
  }),
)({
  id: 'docs.add_comment',
  name: 'Add Comment',
  description: 'Add a comment anchored to a text range in the document',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      if (p.endIndex <= p.startIndex) {
        return { success: false, error: 'endIndex must be greater than startIndex.' };
      }

      // Extract the quoted text from the document
      const fetchResult = await fetchDocument(token, docId);
      if (!fetchResult.ok) return fetchResult.result;
      const bodyContent = (fetchResult.doc.body as { content?: unknown[] })?.content || [];

      let quotedText = '';
      for (const element of bodyContent as Record<string, unknown>[]) {
        const para = element.paragraph as { elements?: Record<string, unknown>[] } | undefined;
        if (para?.elements) {
          for (const pe of para.elements) {
            const textRun = pe.textRun as { content?: string } | undefined;
            const elemStart = (pe.startIndex as number) || 0;
            const elemEnd = (pe.endIndex as number) || 0;
            if (textRun?.content && elemEnd > p.startIndex && elemStart < p.endIndex) {
              const text = textRun.content;
              const startOffset = Math.max(0, p.startIndex - elemStart);
              const endOffset = Math.min(text.length, p.endIndex - elemStart);
              quotedText += text.substring(startOffset, endOffset);
            }
          }
        }
      }

      const commentRes = await driveFetchForDocs(
        `/files/${encodeURIComponent(docId)}/comments?fields=id,content,quotedFileContent,author,createdTime,resolved`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            content: p.content,
            quotedFileContent: {
              value: quotedText,
              mimeType: 'text/html',
            },
            anchor: JSON.stringify({
              r: docId,
              a: [
                {
                  txt: {
                    o: p.startIndex - 1, // Drive API uses 0-based indexing
                    l: p.endIndex - p.startIndex,
                    ml: p.endIndex - p.startIndex,
                  },
                },
              ],
            }),
          }),
        },
      );
      if (!commentRes.ok) return await apiError(commentRes, 'Drive comments');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const commentBody = (await commentRes.json()) as any;
      return {
        success: true,
        data: { message: `Comment added successfully. Comment ID: ${commentBody.id}` },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.reply_to_comment ────────────────────────────────────────────────────

const replyToComment = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    commentId: Type.String({ description: 'Comment ID to reply to' }),
    content: Type.String({ minLength: 1, description: 'Reply text' }),
  }),
)({
  id: 'docs.reply_to_comment',
  name: 'Reply to Comment',
  description: 'Add a reply to an existing comment thread',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      const res = await driveFetchForDocs(
        `/files/${encodeURIComponent(docId)}/comments/${encodeURIComponent(p.commentId)}/replies?fields=id,content,author,createdTime`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ content: p.content }),
        },
      );
      if (!res.ok) return await apiError(res, 'Drive replies');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;
      return {
        success: true,
        data: { message: `Reply added successfully. Reply ID: ${body.id}` },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.delete_comment ──────────────────────────────────────────────────────

const deleteComment = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    commentId: Type.String({ description: 'Comment ID to delete' }),
  }),
)({
  id: 'docs.delete_comment',
  name: 'Delete Comment',
  description: 'Permanently delete a comment and all its replies',
  riskLevel: 'high',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      const res = await driveFetchForDocs(
        `/files/${encodeURIComponent(docId)}/comments/${encodeURIComponent(p.commentId)}`,
        token,
        { method: 'DELETE' },
      );
      if (!res.ok) return await apiError(res, 'Drive comments');

      return {
        success: true,
        data: { message: `Comment ${p.commentId} has been deleted.` },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.resolve_comment ─────────────────────────────────────────────────────

const resolveComment = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    commentId: Type.String({ description: 'Comment ID to resolve' }),
  }),
)({
  id: 'docs.resolve_comment',
  name: 'Resolve Comment',
  description: 'Mark a comment as resolved',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);

      // Resolve by creating a reply with action: 'resolve'
      const res = await driveFetchForDocs(
        `/files/${encodeURIComponent(docId)}/comments/${encodeURIComponent(p.commentId)}/replies?fields=id`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ content: '', action: 'resolve' }),
        },
      );
      if (!res.ok) return await apiError(res, 'Drive comments');

      return {
        success: true,
        data: { message: `Comment ${p.commentId} has been marked as resolved.` },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── docs.find_text_index ─────────────────────────────────────────────────────

const findTextIndex = action(
  Type.Object({
    documentId: Type.String({ description: 'Document ID or full Google Docs URL' }),
    textToFind: Type.String({ minLength: 1, description: 'The text to search for in the document' }),
    matchInstance: Type.Optional(
      Type.Integer({ minimum: 1, description: 'Which occurrence to match (default: 1, i.e. first match)' }),
    ),
    tabId: Type.Optional(Type.String()),
  }),
)({
  id: 'docs.find_text_index',
  name: 'Find Text Index',
  description:
    'Find the character index of a text string in a document. Returns { startIndex, endIndex } for use with insert_text, modify_text, delete_range, and other index-based tools. Much lighter than reading the full document with format=json.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const docId = normalizeDocumentId(p.documentId);
      const instance = p.matchInstance ?? 1;

      const range = await findTextRange(token, docId, p.textToFind, instance, p.tabId);
      if (!range) {
        return {
          success: false,
          error: `Could not find instance ${instance} of text "${p.textToFind}"${p.tabId ? ` in tab ${p.tabId}` : ''}.`,
        };
      }

      return {
        success: true,
        data: {
          startIndex: range.startIndex,
          endIndex: range.endIndex,
          text: p.textToFind,
          instance,
          message: `Found "${p.textToFind}" (instance ${instance}) at character range [${range.startIndex}, ${range.endIndex}).`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── Export ──────────────────────────────────────────────────────────────────

export const docsActions: PluginAction[] = [
  readDocument,
  insertText,
  appendText,
  modifyText,
  deleteRange,
  findAndReplace,
  appendMarkdown,
  replaceDocumentWithMarkdown,
  insertTable,
  insertTableWithData,
  insertImage,
  insertPageBreak,
  insertSectionBreak,
  addTab,
  listTabs,
  renameTab,
  applyTextStyle,
  applyParagraphStyle,
  updateSectionStyle,
  listComments,
  getComment,
  addComment,
  replyToComment,
  deleteComment,
  resolveComment,
  findTextIndex,
];
