/**
 * Slack limits: chat.postMessage text field ≤ 4000 chars, section block text
 * ≤ 3000 chars, markdown block ≤ 12000 chars cumulative, max 50 blocks per
 * message. For long messages we use blocks inside a single API call (no extra
 * rate-limit cost) instead of sending multiple messages (which violates the
 * 1 msg/sec/channel rate limit and risks silent message loss).
 *
 * Preferred block type is `markdown` — it renders standard markdown natively
 * (tables, headers, code blocks, etc.) without needing mrkdwn conversion.
 * Uses `section` blocks for Slack-native spans or messages exceeding that limit.
 */

import { containsSlackSpans, linkGitHubReferencesInMarkdown, markdownToSlackMrkdwn, type MarkdownToSlackMrkdwnOptions } from "./transport/format.js";
import { isTableDelimiterRow, tablesToLabeledRows } from "./table-format.js";
import { tablesToTableBlocks } from "./table-blocks.js";

export { hasTableBlock } from "./table-blocks.js";

export interface ContentBlockOptions extends MarkdownToSlackMrkdwnOptions {
  /** Render pipe tables as native `table` blocks. Defaults to true. */
  nativeTables?: boolean;
}

/** Max characters in the `text` field of chat.postMessage before we switch to blocks. */
export const SLACK_TEXT_LIMIT = 4000;

/** Cumulative character limit across all markdown blocks in a single payload. */
export const SLACK_MARKDOWN_LIMIT = 12000;

/** Max characters in a single section block's text element. */
export const SLACK_BLOCK_TEXT_LIMIT = 3000;

/** Slack allows at most 50 blocks per message. */
export const SLACK_MAX_BLOCKS = 50;

/** Max characters in a header block's plain_text element. */
export const SLACK_HEADER_LIMIT = 150;

/** Max fields in a single section block. */
export const SLACK_SECTION_FIELD_LIMIT = 10;

/** Short tables also need blocks: Slack mrkdwn cannot render pipe tables. */
export function needsContentBlocks(text: string): boolean {
  if (text.length > SLACK_TEXT_LIMIT) return true;

  // A delimiter row is enough to choose Markdown rendering. This also preserves
  // table examples inside code fences without parsing untrusted Markdown here.
  return text.split(/\r?\n/).some(isTableDelimiterRow);
}

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

    // Keep native links and mentions whole when a split crosses their spans.
    const linkStart = remaining.lastIndexOf('<', splitIdx - 1);
    const linkEnd = remaining.indexOf('>', linkStart);
    if (linkStart > 0 && linkEnd >= splitIdx && linkEnd - linkStart + 1 <= maxLen
      && /^<[^<>\n]+>$/.test(remaining.slice(linkStart, linkEnd + 1))
      && containsSlackSpans(remaining.slice(linkStart, linkEnd + 1))) {
      splitIdx = linkStart;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }

  return chunks;
}

/**
 * Build content blocks for a message. Pipe tables become native `table`
 * blocks with `markdown` blocks for the prose around them, so a cell can
 * hold one line per entry. Otherwise a single `markdown` block renders the
 * text (headers, code blocks, and tables Slack's limits cannot hold). Falls
 * back to `section` blocks with mrkdwn for native spans or messages
 * exceeding the markdown limit.
 *
 * @param text Raw markdown text (NOT pre-converted to Slack mrkdwn).
 * @param mrkdwnText Slack mrkdwn-formatted text, used only for section block fallback.
 * @param maxBlocks Cap the number of blocks returned.
 * @param options Native-span policy for the labeled-row fallback, and
 *   `nativeTables: false` to keep tables in the `markdown` block.
 */
export function buildContentBlocks(
  text: string,
  mrkdwnText: string,
  maxBlocks: number = SLACK_MAX_BLOCKS,
  options: ContentBlockOptions = {},
): Record<string, unknown>[] {
  const { nativeTables = true, ...mrkdwnOptions } = options;
  let truncatedRows = false;
  if (containsSlackSpans(text)) {
    // Reuse the documented mrkdwn path and its complete control-token policy.
    const rows = tablesToLabeledRows(text, SLACK_BLOCK_TEXT_LIMIT * maxBlocks);
    truncatedRows = rows.truncated;
    mrkdwnText = markdownToSlackMrkdwn(rows.text, mrkdwnOptions);
  } else if (text.length <= SLACK_MARKDOWN_LIMIT) {
    const markdown = linkGitHubReferencesInMarkdown(text);
    if (markdown.length <= SLACK_MARKDOWN_LIMIT) {
      const blocks = nativeTables ? tablesToTableBlocks(markdown, maxBlocks) : undefined;
      return blocks ?? [{ type: 'markdown', text: markdown }];
    }
  }

  // Fallback: split mrkdwn-formatted text into section blocks
  const chunks = splitText(mrkdwnText, SLACK_BLOCK_TEXT_LIMIT);
  const visibleChunks = chunks.slice(0, maxBlocks);
  if (truncatedRows || chunks.length > maxBlocks) {
    const notice = '\n\n[Message truncated to fit Slack block limits.]';
    const last = visibleChunks.length - 1;
    if (last >= 0) {
      // Reuse span-aware splitting so the notice cannot cut a mention in half.
      visibleChunks[last] = splitText(visibleChunks[last], SLACK_BLOCK_TEXT_LIMIT - notice.length)[0] + notice;
    }
  }
  return visibleChunks.map((chunk) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: chunk },
  }));
}
