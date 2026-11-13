// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeTaskItem, HomeTasksResponse } from "@valet/api/wire";
import { STALE_AFTER_MS, TasksPanel, splitStale } from "./tasks-panel";

const dismiss = vi.fn();
let data: HomeTasksResponse;
vi.mock("~/api/home", () => ({
  useHomeTasks: () => ({ data, isPending: false, isError: false, refetch: vi.fn() }),
  useDismissHomeTask: () => ({ mutate: dismiss, isPending: false }),
}));
vi.mock("./approvals-inbox", () => ({ ApprovalsInbox: () => null, UpdatesList: () => null, usePendingApprovalCount: () => ({ count: 0, partial: false }) }));
vi.mock("./task-row", () => ({ TaskRow: ({ item, actions }: { item: HomeTaskItem; actions?: ReactNode }) => <div>{item.title}{actions}</div> }));

const row = (id: string, state: HomeTaskItem["state"], updatedAt = Date.now()): HomeTaskItem => ({
  id, sessionId: `s-${id}`, threadId: `t-${id}`, title: `Task ${id}`, workspace: { key: "user", name: "Personal" }, state, updatedAt,
});

describe("TasksPanel", () => {
  beforeEach(() => {
    dismiss.mockReset();
    data = { needsYou: [row("ask", "waiting")], working: [row("run", "working")], finished: [row("end", "done")] };
  });

  it("crosses out a task waiting on the person or in progress", () => {
    render(<TasksPanel />);
    expect(screen.getByRole("region", { name: "Waiting on you" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Replies" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark done: Task ask" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark done: Task run" }));
    expect(dismiss.mock.calls.map(([thread]) => thread)).toEqual([
      { sessionId: "s-ask", threadId: "t-ask" }, { sessionId: "s-run", threadId: "t-run" }]);
  });

  it("shows finished work as Ready for review without a Show click", () => {
    render(<TasksPanel />);
    expect(screen.getByRole("region", { name: "Ready for review" })).toBeTruthy();
    expect(screen.getByText("Task end")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    expect(dismiss).toHaveBeenCalledWith({ sessionId: "s-end", threadId: "t-end" });
  });

  it("folds a row untouched for a week behind Show older", () => {
    data = { needsYou: [row("fresh", "waiting"), row("stale", "waiting", Date.now() - STALE_AFTER_MS - 1000)], working: [], finished: [] };
    render(<TasksPanel />);
    expect(screen.getByText("Task fresh")).toBeTruthy();
    expect(screen.queryByText("Task stale")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 older" }));
    expect(screen.getByText("Task stale")).toBeTruthy();
  });

  it("splits rows at the stale age", () => {
    const now = 10 * STALE_AFTER_MS;
    const items = [{ updatedAt: now }, { updatedAt: now - STALE_AFTER_MS }, { updatedAt: now - STALE_AFTER_MS - 1 }];
    expect(splitStale(items, now)).toEqual({ recent: items.slice(0, 2), older: items.slice(2) });
  });
});
