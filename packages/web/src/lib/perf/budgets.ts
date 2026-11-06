/**
 * Latency budgets for the web app, in milliseconds. The debug overlay and the
 * CI check (`packages/web/perf/run.mjs`) both read this file.
 *
 * The CI check runs a production build at 4x CPU slowdown against mocked
 * api fixtures, so network time is near zero. A budget here bounds the work
 * the browser does: script, render, layout and paint.
 */

/** A press shows its pressed state or optimistic result within this time. */
export const FEEDBACK_BUDGET_MS = 100;

/** A navigation paints its page, or the page's loading state, within this time. */
export const LOADING_STATE_BUDGET_MS = 200;

export type FlowName =
  | "thread.open"
  | "space.switch"
  | "message.send"
  | "tasks.open"
  | "workflows.open"
  | "presence.open"
  | "integrations.open";

/**
 * Trigger to the paint after a flow's first data loads settle (`data`
 * kind). Each value is the measured p95 (desktop and 375px, after the fixes
 * that came with this file) plus about 30% for runner noise, rounded up.
 * A thread's first paint parses Markdown, so the two thread flows get most.
 */
export const DATA_BUDGETS: Record<FlowName, number> = {
  "thread.open": 400, // p95 336
  "space.switch": 400, // p95 294
  "message.send": FEEDBACK_BUDGET_MS, // the optimistic bubble, p95 57
  "tasks.open": 200, // p95 98
  "workflows.open": 300, // p95 212
  "presence.open": 200, // p95 121
  "integrations.open": 200, // p95 103
};

export type MeasurementKind = "interaction" | "route" | "data";

function isFlowName(flow: string): flow is FlowName {
  return Object.hasOwn(DATA_BUDGETS, flow);
}

/**
 * The budget for one measurement. A press (`interaction`) gets the feedback
 * budget, a navigation's first paint (`route`) the loading-state budget.
 */
export function budgetFor(kind: MeasurementKind, flow: string): number {
  if (kind === "interaction") return FEEDBACK_BUDGET_MS;
  if (kind === "route") return LOADING_STATE_BUDGET_MS;
  return isFlowName(flow) ? DATA_BUDGETS[flow] : LOADING_STATE_BUDGET_MS;
}
