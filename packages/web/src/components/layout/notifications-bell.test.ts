import type { NotificationKind, NotificationSummary } from "@valet/api/wire";
import { describe, expect, it } from "vitest";
import { groupUpdates } from "./notifications-bell";

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

describe("groupUpdates", () => {
  it("folds repeats of one update into a row with a count, newest first", () => {
    const failed = (id: string, createdAt: number) => notification(id, "notification", { title: "Workflow run failed: Review", createdAt });
    const groups = groupUpdates([failed("f1", 1), notification("other", "notification", { createdAt: 2 }), failed("f3", 3), failed("f2", 2)]);
    expect(groups.map((g) => [g.latest.id, g.ids.length])).toEqual([["f3", 3], ["other", 1]]);
  });

  it("leaves out read updates, so marking all read empties the list", () => {
    expect(groupUpdates([notification("a", "notification", { readAt: 5 })])).toEqual([]);
  });
});
