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

/** Existing Slack control sequences and links that callers can preserve.
 * Broadcast tokens are deliberately excluded. */
const SLACK_NATIVE_SPAN =
  /<(?:@[UW][A-Z0-9]+(?:\|[^>]*)?|#[CG][A-Z0-9]+(?:\|[^>]*)?|!subteam\^[^>|\s]+(?:\|[^>]*)?|https?:\/\/[^>\s]+(?:\|[^>]*)?)>/g;

export interface MarkdownToSlackMrkdwnOptions {
  /** Preserve raw Slack spans. Use only for deliberate action input. */
  preserveSlackNativeSpans?: boolean;
}

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
 * (gate cards, resolution edits) applies the SAME rule.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** Convert CommonMark to Slack mrkdwn.
 *
 * Apply this function exactly once. A second application treats Slack's
 * `*bold*` output as CommonMark italic text and changes it to `_bold_`.
 * Transport text uses the default strict policy. Actions can preserve
 * deliberately supplied Slack spans with `preserveSlackNativeSpans`.
 */
export function markdownToSlackMrkdwn(
  text: string,
  options: MarkdownToSlackMrkdwnOptions = {},
): string {
  const codeBlocks: string[] = [];
  let result = text.replace(/\x00/g, "").replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_, code: string) => {
    codeBlocks.push(code.trimEnd());
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_, code: string) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  const nativeSpans: string[] = [];
  if (options.preserveSlackNativeSpans) {
    result = result.replace(SLACK_NATIVE_SPAN, (span: string) => {
      nativeSpans.push(span);
      return `\x00SN${nativeSpans.length - 1}\x00`;
    });
  }

  result = escapeMrkdwn(result);
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  result = result.replace(/~~(?=\S)(.+?\S)~~/g, "~$1~");

  const boldSpans: string[] = [];
  const holdBold = (content: string): string => {
    boldSpans.push(content);
    return `\x00BD${boldSpans.length - 1}\x00`;
  };
  result = result.replace(/(?:^|(?<=[\s(]))\*{3}([^*\n]+)\*{3}(?!\*)/g, (_, content: string) => {
    return holdBold(`_${content}_`);
  });
  result = result.replace(/\*\*([^*\n]*)\*([^*\n]+)\*\*\*/g, (_, before: string, italic: string) => {
    return holdBold(`${before}_${italic}_`);
  });
  result = result.replace(/(?<!\w)\*\*(?=\S)(.+?)(?<!\s)\*\*(?!\w)/g, (_, content: string) => holdBold(content));
  result = result.replace(/(?<![\w_])__(?=\S)(.+?)(?<!\s)__(?![\w_])/g, (_, content: string) => holdBold(content));

  result = result.replace(/(?<!\*)\*(?![\s*])(\S(?:.*?\S)?)\*(?!\*)/g, "_$1_");
  result = result.replace(/^#{1,6}\s+(?=.*\x00BD\d+\x00)(.+)$/gm, "$1");
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  const italicize = (content: string): string =>
    content.replace(/(?<!\*)\*(?![\s*])(\S(?:.*?\S)?)\*(?!\*)/g, "_$1_");
  result = result.replace(/\x00BD(\d+)\x00/g, (_, index: string) => {
    return `*${italicize(boldSpans[Number(index)])}*`;
  });
  result = result.replace(/\x00SN(\d+)\x00/g, (_, index: string) => nativeSpans[Number(index)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_, index: string) => `\`${inlineCodes[Number(index)]}\``);
  result = result.replace(/\x00CB(\d+)\x00/g, (_, index: string) => `\`\`\`${codeBlocks[Number(index)]}\`\`\``);

  return result;
}
