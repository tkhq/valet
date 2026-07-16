/**
 * Slack limits: chat.postMessage text field ≤ 4000 chars, section block text
 * ≤ 3000 chars, markdown block ≤ 12000 chars cumulative, max 50 blocks per
 * message. For long messages we use blocks inside a single API call (no extra
 * rate-limit cost) instead of sending multiple messages (which violates the
 * 1 msg/sec/channel rate limit and risks silent message loss).
 *
 * Preferred block type is `markdown` — it renders standard markdown natively
 * (tables, headers, code blocks, etc.) without needing mrkdwn conversion.
 * Falls back to `section` blocks for messages exceeding the markdown limit.
 */

/** Max characters in the `text` field of chat.postMessage before we switch to blocks. */
export const SLACK_TEXT_LIMIT = 4000;

/** Cumulative character limit across all markdown blocks in a single payload. */
export const SLACK_MARKDOWN_LIMIT = 12000;

/** Max characters in a single section block's text element. */
export const SLACK_BLOCK_TEXT_LIMIT = 3000;

/** Slack allows at most 50 blocks per message. */
export const SLACK_MAX_BLOCKS = 50;

/**
 * Split text into chunks at paragraph boundaries, keeping each chunk under maxLen.
 * Falls back to single-newline splits, then hard-splits at maxLen.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find the last paragraph break (\n\n) within the limit.
    // splitIdx === 0 means the only match is at the very start — slice(0,0) would
    // produce an empty chunk, so treat it the same as not-found and fall through.
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx <= 0) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }

  return chunks;
}

/** A line is a table delimiter if it holds only pipes, colons, dashes and spaces. */
function isTableDelimiterRow(line: string): boolean {
  const trimmed = line.trim();
  return /^[|\s:-]+$/.test(trimmed) && trimmed.includes('-') && trimmed.includes('|');
}

/**
 * Flag every line belonging to a GFM table. A table is a delimiter row, the
 * header line directly above it, and the body rows below it that still carry a
 * pipe. Tables encode their own line structure, so they must not receive break
 * markers.
 */
function markTableLines(lines: string[]): boolean[] {
  const inTable = new Array<boolean>(lines.length).fill(false);

  for (let i = 0; i < lines.length; i++) {
    if (!isTableDelimiterRow(lines[i])) continue;
    if (i === 0 || !lines[i - 1].includes('|')) continue;

    inTable[i - 1] = true;
    inTable[i] = true;
    for (let j = i + 1; j < lines.length && lines[j].trim() !== '' && lines[j].includes('|'); j++) {
      inTable[j] = true;
    }
  }

  return inTable;
}

/**
 * Slack's `markdown` block is CommonMark, where a single newline is a SOFT break
 * that renders as a space — so a long message written with one newline between
 * lines arrives as a single run-on paragraph. Appending two trailing spaces turns
 * each soft break into a CommonMark HARD break, restoring the line structure the
 * author wrote.
 *
 * Left untouched: blank lines and the lines before them (a real paragraph break
 * already renders correctly), fenced code blocks and tables (both carry their own
 * line semantics, and the markdown block exists to render them natively), and
 * lines that already end in an explicit hard break.
 */
export function normalizeSoftBreaks(text: string): string {
  const lines = text.split('\n');
  const inTable = markTableLines(lines);
  let inFence = false;

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || inTable[i] || inTable[i + 1]) continue;

    // A blank line on either side already ends the block: nothing to hold together.
    if (line.trim() === '' || lines[i + 1].trim() === '') continue;

    // Already an explicit hard break (trailing double space or backslash).
    if (/( {2}|\\)$/.test(line)) continue;

    lines[i] = `${line}  `;
  }

  return lines.join('\n');
}

/**
 * Build content blocks for a message. Prefers a single `markdown` block (which
 * renders tables, headers, code blocks natively). Falls back to `section` blocks
 * with mrkdwn for messages exceeding the markdown cumulative limit.
 *
 * @param text Raw markdown text (NOT pre-converted to Slack mrkdwn).
 * @param mrkdwnText Slack mrkdwn-formatted text, used only for section block fallback.
 * @param maxBlocks Cap the number of blocks returned.
 */
export function buildContentBlocks(
  text: string,
  mrkdwnText: string,
  maxBlocks: number = SLACK_MAX_BLOCKS,
): Record<string, unknown>[] {
  // Measure the limit against the text we actually send: break markers add length.
  const normalized = normalizeSoftBreaks(text);
  if (normalized.length <= SLACK_MARKDOWN_LIMIT) {
    return [{ type: 'markdown', text: normalized }];
  }

  // Fallback: split mrkdwn-formatted text into section blocks
  const chunks = splitText(mrkdwnText, SLACK_BLOCK_TEXT_LIMIT);
  return chunks.slice(0, maxBlocks).map((chunk) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: chunk },
  }));
}
