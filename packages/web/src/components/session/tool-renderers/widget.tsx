import { LayoutDashboard } from "lucide-react";
import { WIDGET_TOOL_NAME, widgetSpecProblems, type WidgetSpec } from "@valet/api/widgets";
import { WidgetView } from "../widgets/widget-view";
import { fallbackRenderer } from "./fallback";
import type { ToolRenderer } from "./types";

function widgetArgs(args: unknown): { spec?: unknown; title?: string } {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as { spec?: unknown; title?: string }) : {};
}

/** Pure: the spec to draw, when it matches the catalog. A spec the api refused draws nothing; the model fixes it. */
export function drawableSpec(args: unknown): WidgetSpec | undefined {
  const { spec } = widgetArgs(args);
  // `widgetSpecProblems` checks this shape against the catalog before the cast.
  return spec !== undefined && widgetSpecProblems(spec) === undefined ? (spec as WidgetSpec) : undefined;
}

/**
 * `show_widget`: the card itself is the message, so once the call finishes
 * only the widget shows. While the model still writes it, the call shows as
 * an ordinary tool card.
 */
export const widgetRenderer: ToolRenderer = {
  matches: WIDGET_TOOL_NAME,
  category: "generic",
  Icon: LayoutDashboard,
  formatTarget: (args) => widgetArgs(args).title,
  Body: fallbackRenderer.Body,
  bare: true,
  Preview: ({ args, status }) => {
    if (status !== "completed") return null;
    const spec = drawableSpec(args);
    return spec ? <WidgetView spec={spec} title={widgetArgs(args).title} /> : null;
  },
};
