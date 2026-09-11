/**
 * Two escapes for two different Slack text formats.
 *
 * `markdownToSlackMrkdwn` serves the mrkdwn path — the `text` field of
 * chat.postMessage (notification fallback) and `section` block text. Slack
 * parses that field as mrkdwn, so it escapes every `<` and `&`.
 *
 * `neutralizeSlackMentions` serves the standard-markdown path —
 * `markdown_text` on the streaming methods. That field is documented as
 * standard markdown, not mrkdwn, so the broad escape would be wrong there:
 * `&lt;` is not guaranteed to render back as `<`, and agent output is full of
 * legitimate angle brackets (generics, HTML samples, code). It therefore
 * neutralizes only the specific tokens that could ping a workspace.
 */

/** Mention and broadcast control sequences, the only mrkdwn tokens with a
 * blast radius beyond the message itself: `<!channel>` and friends notify
 * everyone, `<@U…>`/`<!subteam^…>` notify a person or group, and `<#C…>`
 * renders as a channel link. Each one needs a literal `<` to work. */
const SLACK_CONTROL_SEQUENCE =
  /<(![a-z]+(?:\^[^>|\s]+)?|[@#][A-Z0-9]+)((?:\|[^>]*)?)>/g;

/**
 * Make Slack mention and broadcast sequences inert for the `markdown_text`
 * path, leaving all other text — including every other angle bracket —
 * untouched.
 *
 * Slack's docs do not state whether `markdown_text` interprets mrkdwn control
 * sequences. Until that is confirmed against a live workspace, assume it
 * does: an agent that echoes `<!channel>` back from a document it read would
 * otherwise notify the entire workspace. A mangled `&lt;!channel>` in rare
 * output is a far cheaper failure than a mass ping.
 *
 * Sequences inside fenced code are neutralized too. Fence state is not
 * knowable on a streamed delta, which arrives mid-block, so this deliberately
 * does not try to track it.
 */
export function neutralizeSlackMentions(text: string): string {
  return text.replace(SLACK_CONTROL_SEQUENCE, (_match, token: string, label: string) => {
    return `&lt;${token}${label}>`;
  });
}

/**
 * The load-bearing mrkdwn escape: `&`/`<` render every control sequence
 * (mass pings, targeted pings, spoofed `<url|label>` links) inert, because
 * each one requires a literal `<`. `>` stays untouched so blockquotes still
 * render. Exported so every path that writes raw text into an mrkdwn field
 * (gate cards, resolution edits) applies the SAME rule — a second copy of
 * this chain is how an escape rule silently goes stale.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

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
  result = escapeMrkdwn(result);

  // Extract bold spans before italic spans. This prevents a bold delimiter
  // from being read as two adjacent italic delimiters.
  const boldSpans: string[] = [];
  // Handle combined emphasis before plain bold. A triple delimiter contains
  // a complete italic span inside the bold span in CommonMark.
  result = result.replace(/(?:^|(?<=[\s(]))\*{3}([^*\n]+)\*{3}(?!\*)/g, (_, content: string) => {
    boldSpans.push(`_${content}_`);
    return `\x00BD${boldSpans.length - 1}\x00`;
  });
  result = result.replace(/\*\*([^*\n]*)\*([^*\n]+)\*\*\*/g, (_, before: string, italic: string) => {
    boldSpans.push(`${before}_${italic}_`);
    return `\x00BD${boldSpans.length - 1}\x00`;
  });
  result = result.replace(/\*\*(.+?)\*\*/g, (_, content: string) => {
    boldSpans.push(content);
    return `\x00BD${boldSpans.length - 1}\x00`;
  });
  result = result.replace(/__(.+?)__/g, (_, content: string) => {
    boldSpans.push(content);
    return `\x00BD${boldSpans.length - 1}\x00`;
  });

  // *italic* → _italic_ (safe now since bold ** has been extracted).
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Slack has no heading syntax. Convert a Markdown heading after italic
  // conversion so its generated bold delimiters stay bold.
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  const italicize = (content: string): string =>
    content.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // Restore bold spans as Slack bold (*text*). Convert italic text nested in
  // a bold span before restoring its outer delimiters.
  result = result.replace(/\x00BD(\d+)\x00/g, (_, i) => {
    return `*${italicize(boldSpans[Number(i)])}*`;
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
