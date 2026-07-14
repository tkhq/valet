/**
 * `mergeActivity` (decision 16): notifications + settled children merged
 * into one feed, newest first, capped at 8. Pure — no queries mounted.
 */
import { describe, expect, it } from "vitest";
import type { NotificationSummary, OrchestratorChildSummary } from "@valet/api/wire";
import { mergeActivity } from "./activity-strip";

function notification(id: string, createdAt: number): NotificationSummary {
  return { id, kind: "notification", urgency: "normal", title: `n-${id}`, href: `/n/${id}`, createdAt };
}

function child(
  id: string,
  createdAt: number,
  status: OrchestratorChildSummary["status"] = "settled",
): OrchestratorChildSummary {
  return { sessionId: id, title: `child-${id}`, parentThreadId: "thread-1", status, createdAt };
}

describe("mergeActivity", () => {
  it("merges notifications and settled children, sorted newest first", () => {
    const events = mergeActivity([notification("1", 100), notification("2", 300)], [child("a", 200)], "orch-1");
    expect(events.map((e) => e.id)).toEqual(["notification:2", "child:a", "notification:1"]);
  });

  it("excludes still-running children", () => {
    const events = mergeActivity([], [child("a", 100, "running"), child("b", 200, "settled")], "orch-1");
    expect(events.map((e) => e.id)).toEqual(["child:b"]);
  });

  it("caps at the top 8 by recency", () => {
    const notifications = Array.from({ length: 10 }, (_, i) => notification(String(i), i));
    const events = mergeActivity(notifications, [], "orch-1", 8);
    expect(events).toHaveLength(8);
    expect(events[0].id).toBe("notification:9");
    expect(events[7].id).toBe("notification:2");
  });

  it("targets a child's href at the assistant session for now (TODO T5: /chat)", () => {
    const events = mergeActivity([], [child("a", 100)], "orch-1");
    expect(events[0].href).toBe("/sessions/orch-1");
  });
});
