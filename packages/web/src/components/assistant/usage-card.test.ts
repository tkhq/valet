/**
 * Pure cost presentation for the dashboard usage card. `windowCostDisplay`
 * is the exported pure function the component calls internally, so no DOM
 * rendering is needed.
 *
 * The rule under test: an unpriced turn must never read as $0 of spend.
 */
import { describe, expect, it } from "vitest";
import type { UsageMemberSummary, UsageWindow } from "@valet/api/wire";
import { ORG_MEMBER_CAP, topMembers, windowCostDisplay } from "./usage-card";

function window(partial: Partial<UsageWindow>): UsageWindow {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    turns: 0,
    unpricedTurns: 0,
    ...partial,
  };
}

function member(userId: string, costUsd: number, totalTokens = 0): UsageMemberSummary {
  return { userId, name: userId, ...window({ costUsd, totalTokens }) };
}

describe("windowCostDisplay", () => {
  it("shows $0 for an empty window", () => {
    expect(windowCostDisplay(window({}))).toEqual({ text: "$0", note: "" });
  });

  it("shows the exact cost when every turn was priced", () => {
    expect(windowCostDisplay(window({ turns: 4, costUsd: 1.5 }))).toEqual({
      text: "$1.50",
      note: "",
    });
  });

  it("shows a dash, not $0, when no turn in the window had a price", () => {
    expect(windowCostDisplay(window({ turns: 3, unpricedTurns: 3, costUsd: 0 }))).toEqual({
      text: "—",
      note: "unpriced",
    });
  });

  it("marks a partly-priced window as a floor and counts the gap", () => {
    expect(windowCostDisplay(window({ turns: 5, unpricedTurns: 2, costUsd: 1.5 }))).toEqual({
      text: "$1.50+",
      note: "2 unpriced",
    });
  });

  it("keeps the floor marker on a sub-cent priced total", () => {
    expect(windowCostDisplay(window({ turns: 2, unpricedTurns: 1, costUsd: 0.004 }))).toEqual({
      text: "<$0.01+",
      note: "1 unpriced",
    });
  });
});

describe("topMembers", () => {
  it("returns everyone with no hidden count when at or under the cap", () => {
    const members = [member("a", 5), member("b", 3)];
    expect(topMembers(members)).toEqual({ shown: members, hidden: 0 });
  });

  it("caps the list and counts the members it hides", () => {
    const members = Array.from({ length: ORG_MEMBER_CAP + 7 }, (_, i) =>
      member(`u${i}`, ORG_MEMBER_CAP + 7 - i),
    );
    const { shown, hidden } = topMembers(members);
    expect(shown).toHaveLength(ORG_MEMBER_CAP);
    expect(hidden).toBe(7);
  });

  it("keeps the highest spenders, not the first rows, when input is unsorted", () => {
    const members = [
      ...Array.from({ length: ORG_MEMBER_CAP }, (_, i) => member(`small${i}`, 1)),
      member("big", 100),
    ];
    const { shown, hidden } = topMembers(members);
    expect(shown[0]?.userId).toBe("big");
    expect(shown).toHaveLength(ORG_MEMBER_CAP);
    expect(hidden).toBe(1);
  });

  it("breaks cost ties by token volume, like the API's own ordering", () => {
    const { shown } = topMembers([member("fewer", 2, 10), member("more", 2, 90)]);
    expect(shown.map((m) => m.userId)).toEqual(["more", "fewer"]);
  });

  it("appends the viewer at the bottom when they fall outside the cap", () => {
    const members = [
      ...Array.from({ length: ORG_MEMBER_CAP + 5 }, (_, i) => member(`u${i}`, 100 - i)),
      member("viewer", 0.5),
    ];
    const { shown, hidden } = topMembers(members, "viewer");
    expect(shown).toHaveLength(ORG_MEMBER_CAP + 1);
    expect(shown[ORG_MEMBER_CAP]?.userId).toBe("viewer");
    // The viewer's row is on screen, so the hidden count excludes them.
    expect(hidden).toBe(5);
  });

  it("does not duplicate the viewer when they are already in the top rows", () => {
    const members = Array.from({ length: ORG_MEMBER_CAP + 3 }, (_, i) =>
      member(`u${i}`, 100 - i),
    );
    const { shown, hidden } = topMembers(members, "u0");
    expect(shown).toHaveLength(ORG_MEMBER_CAP);
    expect(shown.filter((m) => m.userId === "u0")).toHaveLength(1);
    expect(hidden).toBe(3);
  });

  it("changes nothing when the viewer id is unknown or absent from the org", () => {
    const members = Array.from({ length: ORG_MEMBER_CAP + 2 }, (_, i) =>
      member(`u${i}`, 100 - i),
    );
    expect(topMembers(members, "not-a-member")).toEqual(topMembers(members));
  });
});
