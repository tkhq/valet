import { Type } from "typebox";
import {
  planProgress,
  THREAD_PLAN_MAX_ITEMS,
  THREAD_PLAN_MAX_TEXT,
  type ThreadPlan,
} from "@valet/shared";
import { defineTool } from "./define.js";

const MARKERS = { done: "[x]", in_progress: "[>]", pending: "[ ]" } as const;

/**
 * The system section that shows the thread's plan to the model at the start
 * of each turn (`Thread.applyPlanForTurn`). It is an overlay, not a
 * transcript entry, so compaction cannot remove it. Undefined when every
 * item is done: a finished plan needs no reminder.
 */
export function planOverlay(plan: ThreadPlan): string | undefined {
  if (plan.items.every((item) => item.status === "done")) return undefined;
  return [
    "## Your current plan",
    "",
    ...plan.items.map((item) => `${MARKERS[item.status]} ${item.text}`),
    "",
    "Keep it current with update_plan.",
  ].join("\n");
}

export const updatePlanTool = defineTool({
  name: "update_plan",
  description:
    "Replace this thread's plan: a short checklist for work with three or more steps. " +
    "Send every item each time, in order. Keep exactly one item in_progress. " +
    "Mark an item done only when the step is complete. You see the open plan " +
    "at the start of every turn, also after compaction.",
  parameters: Type.Object({
    items: Type.Array(
      Type.Object({
        text: Type.String({ minLength: 1, maxLength: THREAD_PLAN_MAX_TEXT, pattern: "\\S", description: "One step, in a few words." }),
        status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")]),
      }),
      { minItems: 1, maxItems: THREAD_PLAN_MAX_ITEMS },
    ),
  }),
  execute: async (args, ctx) => {
    if (!ctx.setThreadPlan) return { text: "This session cannot keep a plan. List the steps in your reply.", ok: false };
    // Store only the known fields: the schema lets an item carry others.
    const { done, total, current } = planProgress(await ctx.setThreadPlan(args.items.map(({ text, status }) => ({ text, status }))));
    return { text: `Plan updated: ${done} of ${total} done.${current !== undefined ? ` Now: ${current}` : ""}` };
  },
});
