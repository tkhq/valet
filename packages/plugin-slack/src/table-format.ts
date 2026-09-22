/** Delimiter cells may contain one or more dashes in GFM tables. */
export function isTableDelimiterRow(line: string): boolean {
  if (!line.includes('|')) return false;
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  return cells.every((cell) => /^[ \t]*:?-+:?[ \t]*$/.test(cell));
}

/** Keep pipes inside Slack spans and escaped pipes inside their table cell. */
function tableCells(line: string): string[] | null {
  const source = line.trim();
  const spans = [...source.matchAll(/<(?:[@#!][^<>\r\n]+|https?:\/\/[^<>\r\n]+)>/g)];
  let spanIndex = 0;
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < source.length; index += 1) {
    const span = spans[spanIndex];
    if (span?.index === index) {
      cell += span[0];
      index += span[0].length - 1;
      spanIndex += 1;
    } else if (source[index] === '\\' && source[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (source[index] === '\\' && source[index + 1] === '\\') {
      cell += '\\\\';
      index += 1;
    } else if (source[index] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += source[index];
    }
  }
  if (cells.length === 0) return null;
  cells.push(cell.trim());
  if (source.startsWith('|')) cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells;
}

export type TableAlignment = 'left' | 'center' | 'right';

/** Column alignment from a GFM delimiter cell such as `:-:`. */
function alignmentOf(separator: string): TableAlignment {
  const trimmed = separator.trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

export interface MarkdownTable {
  headers: string[];
  alignments: TableAlignment[];
  /** Body rows as written; a row may be shorter or longer than the header. */
  rows: string[][];
}

export type MarkdownSegment =
  | { type: 'text'; lines: string[] }
  | { type: 'table'; table: MarkdownTable };

/**
 * Split Markdown into prose runs and pipe tables. Fenced and indented code
 * stay prose, so table examples inside them are never rendered as tables.
 * This scanner does not invoke a Markdown parser on untrusted action text.
 */
export function splitMarkdownTables(text: string): MarkdownSegment[] {
  const lines = text.split(/\r?\n/);
  const segments: MarkdownSegment[] = [];
  const prose = (line: string): void => {
    const last = segments.at(-1);
    if (last?.type === 'text') last.lines.push(line);
    else segments.push({ type: 'text', lines: [line] });
  };
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      prose(line);
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,})(?!`)[^`]*$|^ {0,3}(~{3,})[^\n]*$/.exec(line);
    if (opening) {
      fence = opening[1] ?? opening[2];
      prose(line);
      continue;
    }
    const delimiter = lines[index + 1];
    if (/^(?: {4}|\t)/.test(line) || delimiter === undefined || !isTableDelimiterRow(delimiter)) {
      prose(line);
      continue;
    }
    const headers = tableCells(line);
    const separators = tableCells(delimiter);
    if (!headers || !separators || headers.length !== separators.length) {
      prose(line);
      continue;
    }
    index += 1;
    const rows: string[][] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (/^\s*$|^(?: {4}|\t)|^ {0,3}(?:[`~]{3,}|>|#{1,6}\s|[-+*]\s|\d+[.)]\s)/.test(next)) break;
      const cells = tableCells(next);
      if (!cells) break;
      rows.push(cells);
      index += 1;
    }
    segments.push({ type: 'table', table: { headers, alignments: separators.map(alignmentOf), rows } });
  }
  return segments;
}

/**
 * Render pipe tables as labeled rows before converting to Slack mrkdwn.
 * Native Slack spans keep their documented meaning in section blocks.
 */
export function tablesToLabeledRows(text: string, maxOutputLength: number): { text: string; truncated: boolean } {
  const output: string[] = [];
  let outputLength = 0;
  const append = (value: string): boolean => {
    const length = value.length + (output.length ? 1 : 0);
    if (outputLength + length > maxOutputLength) {
      let end = Math.max(0, maxOutputLength - outputLength - (output.length ? 1 : 0));
      // Keep a bounded prefix, but leave an incomplete Slack span out of it.
      const spanStart = value.lastIndexOf('<', end - 1);
      if (spanStart >= 0 && value.indexOf('>', spanStart) >= end) end = spanStart;
      if (end > 0) output.push(value.slice(0, end));
      return false;
    }
    output.push(value);
    outputLength += length;
    return true;
  };
  const truncated = (): { text: string; truncated: boolean } => ({ text: output.join('\n'), truncated: true });
  for (const segment of splitMarkdownTables(text)) {
    if (segment.type === 'text') {
      for (const line of segment.lines) {
        if (!append(line)) return truncated();
      }
      continue;
    }
    const { headers, rows } = segment.table;
    for (const cells of rows) {
      const fields = Array.from({ length: Math.max(headers.length, cells.length) }, (_, column) =>
        `**${headers[column] || `Column ${column + 1}`}**: ${cells[column] ?? ''}`);
      if (!append(fields.join('\n')) || !append('')) return truncated();
    }
    if (rows.length === 0 && (!append(headers.map((header) => `**${header}**`).join('\n')) || !append(''))) return truncated();
  }
  return { text: output.join('\n'), truncated: false };
}
