import { fromMarkdown } from "mdast-util-from-markdown";

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

/** Native spans need mrkdwn blocks; Markdown blocks do not document them. */
export function containsSlackSpans(text: string): boolean {
  // Detect prefixes without backtracking over an unterminated span. A false
  // positive only selects the existing mrkdwn formatter.
  return /<(?:[@#!]|https?:\/\/)/.test(text);
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

const GITHUB_REFERENCE = /\[[^\]]*\]\([^\n]*?\)|(?:&lt;|<)[^>\n]*>|https?:\/\/[^\s<>]+|(?<![\w./:@\\-])([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9_.-]+)#([1-9][0-9]*)(?![\w/#])/g;

/** Bound optional autolinking before the synchronous CommonMark parser runs.
 * Nested link syntax can take quadratic work even within Slack's size limit.
 * Preserve complex input verbatim; explicit links still render in Slack.
 */
function withinAutolinkBudget(text: string): boolean {
  return text.includes("#") && withinMarkdownParseBudget(text);
}

/** The synchronous CommonMark work budget: at most 12,000 characters and 256
 * ASCII punctuation, tab, or line-break characters. Every optional parse of
 * untrusted text checks this first so nested link syntax cannot block the
 * event loop for seconds. */
export function withinMarkdownParseBudget(text: string): boolean {
  if (text.length > 12_000) return false;
  let punctuation = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // All ASCII punctuation, tabs, and line breaks can affect Markdown syntax.
    if ((code >= 33 && code <= 47) || (code >= 58 && code <= 64)
      || (code >= 91 && code <= 96) || (code >= 123 && code <= 126)
      || code === 9 || code === 10 || code === 13) {
      punctuation += 1;
      if (punctuation > 256) return false;
    }
  }
  return true;
}

/** Link only Markdown text nodes, preserving the original source layout. */
export function linkGitHubReferencesInMarkdown(text: string): string {
  if (!withinAutolinkBudget(text)) return text;
  const tree = fromMarkdown(text);
  type MarkdownNode = typeof tree | (typeof tree.children)[number];
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "link" || node.type === "linkReference"
      || node.type === "image" || node.type === "imageReference") return;
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const source = text.slice(start, end);
      const linked = source.replace(GITHUB_REFERENCE,
        (match: string, owner: string | undefined, repo: string | undefined, number: string | undefined) => {
          if (owner === undefined || repo === undefined || number === undefined) return match;
          const label = match.replace(/_/g, "\\_");
          return `[${label}](https://github.com/${owner}/${repo}/issues/${number})`;
        });
      if (linked !== source) edits.push({ start, end, text: linked });
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  visit(tree);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return text;
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
  // A fence closes only with the same character and at least its opening
  // length. Shorter fences inside examples remain literal code.
  const lines = text.replace(/\x00/g, "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^ {0,3}(`{3,})(?!`)[^`]*$|^ {0,3}(~{3,})[^\n]*$/.exec(lines[index]);
    if (!opening) continue;
    const fence = opening[1] ?? opening[2];
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`);
    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end])) end += 1;
    codeBlocks.push(lines.slice(index + 1, end).join("\n").trimEnd());
    lines.splice(index, Math.min(end + 1, lines.length) - index, `\x00CB${codeBlocks.length - 1}\x00`);
  }
  let result = lines.join("\n").replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_, code: string) => {
    codeBlocks.push(code.trimEnd());
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes: string[] = [];
  result = result.replace(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g, (span: string) => {
    inlineCodes.push(span);
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
  // Explicit repository references need no ambient repository or issue type.
  // Hold generated links so underscores in repository names stay literal.
  // Existing links and URLs own their labels and fragments.
  const githubLinks: string[] = [];
  result = result.replace(
    GITHUB_REFERENCE,
    (match: string, owner: string | undefined, repo: string | undefined, number: string | undefined) => {
      if (owner === undefined || repo === undefined || number === undefined) return match;
      githubLinks.push(`<https://github.com/${owner}/${repo}/issues/${number}|${match}>`);
      return `\x00GH${githubLinks.length - 1}\x00`;
    },
  );
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
  result = result.replace(/\x00GH(\d+)\x00/g, (_, index: string) => githubLinks[Number(index)]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_, index: string) => inlineCodes[Number(index)]);
  result = result.replace(/\x00CB(\d+)\x00/g, (_, index: string) => `\`\`\`${codeBlocks[Number(index)]}\`\`\``);

  return result;
}
