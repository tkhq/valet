/**
 * `show_brief`: the assistant shows a status summary as a card, drawn like
 * the Home brief: a headline that counts the work, then one row per item
 * with a state dot, a bold topic, and one line. An item can open a task
 * thread or a web link. The web draws the card from the call's args, so the
 * result only confirms. A channel turn (Slack) gets the brief back as
 * Markdown to post, because a channel shows no cards.
 */
import { Type, type Static, type TSchema } from "typebox";
import type { ToolDef } from "@valet/engine";

export const BRIEF_TOOL_NAME = "show_brief";

function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

const BRIEF_STATES = ["needs_you", "working", "done", "fyi"] as const;
type BriefState = typeof BRIEF_STATES[number];

const briefParams = Type.Object({
  headline: Type.String({ minLength: 1, maxLength: 160, description: "One line that counts the items, such as \"Morning. 4 in progress, 2 need you.\"" }),
  items: Type.Array(Type.Object({
    topic: Type.String({ minLength: 1, maxLength: 40, description: "Two to four words, such as \"Series A\" or \"TKAI-512\"." }),
    text: Type.String({ minLength: 1, maxLength: 240, description: "One line: what is ready, or what you need from them." }),
    state: Type.Union(BRIEF_STATES.map((state) => Type.Literal(state))),
    thread_id: Type.Optional(Type.String({ description: "A thread id from list_tasks or list_threads, when the item is about that thread." })),
    href: Type.Optional(Type.String({ pattern: "^https?://", description: "A web link the item opens, such as a pull request, when it has no thread." })),
  }), { maxItems: 12 }),
});

export type Brief = Static<typeof briefParams>;

const MARK: Record<BriefState, string> = { needs_you: "🟠", working: "🔵", done: "🟢", fyi: "⚪" };

/** A brief as Markdown for a channel that shows no cards: the bold headline, then one line per item. */
export function briefMarkdown(brief: Brief): string {
  return [`**${brief.headline}**`, ...brief.items.map((item) =>
    `- ${MARK[item.state] ?? MARK.fyi} **${item.topic}:** ${item.text}${item.href ? ` [Open](${item.href})` : ""}`)].join("\n");
}

export function buildBriefTool(): ToolDef {
  return defineTool({
    name: BRIEF_TOOL_NAME,
    ownerOnly: true,
    concurrencySafe: true,
    description:
      "Show the person a status summary as a card in this conversation: a one-line headline, then up to 12 items, the ones that need them first. " +
      "Each item has a short topic, one line, and a state dot, and it can open a thread or a web link. " +
      "Use it when the person asks what is going on, what needs them, or for the status of several pieces of work. " +
      "Use a Markdown table or show_widget for other rows of data. The card is the whole answer: write nothing after it.",
    parameters: briefParams,
    execute: async (args, ctx) => {
      if (!ctx.origin) return { text: `Brief shown: ${args.headline} (${args.items.length} items). The card is the answer: write nothing after it.` };
      const how = ctx.origin.channelType === "slack" ? "Post this text with call_tool slack.reply_to_origin instead" : "Answer there with this text instead";
      return { text: `This channel shows no cards, so its thread does not see the brief. ${how}:\n\n${briefMarkdown(args)}` };
    },
  });
}
