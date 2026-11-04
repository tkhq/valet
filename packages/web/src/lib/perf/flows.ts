import type { FlowName } from "./budgets";

/** The parts of a router location that name a flow. */
export interface FlowLocation {
  pathname: string;
  search: Record<string, unknown>;
}

const PAGE_FLOWS: Record<string, FlowName> = {
  "/workflows": "workflows.open",
  "/presence": "presence.open",
  "/integrations": "integrations.open",
};

/**
 * Names a navigation for the budget table. Returns `route:<path>` for a
 * navigation that is not a key flow, so the overlay still lists it.
 */
export function flowForNavigation(from: FlowLocation | undefined, to: FlowLocation): string {
  const path = to.pathname.replace(/\/+$/, "") || "/";
  // A thread link can carry another space's key too: it still opens a thread.
  if (path === "/chat" && to.search.thread !== undefined && from?.search.thread !== to.search.thread) return "thread.open";
  // A space's name keeps the page you are on, or opens its Threads.
  const samePage = from !== undefined && (from.pathname.replace(/\/+$/, "") || "/") === path;
  if (from && (samePage || path === "/chat") && to.search.workspace !== undefined && from.search.workspace !== to.search.workspace) {
    return "space.switch";
  }
  if (path === "/" && to.search.view === "tasks" && from?.search.view !== "tasks") return "tasks.open";
  const page = PAGE_FLOWS[path];
  if (page) return page;
  return `route:${path}`;
}

const PRESSABLE = "a[href], button, summary, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch]";

/** A named press. `tagged` presses come from a `data-perf-flow` control and start a flow. */
export interface PressName {
  name: string;
  tagged: boolean;
}

/**
 * Names the control a click or key press landed on: the nearest
 * `data-perf-flow`, else the control's role and label. Returns undefined for
 * presses that are not on a control (text selection, typing), which the
 * monitor does not record.
 */
export function interactionName(target: EventTarget | null, type: string, key?: string): PressName | undefined {
  if (!(target instanceof Element) || target.closest("[data-perf-overlay]")) return undefined;
  if (type === "keydown") {
    // Enter in a form field submits its form: credit the form's submit control.
    if (key === "Enter" && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
      const flow = target.form?.querySelector<HTMLElement>("[type=submit][data-perf-flow]")?.dataset.perfFlow;
      return flow ? { name: flow, tagged: true } : undefined;
    }
    if (key !== "Enter" && key !== " " && key !== "Escape") return undefined;
  }
  const tagged = target.closest<HTMLElement>("[data-perf-flow]");
  if (tagged?.dataset.perfFlow) return { name: tagged.dataset.perfFlow, tagged: true };
  const control = target.closest<HTMLElement>(PRESSABLE);
  if (!control) return undefined;
  const role = control.getAttribute("role") ?? control.tagName.toLowerCase();
  const label = (control.getAttribute("aria-label") ?? control.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 32);
  return { name: `${role}:${label}`, tagged: false };
}
