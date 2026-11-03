// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TurnProgress } from "@valet/shared";
import { PinnedPlan, useProgressCardActive } from "./thread-plan";
import { ProcessingStatus, type WorkingLineInput } from "./processing-status";
import { api } from "~/api/client";

const progress: TurnProgress = { turnId: "turn1", title: "Repair retry", status: "interrupted", revision: "1", updatedAt: 1, omittedTasks: 2,
  tasks: [{ id: "a", title: "Read logs", status: "complete" }, { id: "b", title: "Fix retry", status: "pending", details: "Needs follow up", sources: [{ url: "javascript:alert(1)", title: "Unsafe" }] }] };
function setup(snapshot: TurnProgress | null = progress) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["thread-progress", "t"], { progress: snapshot });
  client.setQueryData(["thread-plan", "t"], { plan: { items: [{ text: "Stale plan", status: "pending" }], updatedAt: 1 } });
  return { client, show: () => render(<QueryClientProvider client={client}><PinnedPlan threadId="t" /></QueryClientProvider>) };
}
it("shows one collapsed execution surface and preserves interrupted and unfinished task states", () => {
  const { show } = setup(); show();
  expect(screen.queryByRole("region", { name: "Plan" })).toBeNull();
  expect(screen.getByRole("button", { expanded: false }).textContent).toContain("Interrupted · 1 of 4 done");
  expect(screen.queryByRole("list")).toBeNull();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText("Not started")).toBeTruthy();
  expect(screen.getByText("2 more tasks")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText("Needs follow up")).toBeTruthy();
});
it("does not show a stale plan on a progress error", () => {
  const { client, show } = setup(null);
  client.getQueryCache().find({ queryKey: ["thread-progress", "t"] })?.setState({ status: "error", error: new Error("offline") });
  show();
  expect(screen.getByRole("status").textContent).toBe("Progress unavailable. Refresh to retry.");
  expect(screen.queryByRole("region")).toBeNull();
});
it("shows nothing while loading, not a stale plan", () => {
  const { client, show } = setup(null);
  client.removeQueries({ queryKey: ["thread-progress", "t"] });
  const spy = vi.spyOn(api, "getThreadProgress").mockImplementation(() => new Promise(() => {}));
  show();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("region")).toBeNull();
  spy.mockRestore();
});
it.each(["waiting", "error", "complete"] as const)("shows meaningful %s status without marking pending tasks complete", status => {
  const { show } = setup({ ...progress, status }); show();
  expect(screen.getByRole("button").textContent).toContain({ waiting: "Waiting for input", error: "Failed", complete: "Complete" }[status]);
  expect(screen.getByRole("button").textContent).toContain("1 of 4 done");
});

it("collapses a new turn and renders its public output and sources", () => {
  const { client, show } = setup();
  const view = show();
  fireEvent.click(screen.getByRole("button"));
  client.setQueryData(["thread-progress", "t"], { progress: { ...progress, turnId: "turn2", title: "Next turn", tasks: [{ id: "new", title: "Report", status: "complete", output: "Validated report", sources: [{ url: "https://example.com/report", title: "Report source" }] }], omittedTasks: 0 } });
  view.rerender(<QueryClientProvider client={client}><PinnedPlan threadId="t" /></QueryClientProvider>);
  expect(screen.getByRole("button", { expanded: false }).textContent).toContain("Next turn");
  expect(screen.queryByRole("list")).toBeNull();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText("Validated report")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Report source" }).getAttribute("href")).toBe("https://example.com/report");
  expect(screen.queryByText("Read logs")).toBeNull();
});
it("keeps execution status visible when there are no tasks yet", () => {
  const { show } = setup({ ...progress, status: "pending", tasks: [], omittedTasks: 0 }); show();
  expect(screen.getByRole("button").textContent).toContain("Not started");
  expect(screen.getByRole("button").textContent).not.toContain("0 of 0");
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText("No tasks yet.")).toBeTruthy();
});

it.each([
  { status: "error", label: "Failed", color: "bg-danger-500" },
  { status: "interrupted", label: "Interrupted", color: "bg-amber-500" },
  // Done reads as a check, not a dot.
  { status: "complete", label: "Complete", color: "text-success-600" },
] as const)("colors the root and task $status state independently", ({ status, label, color }) => {
  const { show } = setup({ ...progress, status, tasks: [
    { id: "terminal", title: "Finished attempt", status },
    { id: "pending", title: "Still pending", status: "pending" },
  ] }); show();
  const toggle = screen.getByRole("button");
  expect(within(toggle).getByRole("img", { name: label }).classList.contains(color)).toBe(true);
  fireEvent.click(toggle);
  const tasks = within(screen.getByRole("list")).getAllByRole("listitem");
  expect(within(tasks[0]).getByRole("img", { name: label }).classList.contains(color)).toBe(true);
  expect(within(tasks[1]).getByRole("img", { name: "Not started" }).classList.contains("border-muted")).toBe(true);
  expect(screen.queryByRole("region", { name: "Plan" })).toBeNull();
});

it("shows the Valet mascot, not a dot, while a task is in progress", () => {
  const { show } = setup({ ...progress, status: "in_progress", tasks: [{ id: "now", title: "Working on it", status: "in_progress" }] }); show();
  const mark = within(screen.getByRole("button")).getByRole("img", { name: "In progress" });
  expect(mark.getAttribute("src")).toBe("/icons/valet-mascot.webp");
});

// The thread view's wiring: the card carries the working line while it shows a running turn.
function Rows({ live }: { live: WorkingLineInput }) {
  const inCard = useProgressCardActive("t");
  return <><PinnedPlan threadId="t" live={live} /><ProcessingStatus {...live} inCard={inCard} /></>;
}
function showRows(snapshot: TurnProgress | null, live: WorkingLineInput) {
  const { client } = setup(snapshot);
  return render(<QueryClientProvider client={client}><Rows live={live} /></QueryClientProvider>);
}
const running: TurnProgress = { ...progress, status: "in_progress", omittedTasks: 0, tasks: [
  { id: "a", title: "Read logs", status: "complete" }, { id: "b", title: "Fix retry", status: "in_progress" }, { id: "c", title: "Report", status: "pending" }] };
afterEach(() => { vi.useRealTimers(); });

it("shows one row with one mascot while a running turn has a task card", () => {
  const { container } = showRows(running, { status: "tool_calling" });
  expect(container.querySelectorAll('img[src="/icons/valet-mascot.webp"]')).toHaveLength(1);
  expect(screen.getByRole("button").textContent).toContain("Fix retry · 1 of 3 done");
  // The working line keeps only its announcement.
  expect(screen.getByRole("status").classList.contains("sr-only")).toBe(true);
});
it("says it is wrapping up when every task is done but the turn still runs", () => {
  showRows({ ...running, tasks: running.tasks.map(task => ({ ...task, status: "complete" as const })) }, { status: "streaming" });
  expect(screen.getByRole("button").textContent).toContain("Wrapping up · 3 of 3 done");
  expect(screen.getByRole("button").textContent).not.toContain("In progress");
});
it("shows the turn's clock in the card", () => {
  vi.useFakeTimers({ now: 100_000 });
  showRows(running, { status: "tool_calling", startedAt: 25_000 });
  expect(screen.getByRole("button").textContent).toContain("1m 15s");
});
it("puts waiting, compacting and retry notices in the card in place of the task", () => {
  const view = showRows(running, { status: "tool_calling", compacting: true });
  expect(screen.getByRole("button").textContent).toContain("Valet is compacting context… · 1 of 3 done");
  view.unmount();
  showRows({ ...running, status: "waiting" }, { status: "blocked_on_decision_gate", needsResponse: true });
  expect(screen.getByRole("button").textContent).toContain("Valet is waiting for a response · 1 of 3 done");
});
it("keeps the working line as its own row when there is no task card", () => {
  const { container } = showRows(null, { status: "thinking" });
  expect(screen.getByRole("status").textContent).toBe("Valet is thinking…");
  expect(screen.getByRole("status").classList.contains("sr-only")).toBe(false);
  expect(container.querySelectorAll('img[src="/icons/valet-mascot.webp"]')).toHaveLength(1);
});
it("keeps the working line as its own row under a finished task card", () => {
  showRows({ ...running, status: "complete" }, { status: "thinking" });
  expect(screen.getByRole("status").textContent).toBe("Valet is thinking…");
  expect(screen.getByRole("button").textContent).toContain("Complete · 1 of 3 done");
});
