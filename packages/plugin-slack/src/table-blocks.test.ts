import { describe, expect, it } from 'vitest';
import { tablesToTableBlocks } from './table-blocks.js';

const raw = (text: string) => ({ type: 'raw_text', text });
const cell = (...elements: Record<string, unknown>[]) => ({
  type: 'rich_text',
  elements: [{ type: 'rich_text_section', elements }],
});
const text = (value: string, style?: Record<string, boolean>) => (style ? { type: 'text', text: value, style } : { type: 'text', text: value });
const link = (url: string, label: string, style?: Record<string, boolean>) => (style ? { type: 'link', url, text: label, style } : { type: 'link', url, text: label });
const column = (align = 'left') => ({ align, is_wrapped: true });
const blank = cell(text(' '));

describe('tablesToTableBlocks', () => {
  it('renders a release table as a native table block after the prose', () => {
    const source = '**Release infrastructure changes**\n\n| Mono PR | Merged | Description |\n|---|---|---|\n| [tkhq/mono#8240](https://github.com/tkhq/mono/pull/8240) | | Per-instance credentials |';
    expect(tablesToTableBlocks(source, 50)).toEqual([
      { type: 'markdown', text: '**Release infrastructure changes**' },
      {
        type: 'table',
        column_settings: [column(), column(), column()],
        rows: [
          [raw('Mono PR'), raw('Merged'), raw('Description')],
          [cell(link('https://github.com/tkhq/mono/pull/8240', 'tkhq/mono#8240')), blank, cell(text('Per-instance credentials'))],
        ],
      },
    ]);
  });

  it.each(['<br>', '<br/>', '<br />', '<BR>'])('turns %s inside a cell into one line per entry', (br) => {
    const source = `| PR | Related |\n|-|-|\n| a | [#1](https://x/1)${br}[#2](https://x/2) ${br} plain |`;
    const blocks = tablesToTableBlocks(source, 50);
    expect(blocks?.[0]).toMatchObject({
      rows: [[raw('PR'), raw('Related')], [cell(text('a')), cell(
        link('https://x/1', '#1'), text('\n'), link('https://x/2', '#2'), text('\n'), text('plain'),
      )]],
    });
  });

  it('maps inline formatting to rich text styles', () => {
    const source = '| Cell |\n|-|\n| **Bold** and _it_ and `co\\|de` then **[#1](https://x/1)** |';
    expect(tablesToTableBlocks(source, 50)?.[0]).toMatchObject({
      rows: [[raw('Cell')], [cell(
        text('Bold', { bold: true }), text(' and '), text('it', { italic: true }), text(' and '),
        text('co|de', { code: true }), text(' then '), link('https://x/1', '#1', { bold: true }),
      )]],
    });
  });

  it('pads short rows and blanks empty cells so Slack accepts them', () => {
    const source = '| a | b | c |\n|-|-|-|\n| 1 |\n| | 2 | 3 | 4 |';
    expect(tablesToTableBlocks(source, 50)?.[0]).toMatchObject({
      column_settings: [column(), column(), column(), column()],
      rows: [
        [raw('a'), raw('b'), raw('c'), raw('Column 4')],
        [cell(text('1')), blank, blank, blank],
        [blank, cell(text('2')), cell(text('3')), cell(text('4'))],
      ],
    });
  });

  it('strips formatting from header cells and joins their line breaks', () => {
    const source = '| **Mono**<br>PR | [Docs](https://x) |\n|-|-|\n| 1 | 2 |';
    expect(tablesToTableBlocks(source, 50)?.[0]).toMatchObject({
      rows: [[raw('Mono PR'), raw('Docs')], [cell(text('1')), cell(text('2'))]],
    });
  });

  it('reads column alignment from the delimiter row', () => {
    const source = '| a | b | c | d |\n|:-|:-:|-:|-|\n| 1 | 2 | 3 | 4 |';
    expect(tablesToTableBlocks(source, 50)?.[0]).toMatchObject({
      column_settings: [column('left'), column('center'), column('right'), column('left')],
    });
  });

  it('keeps prose between and after tables as Markdown blocks', () => {
    const source = 'Intro\n\n| a |\n|-|\n| 1 |\n\nMiddle _note_\n\n| b |\n|-|\n| 2 |\n\n- tail';
    const blocks = tablesToTableBlocks(source, 50);
    expect(blocks?.map((block) => block.type)).toEqual(['markdown', 'table', 'markdown', 'table', 'markdown']);
    expect(blocks?.[0]).toEqual({ type: 'markdown', text: 'Intro' });
    expect(blocks?.[2]).toEqual({ type: 'markdown', text: 'Middle _note_' });
    expect(blocks?.[4]).toEqual({ type: 'markdown', text: '- tail' });
  });

  it('leaves tables inside code fences as Markdown', () => {
    const source = '```\n| a |\n|-|\n| 1 |\n```\n\n| b |\n|-|\n| 2 |';
    const blocks = tablesToTableBlocks(source, 50);
    expect(blocks?.map((block) => block.type)).toEqual(['markdown', 'table']);
    expect(blocks?.[0]).toEqual({ type: 'markdown', text: '```\n| a |\n|-|\n| 1 |\n```' });
  });

  it('returns undefined when the text has no table', () => {
    expect(tablesToTableBlocks('just **prose**\n\na | b', 50)).toBeUndefined();
  });

  it('returns undefined for a header-only table', () => {
    expect(tablesToTableBlocks('| a | b |\n|-|-|', 50)).toBeUndefined();
  });

  it.each([
    ['101 rows', '| a |\n|-|\n' + '| x |\n'.repeat(100)],
    ['21 columns', '|' + ' a |'.repeat(21) + '\n|' + '-|'.repeat(21) + '\n|' + ' 1 |'.repeat(21)],
    ['10,001 cell characters', '| a |\n|-|\n| ' + 'x'.repeat(10_000) + ' |'],
    ['10,001 characters across two tables', '| a |\n|-|\n| ' + 'x'.repeat(6_000) + ' |\n\n| b |\n|-|\n| ' + 'y'.repeat(4_000) + ' |'],
  ])('returns undefined when a table exceeds Slack limits: %s', (_name, source) => {
    expect(tablesToTableBlocks(source, 50)).toBeUndefined();
  });

  it('accepts a table exactly at the row and character limits', () => {
    const rows = '| a |\n|-|\n' + '| x |\n'.repeat(99);
    expect(tablesToTableBlocks(rows, 50)?.[0]).toMatchObject({ type: 'table' });
    const chars = '| a |\n|-|\n| ' + 'x'.repeat(9_999) + ' |';
    expect(tablesToTableBlocks(chars, 50)?.[0]).toMatchObject({ type: 'table' });
  });

  it('returns undefined when the blocks exceed the caller budget', () => {
    const source = 'Intro\n\n| a |\n|-|\n| 1 |\n\nOutro';
    expect(tablesToTableBlocks(source, 3)).toHaveLength(3);
    expect(tablesToTableBlocks(source, 2)).toBeUndefined();
  });
});
