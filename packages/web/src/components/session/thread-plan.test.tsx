// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, renderHook, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ThreadPlan, ThreadPlanResponse } from "@valet/api/wire";
import { PinnedPlan, PlanProgress, useCurrentStep } from "./thread-plan";

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
  it("lists every step with its mark, as a to-do list", () => {
    renderPlan({ t1: PLAN });
    const steps = within(screen.getByRole("region", { name: "Plan" })).getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(steps.map(step => within(step).getByRole("img").getAttribute("aria-label"))).toEqual(["Done", "Done", "In progress", "Not started", "Not started"]);
    expect(steps[2]!.textContent).toContain("Run the full suite");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("leaves once every step is done", () => {
    renderPlan({ t1: { ...PLAN, items: PLAN.items.map(item => ({ ...item, status: "done" as const })) } });
    expect(screen.queryByRole("region", { name: "Plan" })).toBeNull();
  });

  it("follows the open thread", () => {
    const { rerender } = renderPlan({ t1: PLAN, t2: { items: [{ text: "Other thread step", status: "in_progress" }], updatedAt: 1 } });
    rerender("t2");
    expect(within(screen.getByRole("region", { name: "Plan" })).getAllByRole("listitem").map(step => step.textContent)).toEqual(["Other thread step"]);
  });

  it("names the step in progress for the working line", () => {
    const client = new QueryClient();
    client.setQueryData<ThreadPlanResponse>(["thread-plan", "t1"], { plan: PLAN });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    expect(renderHook(() => useCurrentStep("t1"), { wrapper }).result.current).toContain("Run the full suite");
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
