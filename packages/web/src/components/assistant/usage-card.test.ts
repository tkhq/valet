/**
 * Pure cost presentation for the dashboard usage card. `windowCostDisplay`
 * is the exported pure function the component calls internally, so no DOM
 * rendering is needed.
 *
 * The rule under test: an unpriced turn must never read as $0 of spend.
 */
import { describe, expect, it } from "vitest";
import type { UsageWindow } from "@valet/api/wire";
import { windowCostDisplay } from "./usage-card";

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
