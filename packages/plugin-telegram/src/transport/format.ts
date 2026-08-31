/**
 * Escape a string for literal inclusion in Telegram HTML. Use this instead
 * of `markdownToTelegramHtml` for text that must render VERBATIM — its
 * `[text](url)` transform turns model- or user-controlled content (gate arg
 * values, display names) into live links.
 */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert standard Markdown to Telegram-compatible HTML.
 * Handles: fenced code blocks, inline code, bold, italic, links.
 * Escapes HTML entities in non-code text to prevent Telegram API parse errors.
 */
export function markdownToTelegramHtml(text: string): string {
  // Extract fenced code blocks first to protect them from formatting transforms
  const codeBlocks: string[] = [];
  let result = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_, code: string) => {
    codeBlocks.push(code.trimEnd());
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Extract inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_, code: string) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Escape HTML entities in remaining text
  result = escapeTelegramHtml(result);

  // Convert markdown formatting to HTML (order matters: bold before italic)
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore inline code with HTML escaping
  result = result.replace(/\x00IC(\d+)\x00/g, (_, i) => {
    const code = escapeTelegramHtml(inlineCodes[Number(i)]);
    return `<code>${code}</code>`;
  });

  // Restore code blocks with HTML escaping
  result = result.replace(/\x00CB(\d+)\x00/g, (_, i) => {
    const code = escapeTelegramHtml(codeBlocks[Number(i)]);
    return `<pre>${code}</pre>`;
  });

  return result;
}
