/**
 * The readable text of a Slack message beyond its top-level `text`.
 *
 * A bot, app, or workflow post often puts its real content in Block Kit
 * `blocks` or legacy `attachments`, and leaves `text` as a one-line summary
 * or notification fallback. A read action that returns `text` alone then
 * hides fields such as "Promotion: …" from the assistant.
 */

/** The longest flattened content one message returns. */
export const MESSAGE_CONTENT_MAX_CHARS = 4_000;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The text of a `plain_text` or `mrkdwn` text object. */
function textObject(value: unknown): string {
  return isObj(value) ? str(value.text) : "";
}

/** One rich-text inline element as Slack shows it. A mention keeps Slack's
 *  `<@U…>` and `<#C…>` form, so the read action resolves it like `text`. */
function richInline(el: unknown): string {
  if (!isObj(el)) return "";
  switch (el.type) {
    case "text":
      return str(el.text);
    case "link":
      return str(el.text) || str(el.url);
    case "user":
      return el.user_id ? `<@${str(el.user_id)}>` : "";
    case "channel":
      return el.channel_id ? `<#${str(el.channel_id)}>` : "";
    case "usergroup":
      return el.usergroup_id ? `<!subteam^${str(el.usergroup_id)}>` : "";
    case "broadcast":
      return el.range ? `@${str(el.range)}` : "";
    case "emoji":
      return el.name ? `:${str(el.name)}:` : "";
    case "date":
      return str(el.fallback);
    default:
      return "";
  }
}

/** The lines of one rich-text container: a section, quote, preformatted
 *  block, or list. */
function richLines(container: unknown): string[] {
  if (!isObj(container)) return [];
  const inline = () => list(container.elements).map(richInline).join("");
  switch (container.type) {
    case "rich_text_section":
    case "rich_text_preformatted":
      return inline().split("\n");
    case "rich_text_quote":
      return inline().split("\n").map((line) => `> ${line}`);
    case "rich_text_list": {
      const ordered = container.style === "ordered";
      return list(container.elements).flatMap((item, i) =>
        richLines(item).map((line, j) => (j === 0 ? `${ordered ? `${i + 1}.` : "•"} ${line}` : `  ${line}`)),
      );
    }
    default:
      return [];
  }
}

/** One block or attachment's lines. `mirror` marks main text that a bot
 * often copies from `text` in another format (a section's text, a header, a
 * markdown or rich-text block); fields and context are never a copy. */
interface Group {
  lines: string[];
  mirror: boolean;
}

/** The groups of one Block Kit block. Buttons, selects, images, dividers, and
 *  inputs carry no message content and give none. */
function blockGroups(block: unknown): Group[] {
  if (!isObj(block)) return [];
  switch (block.type) {
    case "header":
      return [{ lines: [textObject(block.text)], mirror: true }];
    case "section":
      return [
        { lines: [textObject(block.text)], mirror: true },
        { lines: list(block.fields).map(textObject), mirror: false },
      ];
    case "context":
      return [{ lines: [list(block.elements).map(textObject).filter(Boolean).join(" ")], mirror: false }];
    case "markdown":
      return [{ lines: [str(block.text)], mirror: true }];
    case "rich_text":
      return [{ lines: list(block.elements).flatMap(richLines), mirror: true }];
    default:
      return [];
  }
}

/** A link preview Slack attached to a message: the linked page's own title
 *  and text, which nobody in the conversation wrote. A forwarded message
 *  (`is_msg_unfurl`) is kept. */
function isLinkPreview(att: Obj): boolean {
  return !att.is_msg_unfurl && (Boolean(att.from_url) || att.is_app_unfurl === true || Boolean(att.original_url));
}

/** The group of one legacy attachment. `fallback` counts only when the
 *  attachment has nothing else, because it repeats the rest. */
function attachmentGroups(att: unknown): Group[] {
  if (!isObj(att) || isLinkPreview(att)) return [];
  const title = str(att.title);
  const lines = [
    str(att.pretext),
    str(att.author_name),
    title && att.title_link ? `${title} (${str(att.title_link)})` : title,
    str(att.text),
    ...list(att.fields).map((field) => {
      if (!isObj(field)) return "";
      const name = str(field.title);
      const value = str(field.value);
      return name && value ? `${name}: ${value}` : name || value;
    }),
    str(att.footer),
  ];
  const own: Group = { lines: lines.some((line) => line.trim()) ? lines : [str(att.fallback)], mirror: false };
  return [own, ...list(att.blocks).flatMap(blockGroups)];
}

/** The words of a text, lowercased, with Slack and Markdown link markup
 *  reduced to its label, so the same words in mrkdwn and Markdown match. */
function words(text: string): string[] {
  const plain = text
    .replace(/<([^>|]+)\|([^>]+)>/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  return plain.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * The text of a message's `blocks` and `attachments`, one line per field.
 * It leaves out a main-text block whose words all appear in the top-level
 * `text` (the same content in another format), lines equal to a line of
 * `text`, a line repeated within one block or attachment, and link
 * previews. Empty when the rest adds nothing, as for a plain human message,
 * whose only block is a rich-text copy of `text`. Capped at
 * MESSAGE_CONTENT_MAX_CHARS.
 */
export function slackMessageExtraText(msg: Record<string, unknown>): string {
  const text = str(msg.text).trim();
  const textLines = new Set(text.split("\n").map((line) => line.trim()).filter(Boolean));
  const textWords = new Set(words(text));
  // A person's message carries one rich_text block that mirrors `text`, with
  // links and formatting written another way. Only a bot or app post, or a
  // message with no `text`, gets content from rich_text.
  const person = Boolean(text) && !msg.bot_id && msg.subtype !== "bot_message";
  const blocks = list(msg.blocks).filter((block) => !(person && isObj(block) && block.type === "rich_text"));
  const groups = [...blocks.flatMap(blockGroups), ...list(msg.attachments).flatMap(attachmentGroups)];
  const out: string[] = [];
  for (const group of groups) {
    const lines = group.lines.flatMap((line) => line.split("\n"));
    if (group.mirror && textWords.size > 0) {
      const own = words(lines.join(" "));
      if (own.length > 0 && own.every((w) => textWords.has(w))) continue;
    }
    const seen = new Set<string>();
    for (const raw of lines) {
      const line = raw.trimEnd();
      const key = line.trim();
      if (!key || textLines.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  const joined = out.join("\n");
  return joined.length > MESSAGE_CONTENT_MAX_CHARS ? `${joined.slice(0, MESSAGE_CONTENT_MAX_CHARS)}…` : joined;
}
