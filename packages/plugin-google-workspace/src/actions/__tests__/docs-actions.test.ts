import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeDocsAction, findHeadingSection } from '../docs-actions.js';

// ─── Test document fixture ───────────────────────────────────────────────────
//
// Two HEADING_2 sections each followed by a normal-text body paragraph. Indices
// are contiguous and 1-based, matching how the Docs API reports them (each
// paragraph's content includes its trailing newline).
//
//   [1,13)   "Section One\n"   HEADING_2
//   [13,26)  "Body of one.\n"  NORMAL_TEXT
//   [26,38)  "Section Two\n"   HEADING_2
//   [38,51)  "Body of two.\n"  NORMAL_TEXT

function para(text: string, namedStyleType: string, startIndex: number) {
  const endIndex = startIndex + text.length;
  return {
    startIndex,
    endIndex,
    paragraph: {
      paragraphStyle: { namedStyleType },
      elements: [{ startIndex, endIndex, textRun: { content: text } }],
    },
  };
}

function sampleDoc() {
  return {
    documentId: 'doc-1',
    title: 'Sample',
    body: {
      content: [
        para('Section One\n', 'HEADING_2', 1),
        para('Body of one.\n', 'NORMAL_TEXT', 13),
        para('Section Two\n', 'HEADING_2', 26),
        para('Body of two.\n', 'NORMAL_TEXT', 38),
      ],
    },
    lists: {},
  };
}

// A document whose LAST paragraph is a heading with no body — a heading-only
// placeholder section, e.g. an outline ending with "Conclusion" to be filled in.
//
//   [1,7)    "Intro\n"        HEADING_2
//   [7,13)   "Body.\n"        NORMAL_TEXT
//   [13,24)  "Conclusion\n"   HEADING_2  (final paragraph, empty section)
//
// docEndIndex is 24. The empty last section's bodyStartIndex equals docEndIndex,
// so an unclamped insert would target index 24 (== segment end) and 400.
function trailingHeadingDoc() {
  return {
    documentId: 'doc-2',
    title: 'Outline',
    body: {
      content: [
        para('Intro\n', 'HEADING_2', 1),
        para('Body.\n', 'NORMAL_TEXT', 7),
        para('Conclusion\n', 'HEADING_2', 13),
      ],
    },
    lists: {},
  };
}

/**
 * Stub fetch so GET /documents/{id} returns the fixture and every
 * :batchUpdate POST records its requests. Returns the shared request log.
 */
function stubDocsApi(doc: unknown): { batchRequests: Record<string, unknown>[] } {
  const batchRequests: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (typeof url === 'string' && url.includes(':batchUpdate')) {
      const body = JSON.parse(String(options?.body ?? '{}')) as {
        requests?: Record<string, unknown>[];
      };
      batchRequests.push(...(body.requests ?? []));
      return new Response(JSON.stringify({ replies: [] }), { status: 200 });
    }
    return new Response(JSON.stringify(doc), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { batchRequests };
}

const ctx = { credentials: { access_token: 'tok' }, userId: 'u' };

/** All updateParagraphStyle requests captured, flattened. */
function paragraphStyleRequests(reqs: Record<string, unknown>[]) {
  return reqs
    .map((r) => r.updateParagraphStyle as
      | { range?: { startIndex?: number; endIndex?: number }; paragraphStyle?: { namedStyleType?: string } }
      | undefined)
    .filter((r): r is NonNullable<typeof r> => !!r);
}

describe('findHeadingSection', () => {
  it('finds an H2 section bounded by the next H2', () => {
    const section = findHeadingSection(sampleDoc().body.content, { headingText: 'Section One' });
    expect(section).not.toBeNull();
    expect(section!.headingLevel).toBe(2);
    expect(section!.bodyStartIndex).toBe(13);
    expect(section!.bodyEndIndex).toBe(26);
    expect(section!.nextBoundaryHeading).toBe('Section Two');
  });

  it('extends the last section to the end of the body (no boundary)', () => {
    const section = findHeadingSection(sampleDoc().body.content, { headingText: 'Section Two' });
    expect(section!.bodyStartIndex).toBe(38);
    // Final newline is not deletable, so the body ends one char before doc end.
    expect(section!.bodyEndIndex).toBe(50);
    expect(section!.nextBoundaryHeading).toBeNull();
  });
});

describe('executeDocsAction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('read_section_by_heading returns the section range, level and boundary', async () => {
    stubDocsApi(sampleDoc());

    const result = await executeDocsAction(
      'docs.read_section_by_heading',
      { documentId: 'doc-1', headingText: 'Section One' },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      sectionMarkdown: string;
      headingLevel: number;
      startIndex: number;
      endIndex: number;
      nextBoundaryHeading: string | null;
    };
    expect(data.headingLevel).toBe(2);
    expect(data.startIndex).toBe(13);
    expect(data.endIndex).toBe(26);
    expect(data.nextBoundaryHeading).toBe('Section Two');
    expect(data.sectionMarkdown).toContain('Body of one.');
    expect(data.sectionMarkdown).not.toContain('Section Two');
  });

  it('replace_section_by_heading replaces only the body, keeps the heading, and isolates NORMAL_TEXT', async () => {
    const { batchRequests } = stubDocsApi(sampleDoc());

    const result = await executeDocsAction(
      'docs.replace_section_by_heading',
      { documentId: 'doc-1', headingText: 'Section One', markdown: 'New body line.' },
      ctx,
    );
    expect(result.success).toBe(true);

    // Only the target section body [13,26) is deleted — the heading [1,13) and
    // the following section are untouched.
    const deletes = batchRequests
      .map((r) => (r.deleteContentRange as { range?: { startIndex?: number; endIndex?: number } } | undefined)?.range)
      .filter((r): r is { startIndex?: number; endIndex?: number } => !!r);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ startIndex: 13, endIndex: 26 });

    // Inserted body text starts at the section body start (heading preserved).
    const inserts = batchRequests
      .map((r) => r.insertText as { location?: { index?: number }; text?: string } | undefined)
      .filter((r): r is { location?: { index?: number }; text?: string } => !!r);
    expect(inserts.some((i) => i.location?.index === 13 && i.text === 'New body line.')).toBe(true);

    // CORE FIX: the plain inserted paragraph is forced to NORMAL_TEXT and is NOT
    // left to inherit the HEADING_2 it was inserted after. This assertion fails
    // against a naive insert-at-first-body-char with no style isolation.
    const paraStyles = paragraphStyleRequests(batchRequests);
    const normalReset = paraStyles.find(
      (r) => r.paragraphStyle?.namedStyleType === 'NORMAL_TEXT' && r.range?.startIndex === 13,
    );
    expect(normalReset).toBeDefined();
    expect(paraStyles.some((r) => r.paragraphStyle?.namedStyleType === 'HEADING_2')).toBe(false);
  });

  it('replace_section_by_heading with preserveHeading=false also removes the heading', async () => {
    const { batchRequests } = stubDocsApi(sampleDoc());

    const result = await executeDocsAction(
      'docs.replace_section_by_heading',
      {
        documentId: 'doc-1',
        headingText: 'Section One',
        markdown: 'Replacement.',
        preserveHeading: false,
      },
      ctx,
    );
    expect(result.success).toBe(true);

    const deletes = batchRequests
      .map((r) => (r.deleteContentRange as { range?: { startIndex?: number } } | undefined)?.range)
      .filter((r): r is { startIndex?: number } => !!r);
    // Deletion starts at the heading start (1), not the body start (13).
    expect(deletes[0]?.startIndex).toBe(1);
  });

  it('insert_markdown_at_index inserts style-isolated at the given index', async () => {
    const { batchRequests } = stubDocsApi(sampleDoc());

    const result = await executeDocsAction(
      'docs.insert_markdown_at_index',
      { documentId: 'doc-1', index: 5, markdown: 'Plain text.' },
      ctx,
    );
    expect(result.success).toBe(true);

    const inserts = batchRequests
      .map((r) => r.insertText as { location?: { index?: number }; text?: string } | undefined)
      .filter((r): r is { location?: { index?: number }; text?: string } => !!r);
    expect(inserts.some((i) => i.location?.index === 5 && i.text === 'Plain text.')).toBe(true);

    const paraStyles = paragraphStyleRequests(batchRequests);
    expect(
      paraStyles.some(
        (r) => r.paragraphStyle?.namedStyleType === 'NORMAL_TEXT' && r.range?.startIndex === 5,
      ),
    ).toBe(true);
  });

  it('replace_section_by_heading fills an empty last section as its own paragraph, leaving the heading intact', async () => {
    // trailingHeadingDoc: "Conclusion\n" is [13,24), the final paragraph.
    // docEndIndex is 24; headingEndIndex is 24.
    const { batchRequests } = stubDocsApi(trailingHeadingDoc());

    const result = await executeDocsAction(
      'docs.replace_section_by_heading',
      { documentId: 'doc-2', headingText: 'Conclusion', markdown: 'Wrapping up.' },
      ctx,
    );
    expect(result.success).toBe(true);

    // The section is empty (heading is the final paragraph), so nothing is
    // deleted — a deleteContentRange would either be a no-op or reach the
    // terminal newline and 400.
    const deletes = batchRequests
      .map((r) => (r.deleteContentRange as { range?: unknown } | undefined)?.range)
      .filter((r): r is unknown => !!r);
    expect(deletes).toHaveLength(0);

    const inserts = batchRequests
      .map((r) => r.insertText as { location?: { index?: number }; text?: string } | undefined)
      .filter((r): r is { location?: { index?: number }; text?: string } => !!r);

    // A single paragraph break is inserted at docEndIndex-1 (23) to close the
    // heading paragraph and open a fresh one below it.
    expect(inserts.some((i) => i.location?.index === 23 && i.text === '\n')).toBe(true);

    // The body is inserted into that new paragraph (at the old doc end, 24) so it
    // forms its own paragraph rather than merging onto the heading line.
    expect(inserts.some((i) => i.location?.index === 24 && i.text === 'Wrapping up.')).toBe(true);

    // CORE FIX (FINDING 1): every NORMAL_TEXT isolation range lies entirely after
    // the heading — it must NOT overlap the heading paragraph [13,24), which would
    // downgrade the heading to NORMAL_TEXT. headingEndIndex is 24.
    const headingEndIndex = 24;
    const normalRanges = paragraphStyleRequests(batchRequests).filter(
      (r) => r.paragraphStyle?.namedStyleType === 'NORMAL_TEXT',
    );
    expect(normalRanges.length).toBeGreaterThan(0);
    for (const r of normalRanges) {
      expect(r.range?.startIndex).toBeGreaterThanOrEqual(headingEndIndex);
    }
  });

  it('replace_section_by_heading with preserveHeading=false never deletes the terminal newline of an empty last section', async () => {
    // trailingHeadingDoc: "Conclusion\n" is [13,24), docEndIndex is 24. Removing
    // the heading must cap the delete at docEndIndex-1 (23); a range reaching 24
    // includes the terminal newline and the Docs API rejects it.
    const { batchRequests } = stubDocsApi(trailingHeadingDoc());

    const result = await executeDocsAction(
      'docs.replace_section_by_heading',
      {
        documentId: 'doc-2',
        headingText: 'Conclusion',
        markdown: 'Wrapping up.',
        preserveHeading: false,
      },
      ctx,
    );
    expect(result.success).toBe(true);

    const deletes = batchRequests
      .map((r) => (r.deleteContentRange as { range?: { startIndex?: number; endIndex?: number } } | undefined)?.range)
      .filter((r): r is { startIndex?: number; endIndex?: number } => !!r);
    // FINDING 2: any emitted delete stops at or below docEndIndex-1 (23).
    for (const range of deletes) {
      expect(range.endIndex).toBeLessThanOrEqual(23);
      expect(range.endIndex).not.toBe(24);
    }
  });

  it('insert_markdown_at_index clamps an index at the document end to docEndIndex-1', async () => {
    const { batchRequests } = stubDocsApi(sampleDoc());

    // sampleDoc docEndIndex is 51; index 51 is the segment end and must be clamped.
    const result = await executeDocsAction(
      'docs.insert_markdown_at_index',
      { documentId: 'doc-1', index: 51, markdown: 'Tail.' },
      ctx,
    );
    expect(result.success).toBe(true);

    const inserts = batchRequests
      .map((r) => r.insertText as { location?: { index?: number }; text?: string } | undefined)
      .filter((r): r is { location?: { index?: number }; text?: string } => !!r);
    expect(inserts.some((i) => i.location?.index === 50 && i.text === 'Tail.')).toBe(true);
    expect(inserts.some((i) => i.location?.index === 51)).toBe(false);
  });

  it('read_section_by_heading errors when neither headingText nor headingId is given', async () => {
    stubDocsApi(sampleDoc());
    const result = await executeDocsAction(
      'docs.read_section_by_heading',
      { documentId: 'doc-1' },
      ctx,
    );
    expect(result.success).toBe(false);
  });

  it('replace_section_by_heading errors when the heading is not found', async () => {
    stubDocsApi(sampleDoc());
    const result = await executeDocsAction(
      'docs.replace_section_by_heading',
      { documentId: 'doc-1', headingText: 'Nonexistent', markdown: 'x' },
      ctx,
    );
    expect(result.success).toBe(false);
  });
});
