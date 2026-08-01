/**
 * Markdown → plain text for one-line previews and excerpt cards (dashboard
 * chat card, memory journal excerpt). NOT a renderer — it reduces markdown
 * syntax to the text a reader would see, so previews read as prose instead
 * of raw `## headings` and `**asterisks**`.
 *
 * Deliberately regex-based and lossy: preview surfaces truncate to a couple
 * hundred chars anyway, so perfect CommonMark fidelity buys nothing. Keep
 * the rules ordered — fences before inline code, links after images.
 */
export function stripMarkdown(source: string): string {
  let text = source;

  // Fenced code blocks: keep the code content, drop the fence lines and
  // any language tag. A preview showing the first line of code is more
  // useful than showing ``` markers.
  text = text.replace(/^```[^\n]*\n?/gm, "");

  // Images before links (same bracket syntax, extra `!`): keep alt text.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links: keep the label, drop the URL.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // ATX headings: drop the leading hashes (and optional closing hashes).
  // `[^\S\n]` = horizontal whitespace only — a bare `\s*` would eat the
  // blank line AFTER the heading and defeat the paragraph-separator rule
  // at the bottom.
  text = text.replace(/^#{1,6}[^\S\n]+(.*?)[^\S\n]*#*[^\S\n]*$/gm, "$1");

  // Blockquote markers.
  text = text.replace(/^\s{0,3}>\s?/gm, "");

  // Horizontal rules on their own line.
  text = text.replace(/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/gm, "");

  // Emphasis/strong/strikethrough — strip paired markers, keep content.
  // Longest first so `***bold italic***` unwraps cleanly.
  text = text.replace(/(\*{1,3}|_{1,3}|~~)(?=\S)([\s\S]*?\S)\1/g, "$2");

  // Inline code: keep the content, drop the backticks.
  text = text.replace(/`([^`]+)`/g, "$1");

  // List markers (bulleted + ordered) at line starts → keep the item text.
  // Horizontal whitespace only, for the same reason as the heading rule.
  text = text.replace(/^[^\S\n]*(?:[-*+]|\d{1,3}[.)])[^\S\n]+/gm, "");

  // Collapse whitespace: newlines become a single separator so excerpts
  // flow as one line; runs of spaces collapse.
  text = text.replace(/\n{2,}/g, " — ").replace(/\s+/g, " ");

  return text.trim();
}
