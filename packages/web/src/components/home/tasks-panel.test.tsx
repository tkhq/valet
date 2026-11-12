// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeTaskItem, HomeTasksResponse } from "@valet/api/wire";
import { TasksPanel } from "./tasks-panel";

const dismiss = vi.fn();
let data: HomeTasksResponse;
vi.mock("~/api/home", () => ({
  useHomeTasks: () => ({ data, isPending: false, isError: false, refetch: vi.fn() }),
  useDismissHomeTask: () => ({ mutate: dismiss, isPending: false }),
}));
vi.mock("./approvals-inbox", () => ({ ApprovalsInbox: () => null, UpdatesList: () => null, usePendingApprovalCount: () => ({ count: 0, partial: false }) }));
vi.mock("./task-row", () => ({ TaskRow: ({ item, actions }: { item: HomeTaskItem; actions?: ReactNode }) => <div>{item.title}{actions}</div> }));

const row = (id: string, state: HomeTaskItem["state"]): HomeTaskItem => ({
  id, sessionId: `s-${id}`, threadId: `t-${id}`, title: `Task ${id}`, workspace: { key: "user", name: "Personal" }, state, updatedAt: 1,
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

  it("keeps Done closed until the person opens it", () => {
    render(<TasksPanel />);
    expect(screen.queryByText("Task end")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    expect(dismiss).toHaveBeenCalledWith({ sessionId: "s-end", threadId: "t-end" });
  });
});
