/**
 * Convert standard Markdown to Slack's mrkdwn format.
 * Ported verbatim from legacy `src/channels/format.ts` (origin/main).
 * Handles: fenced code blocks, inline code, bold, italic, links, blockquotes.
 *
 * Note: tables are NOT converted here — they are handled natively by Slack's
 * `markdown` block type. This function is only used for the `text` field
 * (notification fallback) and as a fallback for section blocks when messages
 * exceed the markdown block cumulative limit.
 */
export function markdownToSlackMrkdwn(text: string): string {
  // Extract fenced code blocks first to protect them from formatting transforms
  // AND from the escaping below — Slack renders code literally and does not
  // interpret control sequences inside it, so escaping code content would just
  // double-escape ampersands.
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

  // Escape mrkdwn metacharacters in the remaining (non-code) literal text, so
  // agent output can't inject control sequences — <!channel>/<!here> (mass
  // ping), <@U…>/<#C…> (targeted ping / impersonation), or <url|label> (link
  // spoofing). Every such token requires a literal `<`, so escaping `&` and
  // `<` renders them all inert; `>` is deliberately left alone so Slack
  // blockquotes (`> quote`) still render. The `text` field of chat.postMessage
  // is parsed as mrkdwn by default, so this is load-bearing for security. The
  // link transform below re-introduces the ONLY legitimate `<…>` sequences,
  // built from controlled [text](url) markdown after this escape.
  result = result.replace(/&/g, "&amp;").replace(/</g, "&lt;");

  // Convert bold to placeholders first (so italic pass doesn't re-match)
  // **bold** or __bold__ → placeholder
  const boldSpans: string[] = [];
  result = result.replace(/\*\*(.+?)\*\*/g, (_, content: string) => {
    boldSpans.push(content);
    return `\x00BD${boldSpans.length - 1}\x00`;
  });
  result = result.replace(/__(.+?)__/g, (_, content: string) => {
    boldSpans.push(content);
    return `\x00BD${boldSpans.length - 1}\x00`;
  });

  // *italic* → _italic_ (safe now since bold ** has been extracted)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Restore bold spans as Slack bold (*text*)
  result = result.replace(/\x00BD(\d+)\x00/g, (_, i) => {
    return `*${boldSpans[Number(i)]}*`;
  });

  // Restore inline code
  result = result.replace(/\x00IC(\d+)\x00/g, (_, i) => {
    return `\`${inlineCodes[Number(i)]}\``;
  });

  // Restore code blocks
  result = result.replace(/\x00CB(\d+)\x00/g, (_, i) => {
    return `\`\`\`${codeBlocks[Number(i)]}\`\`\``;
  });

  return result;
}
