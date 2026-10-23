/**
 * `show_widget`: the assistant puts a small card in the thread (a number,
 * a table, meeting quotes, an event) instead of prose. The spec arrives as
 * the call's args and the web draws it from there, so the result only
 * confirms. A spec that does not match the catalog comes back as an error
 * that names what to fix.
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
    execute: async ({ spec }) => {
      const problems = widgetSpecProblems(spec);
      if (problems) return { text: problems, ok: false };
      return { text: "The card is in the thread. Don't repeat what it shows." };
    },
  })];
}
