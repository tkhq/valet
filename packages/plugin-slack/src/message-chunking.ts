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
import { isTableDelimiterRow, splitMarkdownTables, tablesToLabeledRows } from "./table-format.js";
import { hasTableBlock, SLACK_TABLE_ROW_LIMIT, tablesToTableBlocks } from "./table-blocks.js";

export { hasTableBlock } from "./table-blocks.js";

export interface ContentBlockOptions extends MarkdownToSlackMrkdwnOptions {
  /** Render pipe tables as native `table` blocks. Defaults to true. */
  nativeTables?: boolean;
}

/** Max characters in the `text` field of chat.postMessage before we switch to blocks. */
export const SLACK_TEXT_LIMIT = 4000;

/**
 * Max UTF-8 bytes in chat.update's `text` field. chat.postMessage truncates a
 * long text, but chat.update rejects one over 4,000 bytes with msg_too_long.
 * Slack measures the text after it escapes it (see `slackEscapedText`), so a
 * 4,000-character slice with a multi-byte character, a raw `>`, or a code
 * span's `<id>` fails the edit.
 */
export const SLACK_UPDATE_TEXT_BYTES = 4000;

/** A Slack span (link, mention, channel, special command) or an entity Slack keeps as is. */
const SLACK_KEPT = /<(?:https?:\/\/|mailto:|[@#!])[^<>|\s]*(?:\|[^<>]*)?>|&(?:amp|lt|gt);/g;

const escapeSlackChars = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slack stores a URL's `&` as `&amp;`, also inside a span. */
const escapeSpanAmpersands = (kept: string) =>
  kept.startsWith("<") ? kept.replace(/&(?!(?:amp|lt|gt);)/g, "&amp;") : kept;

/**
 * The mrkdwn text as Slack stores it. The formatter leaves a `>` and the
 * contents of code spans raw; Slack escapes every `&`, `<` and `>` that is not
 * part of a span or an entity, which makes the stored text longer.
 */
export function slackEscapedText(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(SLACK_KEPT)) {
    out += escapeSlackChars(text.slice(last, match.index)) + escapeSpanAmpersands(match[0]);
    last = match.index + match[0].length;
  }
  return out + escapeSlackChars(text.slice(last));
}

/** A whole span or entity in text from `slackEscapedText`. */
const SLACK_TOKEN = /<[^<>]*>|&(?:amp|lt|gt);/g;

/**
 * Cuts text from `slackEscapedText` to at most `maxBytes` UTF-8 bytes without
 * ending inside a span or an entity. Slack escapes a cut-off `<https://...`
 * again, so a mid-span cut grows past the limit.
 */
export function truncateSlackText(text: string, maxBytes: number): string {
  const cut = truncateUtf8(text, maxBytes);
  if (cut === text) return cut;
  for (const token of text.matchAll(SLACK_TOKEN)) {
    if (token.index >= cut.length) break;
    if (token.index + token[0].length > cut.length) return cut.slice(0, token.index);
  }
  return cut;
}

const utf8 = new TextEncoder();

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8.encode(text).length <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = utf8.encode(char).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/** Cumulative character limit across all markdown blocks in a single payload. */
export const SLACK_MARKDOWN_LIMIT = 12000;

/** Max characters in a single section block's text element. */
export const SLACK_BLOCK_TEXT_LIMIT = 3000;

/** Slack allows at most 50 blocks per message. */
export const SLACK_MAX_BLOCKS = 50;

/** Max characters in a header block's plain_text element. */
export const SLACK_HEADER_LIMIT = 150;

/** Max characters in a button's plain_text label. A longer one fails the whole message. */
export const SLACK_BUTTON_LABEL_LIMIT = 75;

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

/** At most this many messages carry one table. A longer table keeps the
 * single-message rendering. */
export const SLACK_TABLE_PART_LIMIT = 10;

/**
 * Split a message whose one table is too large for a single Slack message
 * (it would fall back to `mrkdwn` sections, which show no table) into parts
 * that each render as a native `table` block. Each part repeats
 * the header and delimiter rows. The text before the table opens the first
 * part, and the text after it closes the last part. Each part except the
 * last ends with `note`, for example "_Continued in the thread._".
 *
 * Returns undefined when the message fits one Markdown or table block, has
 * no single standalone table, has Slack native spans, or needs more than
 * {@link SLACK_TABLE_PART_LIMIT} parts. The caller then keeps its
 * single-message rendering.
 */
export function splitTableMessage(text: string, maxBlocks: number, note: string): string[] | undefined {
  if (containsSlackSpans(text) || !text.split(/\r?\n/).some(isTableDelimiterRow)) return undefined;
  // A message that fits a Markdown block keeps its table: only the section
  // fallback loses it.
  if (buildContentBlocks(text, '', maxBlocks).every((block) => block.type !== 'section')) return undefined;
  const renders = (part: string): boolean => hasTableBlock(buildContentBlocks(part, '', maxBlocks));
  const segments = splitMarkdownTables(text);
  const tables = segments.filter((segment) => segment.type === 'table');
  if (tables.length !== 1 || !tables[0].table.standalone) return undefined;
  const at = segments.indexOf(tables[0]);
  const prose = (from: number, to: number): string =>
    segments.slice(from, to).flatMap((segment) => segment.type === 'text' ? segment.lines : []).join('\n').trim();
  const before = prose(0, at);
  const after = prose(at + 1, segments.length);
  const [header, delimiter, ...rows] = tables[0].table.lines;
  if (rows.length > SLACK_TABLE_PART_LIMIT * (SLACK_TABLE_ROW_LIMIT - 1)) return undefined;
  const compose = (lead: string, body: readonly string[], tail: string): string =>
    [lead, [header, delimiter, ...body].join('\n'), tail].filter(Boolean).join('\n\n');

  const parts: string[] = [];
  let lead = before;
  let body: string[] = [];
  for (const row of rows) {
    if (renders(compose(lead, [...body, row], note))) {
      body.push(row);
      continue;
    }
    if (body.length === 0) {
      // The text before the table leaves no room for a row: send it alone.
      if (!lead || !renders(compose('', [row], note))) return undefined;
      parts.push(lead);
      lead = '';
      body = [row];
      continue;
    }
    parts.push(compose(lead, body, note));
    lead = '';
    body = [row];
    if (!renders(compose(lead, body, note))) return undefined;
  }
  const last = compose(lead, body, after);
  if (renders(last)) {
    parts.push(last);
  } else {
    // The text after the table goes in its own message.
    parts.push(compose(lead, body, note), after);
  }
  return parts.length > 1 && parts.length <= SLACK_TABLE_PART_LIMIT ? parts : undefined;
}
