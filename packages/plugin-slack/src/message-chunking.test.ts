import { describe, expect, it } from 'vitest';
import {
  buildContentBlocks,
  normalizeSoftBreaks,
  SLACK_MARKDOWN_LIMIT,
  SLACK_TEXT_LIMIT,
} from './message-chunking.js';

/** A body long enough to take the block path, written with single newlines. */
function longSingleNewlineBody(lines = 200): string {
  return Array.from({ length: lines }, (_, i) => `Line ${i} ${'detail '.repeat(3)}`).join('\n');
}

describe('normalizeSoftBreaks', () => {
  it('converts single newlines into CommonMark hard breaks', () => {
    expect(normalizeSoftBreaks('alpha\nbravo\ncharlie')).toBe('alpha  \nbravo  \ncharlie');
  });

  it('leaves paragraph breaks alone', () => {
    expect(normalizeSoftBreaks('alpha\n\nbravo')).toBe('alpha\n\nbravo');
  });

  it('does not double-mark lines that already end in a hard break', () => {
    expect(normalizeSoftBreaks('alpha  \nbravo')).toBe('alpha  \nbravo');
    expect(normalizeSoftBreaks('alpha\\\nbravo')).toBe('alpha\\\nbravo');
  });

  it('leaves fenced code blocks byte-for-byte intact', () => {
    const text = 'before\n```ts\nconst a = 1;\nconst b = 2;\n```\nafter';
    expect(normalizeSoftBreaks(text)).toBe('before  \n```ts\nconst a = 1;\nconst b = 2;\n```\nafter');
  });

  it('leaves tables intact so the markdown block still renders them natively', () => {
    const table = '| Name | Count |\n| --- | --- |\n| a | 1 |\n| b | 2 |';
    expect(normalizeSoftBreaks(table)).toBe(table);
  });

  it('keeps a table intact when prose surrounds it', () => {
    const text = 'Summary line\n\n| Name | Count |\n| --- | --- |\n| a | 1 |\n\nTrailing note';
    expect(normalizeSoftBreaks(text)).toBe(text);
  });

  it('treats a horizontal rule as prose rather than a table delimiter', () => {
    expect(normalizeSoftBreaks('alpha\n---\nbravo')).toBe('alpha  \n---  \nbravo');
  });

  it('is a no-op for text that has no newlines', () => {
    expect(normalizeSoftBreaks('just one line')).toBe('just one line');
  });
});

describe('buildContentBlocks', () => {
  it('keeps the line structure of a >4000 char body written with single newlines', () => {
    const body = longSingleNewlineBody();
    expect(body.length).toBeGreaterThan(SLACK_TEXT_LIMIT);
    expect(body.length).toBeLessThanOrEqual(SLACK_MARKDOWN_LIMIT);

    const blocks = buildContentBlocks(body, body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('markdown');

    const rendered = blocks[0].text as string;
    const lines = rendered.split('\n');
    expect(lines).toHaveLength(200);
    // Every line but the last carries a hard break, so none of them fold together.
    for (const line of lines.slice(0, -1)) {
      expect(line.endsWith('  ')).toBe(true);
    }
    expect(rendered).toContain('Line 0');
    expect(rendered).toContain('Line 199');
  });

  it('measures the markdown limit against the text it actually sends', () => {
    // Just under the limit before normalization, over it once breaks are added.
    const lineCount = 400;
    const filler = 'y'.repeat(Math.floor(SLACK_MARKDOWN_LIMIT / lineCount) - 1);
    const body = Array.from({ length: lineCount }, () => filler).join('\n');
    expect(body.length).toBeLessThanOrEqual(SLACK_MARKDOWN_LIMIT);
    expect(normalizeSoftBreaks(body).length).toBeGreaterThan(SLACK_MARKDOWN_LIMIT);

    const blocks = buildContentBlocks(body, body);
    expect(blocks.every((b) => b.type === 'section')).toBe(true);
  });

  it('falls back to section blocks built from mrkdwn beyond the markdown limit', () => {
    const body = 'z'.repeat(SLACK_MARKDOWN_LIMIT + 1);
    const blocks = buildContentBlocks(body, 'mrkdwn version');
    expect(blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'mrkdwn version' } }]);
  });

  it('honours the block budget on the section fallback', () => {
    const body = `${'z'.repeat(SLACK_MARKDOWN_LIMIT)}\n\n${'q'.repeat(9000)}`;
    const blocks = buildContentBlocks(body, body, 2);
    expect(blocks).toHaveLength(2);
  });
});
