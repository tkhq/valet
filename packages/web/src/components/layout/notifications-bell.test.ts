import type { NotificationKind, NotificationSummary } from "@valet/api/wire";
import { describe, expect, it, vi } from "vitest";
import { deriveBellState, makeOpenChangeHandler, sortNotifications } from "./notifications-bell";

function notification(
  id: string,
  kind: NotificationKind,
  options: Partial<NotificationSummary> = {},
): NotificationSummary {
  return {
    id,
    kind,
    urgency: "normal",
    title: id,
    createdAt: 0,
    ...options,
  };
}

describe("deriveBellState", () => {
  it("uses a live gate before the notification poll catches up", () => {
    expect(deriveBellState([], { session: true })).toEqual({ unreadCount: 0, needsAttention: true });
  });

  it("clears a stale gate-backed poll row when an open socket has no gate", () => {
    const notifications = [notification("approval", "approval", { sessionId: "session" })];

    expect(deriveBellState(notifications, { session: false })).toEqual({
      unreadCount: 1,
      needsAttention: false,
    });
  });

  it("uses the poll for an actionable session with no open socket", () => {
    const notifications = [notification("question", "question", { sessionId: "session" })];

    expect(deriveBellState(notifications, {})).toEqual({ unreadCount: 1, needsAttention: true });
  });

  it("uses an unscoped escalation from the poll", () => {
    expect(deriveBellState([notification("escalation", "escalation")], {})).toEqual({
      unreadCount: 1,
      needsAttention: true,
    });
  });
});

describe("sortNotifications", () => {
  it("puts actionable items first and keeps recency order within each group", () => {
    const recent = notification("recent-update", "notification", { createdAt: 30 });
    const approval = notification("approval", "approval", { createdAt: 20 });
    const question = notification("question", "question", { createdAt: 10 });
    const older = notification("older-update", "notification", { createdAt: 0 });

    expect(sortNotifications([recent, approval, question, older]).map((item) => item.id)).toEqual([
      "approval",
      "question",
      "recent-update",
      "older-update",
    ]);
  });
});

describe("makeOpenChangeHandler", () => {
  it("refetches when the dropdown opens", () => {
    const refetch = vi.fn();
    makeOpenChangeHandler(refetch)(true);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch when the dropdown closes", () => {
    const refetch = vi.fn();
    makeOpenChangeHandler(refetch)(false);
    expect(refetch).not.toHaveBeenCalled();
  });
});
