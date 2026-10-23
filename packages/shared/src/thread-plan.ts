/**
 * A thread's plan: the short checklist that the model keeps with the
 * `update_plan` tool. The engine stores it in thread metadata under
 * `THREAD_PLAN_KEY` and shows the open plan to the model at the start of
 * each turn. The API and the web view read the same shape.
 */

export type ThreadPlanStatus = "pending" | "in_progress" | "done";

export interface ThreadPlanItem {
  text: string;
  status: ThreadPlanStatus;
}

export interface ThreadPlan {
  items: ThreadPlanItem[];
  updatedAt: number;
}

/** Key in thread metadata that holds the `ThreadPlan`. */
export const THREAD_PLAN_KEY = "plan";
export const THREAD_PLAN_MAX_ITEMS = 20;
export const THREAD_PLAN_MAX_TEXT = 200;

const STATUSES: readonly ThreadPlanStatus[] = ["pending", "in_progress", "done"];

/** The plan items in `value`, or undefined when `value` is not 1 to 20 valid items. */
export function readThreadPlanItems(value: unknown): ThreadPlanItem[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > THREAD_PLAN_MAX_ITEMS) return undefined;
  const items: ThreadPlanItem[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || !("text" in item) || !("status" in item)) return undefined;
    const { text } = item;
    const status = STATUSES.find((known) => known === item.status);
    if (typeof text !== "string" || text.trim().length === 0 || text.length > THREAD_PLAN_MAX_TEXT || !status) return undefined;
    items.push({ text, status });
  }
  return items;
}

/** The plan stored in thread `metadata`, or undefined when there is none or it is not valid. */
export function readThreadPlan(metadata: Record<string, unknown> | undefined): ThreadPlan | undefined {
  const value = metadata?.[THREAD_PLAN_KEY];
  if (typeof value !== "object" || value === null || !("items" in value) || !("updatedAt" in value)) return undefined;
  const items = readThreadPlanItems(value.items);
  const { updatedAt } = value;
  if (!items || typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined;
  return { items, updatedAt };
}

/** How far a plan is: done items, all items, and the text of the first `in_progress` item. */
export function planProgress(plan: Pick<ThreadPlan, "items">): { done: number; total: number; current?: string } {
  const current = plan.items.find((item) => item.status === "in_progress")?.text;
  return {
    done: plan.items.filter((item) => item.status === "done").length,
    total: plan.items.length,
    ...(current !== undefined ? { current } : {}),
  };
}
