/**
 * `show_widget`: the assistant puts a small card in the thread (a number,
 * a table, meeting quotes, an event) instead of prose. The spec arrives as
 * the call's args and the web draws it from there, so the result only
 * confirms. A spec that does not match the catalog comes back as an error
 * that names what to fix. A Slack turn gets the way to post a chart there.
 */
import { Type, type TSchema } from "typebox";
import type { ToolDef } from "@valet/engine";
import { WIDGET_TOOL_DESCRIPTION, WIDGET_TOOL_NAME, widgetSpecProblems } from "./catalog.js";

function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

export function buildWidgetTools(): ToolDef[] {
  return [defineTool({
    name: WIDGET_TOOL_NAME,
    description: WIDGET_TOOL_DESCRIPTION,
    // The catalog's full JSON schema would ride along on every turn, so the
    // parameters stay loose and the catalog checks the spec on the way in.
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "What the card shows, in a few words. Screen readers and the debug log use it." })),
      // The same loose record `call_tool` uses, which every provider accepts.
      spec: Type.Object({
        root: Type.String({ description: "The key of the top element." }),
        elements: Type.Record(Type.String(), Type.Any(), { description: "Elements by key: { type, props, children }." }),
      }),
    }),
    // Drawing a card reads nothing and changes nothing.
    concurrencySafe: true,
    execute: async ({ spec }, ctx) => {
      const problems = widgetSpecProblems(spec);
      if (problems) return { text: problems, ok: false };
      // Slack shows no cards. Its native chart block takes the Chart props as they are.
      if (ctx.origin?.channelType === "slack") {
        return { text: "Slack does not show cards, so this turn's Slack thread does not see it. Answer in text there, and post each Chart element's { title, chart } with call_tool slack.reply_to_origin as charts (at most 2 per message)." };
      }
      return { text: "The card is in the thread. Don't repeat what it shows." };
    },
  })];
}
