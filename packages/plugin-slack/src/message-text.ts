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

/** The lines of one Block Kit block. Buttons, selects, images, dividers, and
 *  inputs carry no message content and give no lines. */
function blockLines(block: unknown): string[] {
  if (!isObj(block)) return [];
  switch (block.type) {
    case "header":
      return [textObject(block.text)];
    case "section":
      return [textObject(block.text), ...list(block.fields).map(textObject)];
    case "context":
      return [list(block.elements).map(textObject).filter(Boolean).join(" ")];
    case "markdown":
      return [str(block.text)];
    case "rich_text":
      return list(block.elements).flatMap(richLines);
    default:
      return [];
  }
}

/** The lines of one legacy attachment. `fallback` counts only when the
 *  attachment has nothing else, because it repeats the rest. */
function attachmentLines(att: unknown): string[] {
  if (!isObj(att)) return [];
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
    ...list(att.blocks).flatMap(blockLines),
    str(att.footer),
  ];
  return lines.some((line) => line.trim()) ? lines : [str(att.fallback)];
}

/**
 * The text of a message's `blocks` and `attachments`, one line per field,
 * without lines that repeat the top-level `text` or an earlier line. Empty
 * when the blocks and attachments add nothing beyond `text`, as for a plain
 * human message, whose only block is a rich-text copy of `text`. Capped at
 * MESSAGE_CONTENT_MAX_CHARS.
 */
export function slackMessageExtraText(msg: Record<string, unknown>): string {
  const text = str(msg.text).trim();
  const textLines = new Set(text.split("\n").map((line) => line.trim()).filter(Boolean));
  const seen = new Set<string>();
  const out: string[] = [];
  // A person's message carries one rich_text block that mirrors `text`, with
  // links and formatting written another way. Only a bot or app post, or a
  // message with no `text`, gets content from rich_text.
  const mirror = Boolean(text) && !msg.bot_id && msg.subtype !== "bot_message";
  const blocks = list(msg.blocks).filter((block) => !(mirror && isObj(block) && block.type === "rich_text"));
  const lines = [...blocks.flatMap(blockLines), ...list(msg.attachments).flatMap(attachmentLines)];
  for (const raw of lines) {
    const line = raw.trimEnd();
    const key = line.trim();
    if (!key || textLines.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  const joined = out.join("\n");
  // The whole of `text` can arrive as one block line with its line breaks.
  if (!joined || joined.trim() === text) return "";
  return joined.length > MESSAGE_CONTENT_MAX_CHARS ? `${joined.slice(0, MESSAGE_CONTENT_MAX_CHARS)}…` : joined;
}
