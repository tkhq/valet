// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ListNotificationDecisionsResponse } from "@valet/api/wire";
import { NotificationsBell } from "./notifications-bell";

const state = vi.hoisted(() => {
  const items: ListNotificationDecisionsResponse["items"] = [];
  return { items, nextCursor: undefined as string | undefined, pageItems: undefined as ListNotificationDecisionsResponse["items"] | undefined, cursor: vi.fn() };
});
vi.mock("~/api/queries", () => ({
  useNotifications: () => ({ data: { notifications: [] }, refetch: vi.fn() }),
  useNotificationDecisions: (cursor?: string) => { state.cursor(cursor); return { data: { items: cursor ? state.pageItems ?? state.items : state.items, nextCursor: cursor ? null : state.nextCursor }, refetch: vi.fn() }; },
  useMarkNotificationRead: () => ({ mutateAsync: vi.fn() }),
  useMarkAllNotificationsRead: () => ({ mutate: vi.fn() }),
}));
vi.mock("~/api/workflows", () => ({ useWorkflowActionRequired: () => ({ data: { count: 0, items: [] }, refetch: vi.fn() }) }));
vi.mock("~/components/session/decision-gate-card", () => ({ DecisionGateCard: () => <button>Allow account use</button> }));

it("keeps approval controls but omits navigation into a private thread", async () => {
  state.items = [false, true].map((canOpenThread, i) => ({
    sessionId: "session", title: `Approval ${i}`, canOpenThread,
    gate: { id: `gate-${i}`, sessionId: "session", threadId: `thread-${i}`, type: "approval", title: "Allow?",
      status: "pending", createdAt: 1, updatedAt: 1, actions: [{ id: "approve", label: "Allow" }] },
  }));
  render(<NotificationsBell />);
  await userEvent.click(screen.getByRole("button", { name: "Notifications: 2 pending approvals" }));
  expect(screen.getAllByRole("button", { name: "Allow account use" })).toHaveLength(2);
  const links = screen.getAllByRole("link", { name: "Open thread" });
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute("href")).toBe("/threads/thread-1");
});

it("allows paging past hidden approvals without claiming the inbox is empty", async () => {
  state.items = []; state.nextCursor = "sealed-cursor"; state.cursor.mockClear();
  render(<NotificationsBell />);
  await userEvent.click(screen.getByRole("button", { name: "Notifications: 0+ pending approvals" }));
  expect(screen.queryByText("You're all caught up. No decisions are waiting.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Next approvals" }));
  expect(state.cursor).toHaveBeenLastCalledWith("sealed-cursor");
  await userEvent.click(screen.getByRole("button", { name: "First approvals" }));
  expect(state.cursor).toHaveBeenLastCalledWith(undefined);
});

it("keeps the first-page badge on later pages and resets after closing", async () => {
  state.items = [{ sessionId: "session", title: "Approval", gate: { id: "gate", sessionId: "session", threadId: "thread",
    type: "approval", title: "Allow?", status: "pending", createdAt: 1, updatedAt: 1, actions: [{ id: "approve", label: "Allow" }] } }];
  state.nextCursor = "sealed-cursor"; state.pageItems = [];
  render(<NotificationsBell />);
  await userEvent.click(screen.getByRole("button", { name: "Notifications: 1+ pending approvals" }));
  await userEvent.click(screen.getByRole("button", { name: "Next approvals" }));
  expect(screen.getByRole("button", { name: "Notifications: 1+ pending approvals" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Close notifications" }));
  await userEvent.click(screen.getByRole("button", { name: "Notifications: 1+ pending approvals" }));
  expect(screen.queryByRole("button", { name: "First approvals" })).toBeNull();
  expect(screen.getByRole("button", { name: "Next approvals" })).toBeTruthy();
});
