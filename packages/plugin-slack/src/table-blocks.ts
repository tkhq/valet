/**
 * Render Markdown pipe tables as Slack's native Block Kit `table` block.
 *
 * Slack's `markdown` block renders GFM tables, but GFM has no line break
 * inside a cell: a newline ends the row and `<br>` shows literally. A native
 * table cell holds rich text, so `<br>` in a cell becomes a real line break
 * and links, bold, italic, and code keep their formatting.
 *
 * Slack's documented limits for a table block: 100 rows, 20 columns, and
 * 10,000 characters across every cell in the message. A rich text cell must
 * hold at least one non-empty text element, or Slack rejects the whole
 * message with `invalid_blocks`. Any table outside these limits keeps the
 * existing single `markdown` block.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { splitMarkdownTables, type MarkdownTable } from './table-format.js';

/** Slack rejects a table block with more rows than this, header included. */
export const SLACK_TABLE_ROW_LIMIT = 100;

/** Slack rejects a table block with more cells per row than this. */
export const SLACK_TABLE_COLUMN_LIMIT = 20;

/** Cumulative characters across every table cell in one message. */
export const SLACK_TABLE_CHARACTER_LIMIT = 10_000;

type Block = Record<string, unknown>;

interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

interface RichTextElement {
  type: 'text' | 'link';
  text: string;
  url?: string;
  style?: TextStyle;
}

const LINE_BREAK = /<br\s*\/?>/gi;

type MarkdownNode = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];

/** Plain text of a Markdown subtree, for link labels and header cells. */
function plainText(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'html') return node.value;
  if (node.type === 'break') return '\n';
  if ('children' in node) return node.children.map(plainText).join('');
  return '';
}

/** Inline elements for one line of a cell, formatting preserved. */
function inlineElements(line: string): RichTextElement[] {
  const elements: RichTextElement[] = [];
  const emit = (element: RichTextElement): void => {
    const last = elements.at(-1);
    if (element.type === 'text' && last?.type === 'text'
      && JSON.stringify(last.style ?? {}) === JSON.stringify(element.style ?? {})) {
      last.text += element.text;
      return;
    }
    elements.push(element);
  };
  const styled = (text: string, style: TextStyle): RichTextElement =>
    Object.keys(style).length ? { type: 'text', text, style: { ...style } } : { type: 'text', text };
  const visit = (node: MarkdownNode, style: TextStyle): void => {
    switch (node.type) {
      case 'text':
      case 'html':
        emit(styled(node.value, style));
        return;
      case 'inlineCode':
        emit(styled(node.value, { ...style, code: true }));
        return;
      case 'break':
        emit({ type: 'text', text: '\n' });
        return;
      case 'strong':
        node.children.forEach((child) => visit(child, { ...style, bold: true }));
        return;
      case 'emphasis':
        node.children.forEach((child) => visit(child, { ...style, italic: true }));
        return;
      case 'link':
      case 'image': {
        const label = node.type === 'link' ? plainText(node) : node.alt ?? '';
        const element: RichTextElement = { type: 'link', url: node.url, text: label || node.url };
        if (Object.keys(style).length) element.style = { ...style };
        elements.push(element);
        return;
      }
      default:
        if ('children' in node) node.children.forEach((child) => visit(child, style));
        else if ('value' in node && typeof node.value === 'string') emit(styled(node.value, style));
    }
  };
  fromMarkdown(line).children.forEach((child) => visit(child, {}));
  return elements.filter((element) => element.text.length > 0);
}

/** Lines of a cell, split on `<br>` in any of its spellings. */
function cellLines(cell: string): string[] {
  return cell.split(LINE_BREAK).map((line) => line.trim());
}

function richTextCell(cell: string): { block: Block; characters: number } {
  const elements: RichTextElement[] = [];
  for (const line of cellLines(cell)) {
    if (elements.length) elements.push({ type: 'text', text: '\n' });
    elements.push(...inlineElements(line));
  }
  // Slack rejects an empty section or a zero-length text element; a single
  // space renders blank and stays valid.
  const content = elements.length ? elements : [{ type: 'text', text: ' ' } satisfies RichTextElement];
  return {
    block: { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: content }] },
    characters: content.reduce((sum, element) => sum + element.text.length, 0),
  };
}

function headerCell(header: string | undefined, column: number): { block: Block; characters: number } {
  const text = header === undefined ? '' : cellLines(header)
    .map((line) => plainText(fromMarkdown(line)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const label = text || `Column ${column + 1}`;
  return { block: { type: 'raw_text', text: label }, characters: label.length };
}

function tableBlock(table: MarkdownTable): { block: Block; characters: number } | undefined {
  const { headers, alignments, rows } = table;
  if (rows.length === 0 || rows.length + 1 > SLACK_TABLE_ROW_LIMIT) return undefined;
  const width = Math.max(headers.length, ...rows.map((row) => row.length));
  if (width > SLACK_TABLE_COLUMN_LIMIT) return undefined;
  let characters = 0;
  const collect = (cell: { block: Block; characters: number }): Block => {
    characters += cell.characters;
    return cell.block;
  };
  const columns = Array.from({ length: width }, (_, column) => column);
  const header = columns.map((column) => collect(headerCell(headers[column], column)));
  const body = rows.map((row) => columns.map((column) => collect(richTextCell(row[column] ?? ''))));
  return {
    block: {
      type: 'table',
      column_settings: columns.map((column) => ({ align: alignments[column] ?? 'left', is_wrapped: true })),
      rows: [header, ...body],
    },
    characters,
  };
}

/**
 * Split Markdown into `markdown` blocks for prose and `table` blocks for
 * pipe tables. Returns undefined when the text has no renderable table, a
 * table exceeds Slack's limits, or the result needs more than `maxBlocks`
 * blocks, so the caller keeps its existing rendering.
 */
export function tablesToTableBlocks(text: string, maxBlocks: number): Block[] | undefined {
  const blocks: Block[] = [];
  let characters = 0;
  let tables = 0;
  for (const segment of splitMarkdownTables(text)) {
    if (segment.type === 'text') {
      const prose = segment.lines.join('\n').replace(/^\s*\n|\n\s*$/g, '').trim();
      if (prose) blocks.push({ type: 'markdown', text: prose });
      continue;
    }
    const table = tableBlock(segment.table);
    if (!table) return undefined;
    characters += table.characters;
    if (characters > SLACK_TABLE_CHARACTER_LIMIT) return undefined;
    blocks.push(table.block);
    tables += 1;
  }
  if (tables === 0 || blocks.length > maxBlocks) return undefined;
  return blocks;
}

/** True when a generated payload carries a native table block. */
export function hasTableBlock(blocks: Block[] | undefined): boolean {
  return blocks?.some((block) => block.type === 'table') ?? false;
}
