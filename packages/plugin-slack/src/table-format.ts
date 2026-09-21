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

/**
 * Render pipe tables as labeled rows before converting to Slack mrkdwn.
 * Native Slack spans keep their documented meaning in section blocks.
 * This scanner does not invoke a Markdown parser on untrusted action text.
 */
export function tablesToLabeledRows(text: string, maxOutputLength: number): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
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
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (!append(line)) return truncated();
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,})(?!`)[^`]*$|^ {0,3}(~{3,})[^\n]*$/.exec(line);
    if (opening) {
      fence = opening[1] ?? opening[2];
      if (!append(line)) return truncated();
      continue;
    }
    const delimiter = lines[index + 1];
    if (/^(?: {4}|\t)/.test(line) || delimiter === undefined || !isTableDelimiterRow(delimiter)) {
      if (!append(line)) return truncated();
      continue;
    }
    const headers = tableCells(line);
    const separators = tableCells(delimiter);
    if (!headers || !separators || headers.length !== separators.length) {
      if (!append(line)) return truncated();
      continue;
    }
    index += 1;
    let rows = 0;
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (/^\s*$|^(?: {4}|\t)|^ {0,3}(?:[`~]{3,}|>|#{1,6}\s|[-+*]\s|\d+[.)]\s)/.test(next)) break;
      const cells = tableCells(next);
      if (!cells) break;
      const fields = Array.from({ length: Math.max(headers.length, cells.length) }, (_, column) =>
        `**${headers[column] || `Column ${column + 1}`}**: ${cells[column] ?? ''}`);
      if (!append(fields.join('\n')) || !append('')) return truncated();
      rows += 1;
      index += 1;
    }
    if (rows === 0 && (!append(headers.map((header) => `**${header}**`).join('\n')) || !append(''))) return truncated();
  }
  return { text: output.join('\n'), truncated: false };
}
