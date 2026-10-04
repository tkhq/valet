// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ListNotificationDecisionsResponse } from "@valet/api/wire";
import { NotificationsBell } from "./notifications-bell";

const state = vi.hoisted(() => {
  const items: ListNotificationDecisionsResponse["items"] = [];
  return { items };
});
vi.mock("~/api/queries", () => ({
  useNotifications: () => ({ data: { notifications: [] }, refetch: vi.fn() }),
  useNotificationDecisions: () => ({ data: { items: state.items }, refetch: vi.fn() }),
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
