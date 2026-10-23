// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ThreadPlan, ThreadPlanResponse } from "@valet/api/wire";
import { PinnedPlan, PlanProgress } from "./thread-plan";

const PLAN: ThreadPlan = {
  items: [
    { text: "Read the failing test", status: "done" },
    { text: "Fix the parser", status: "done" },
    { text: "Run the full suite and compare the timings with the last green build on the main branch", status: "in_progress" },
    { text: "Open the pull request", status: "pending" },
    { text: "Answer review comments", status: "pending" },
  ],
  updatedAt: 1,
};

function renderPlan(plans: Record<string, ThreadPlan | null>, threadId: string | undefined = "t1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [id, plan] of Object.entries(plans)) client.setQueryData<ThreadPlanResponse>(["thread-plan", id], { plan });
  const view = (id: string | undefined) => <QueryClientProvider client={client}><PinnedPlan threadId={id} /></QueryClientProvider>;
  const result = render(view(threadId));
  return { rerender: (id: string) => result.rerender(view(id)) };
}

describe("PinnedPlan", () => {
  it("shows one collapsed row with progress and the current item", () => {
    renderPlan({ t1: PLAN });
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle.textContent).toContain("Plan · 2 of 5");
    expect(toggle.textContent).toContain("Run the full suite");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("opens the full checklist with each item's state", () => {
    renderPlan({ t1: PLAN });
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const list = screen.getByRole("list");
    expect(screen.getByRole("button", { expanded: true }).getAttribute("aria-controls")).toBe(list.id);
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(PLAN.items.map((item) => item.text));
    expect(within(items[0]).getByRole("img", { name: "Done" })).toBeTruthy();
    expect(within(items[2]).getByRole("img", { name: "In progress" })).toBeTruthy();
    expect(within(items[3]).getByRole("img", { name: "Not started" })).toBeTruthy();
    expect(items[0].querySelector(".line-through")).not.toBeNull();
    expect(items[2].querySelector(".font-medium")).not.toBeNull();
  });

  it("says the plan is done when every item is done", () => {
    renderPlan({ t1: { ...PLAN, items: PLAN.items.map((item) => ({ ...item, status: "done" })) } });
    expect(screen.getByRole("button", { expanded: false }).textContent).toContain("Plan done · 5 of 5");
  });

  it("collapses again on another thread", () => {
    const { rerender } = renderPlan({ t1: PLAN, t2: PLAN });
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("list")).toBeTruthy();
    rerender("t2");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders nothing without a plan or a thread", () => {
    renderPlan({ t1: null });
    expect(screen.queryByRole("region", { name: "Plan" })).toBeNull();
    renderPlan({}, undefined);
    expect(screen.queryByRole("region", { name: "Plan" })).toBeNull();
  });
});

describe("PlanProgress", () => {
  it("reads as a count with an optional label", () => {
    const { container, rerender } = render(<PlanProgress done={2} total={5} />);
    expect(container.textContent).toBe("2 of 5");
    rerender(<PlanProgress done={0} total={3} label="Tasks" />);
    expect(container.textContent).toBe("Tasks · 0 of 3");
  });
});
