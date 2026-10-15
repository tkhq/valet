// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { ListNotificationDecisionsResponse } from "@valet/api/wire";
import { NotificationsBell } from "./notifications-bell";

const state = vi.hoisted(() => {
  const items: ListNotificationDecisionsResponse["items"] = [];
  return {
    items, nextCursor: undefined as string | undefined,
    pageItems: undefined as ListNotificationDecisionsResponse["items"] | undefined,
    cursor: vi.fn(), resolve: vi.fn().mockResolvedValue({ ok: true }), withdraw: vi.fn().mockResolvedValue({ ok: true }),
  };
});
vi.mock("~/api/queries", () => ({
  useNotifications: () => ({ data: { notifications: [] }, refetch: vi.fn() }),
  useNotificationDecisions: (cursor?: string) => { state.cursor(cursor); return { data: { items: cursor ? state.pageItems ?? state.items : state.items, nextCursor: cursor ? null : state.nextCursor }, refetch: vi.fn() }; },
  useMarkNotificationRead: () => ({ mutateAsync: vi.fn() }),
  useMarkAllNotificationsRead: () => ({ mutate: vi.fn() }),
  useResolveDecisions: () => ({ mutateAsync: vi.fn() }),
  useResolveDecision: () => ({ mutateAsync: state.resolve, isPending: false }),
  useWithdrawDecision: () => ({ mutateAsync: state.withdraw, isPending: false }),
}));
vi.mock("~/api/workflows", () => ({
  useWorkflowActionRequired: () => ({ data: { count: 0, items: [] }, refetch: vi.fn() }),
  useResolveWorkflowApprovals: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: "me" } }) }));

beforeEach(() => {
  state.items = [];
  state.nextCursor = undefined;
  state.pageItems = undefined;
  vi.clearAllMocks();
});

it("keeps approval controls but omits navigation into a private thread", async () => {
  state.items = [false, true].map((canOpenThread, i) => ({
    sessionId: "session", title: `Approval ${i}`, canOpenThread,
    gate: { id: `gate-${i}`, sessionId: "session", threadId: `thread-${i}`, type: "approval", title: "Allow?",
      status: "pending", createdAt: 1, updatedAt: 1, actions: [{ id: "approve", label: "Allow account use" }] },
  }));
  render(<NotificationsBell />);
  await userEvent.click(screen.getByRole("button", { name: "Notifications: 2 pending approvals" }));
  expect(screen.getAllByRole("button", { name: "Allow account use" })).toHaveLength(2);
  const links = screen.getAllByRole("link", { name: "Open thread" });
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute("href")).toBe("/threads/thread-1");
});

it("uses the real notification placement and submits its action", async () => {
  state.items = [{
    sessionId: "private-session", title: "Private account request", canOpenThread: false,
    gate: { id: "private-gate", sessionId: "private-session", threadId: "private-thread", type: "approval", title: "Allow this account?",
      status: "pending", createdAt: 1, updatedAt: 1,
      actions: [{ id: "approve", label: "Allow account use" }, { id: "deny", label: "Deny" }] },
  }];
  render(<NotificationsBell defaultOpen />);
  const dialog = screen.getByRole("dialog", { name: "Allow this account?" });
  const allow = within(dialog).getByRole("button", { name: "Allow account use" });
  expect(dialog.classList.contains("border")).toBe(false);
  expect(dialog.parentElement?.classList.contains("sm:px-8")).toBe(false);
  expect(allow.parentElement?.classList.contains("px-4")).toBe(true);
  expect(allow.parentElement?.classList.contains("justify-start")).toBe(true);
  expect(screen.queryByRole("link", { name: "Open thread" })).toBeNull();
  await userEvent.click(allow);
  expect(state.resolve).toHaveBeenCalledWith({ gateId: "private-gate", body: { actionId: "approve" } });
});

it("shows full private context names with distinguishing suffixes without hover", () => {
  const prefix = "Customer reports for the quarterly security and compliance review ";
  state.items = ["North America", "Europe"].map((suffix, i) => ({
    sessionId: `session-${i}`, title: `${prefix}${suffix}`, canOpenThread: false,
    gate: { id: `gate-${i}`, sessionId: `session-${i}`, threadId: `thread-${i}`, type: "approval", title: "Send report?",
      status: "pending", createdAt: 1, updatedAt: 1, actions: [{ id: "approve", label: "Allow" }] },
  }));
  render(<NotificationsBell defaultOpen />);
  for (const suffix of ["North America", "Europe"]) {
    const context = screen.getByText(`${prefix}${suffix}`);
    expect(context.classList.contains("truncate")).toBe(false);
    expect(context.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
    expect(context.hasAttribute("title")).toBe(false);
  }
  expect(screen.queryByRole("link", { name: "Open thread" })).toBeNull();
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
