import { ListChecks } from "lucide-react";
import { planProgress, readThreadPlanItems } from "@valet/shared";
import { PlanChecklist } from "../thread-plan";
import { ToolBody } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

/** The checklist the call sent, or undefined while its args are incomplete. */
function planItems(args: unknown) {
  return typeof args === "object" && args !== null && "items" in args ? readThreadPlanItems(args.items) : undefined;
}

/** `update_plan`: one line with the plan's progress; the checklist on expand. */
export const updatePlanRenderer: ToolRenderer = {
  matches: "update_plan",
  category: "thread",
  Icon: ListChecks,
  formatTarget: () => "Updated the plan",
  formatSummary: (args, _result, status) => {
    const items = planItems(args);
    if (!items || status === "error") return undefined;
    const { done, total } = planProgress({ items });
    return `${done} of ${total}`;
  },
  Body: ({ args, result, status, error }) => {
    const items = planItems(args);
    if (status === "error" || !items) {
      return <ToolBody><p className="whitespace-pre-wrap text-muted">{error || resultText(result) || "The plan did not change."}</p></ToolBody>;
    }
    return <ToolBody><PlanChecklist items={items} /></ToolBody>;
  },
};
