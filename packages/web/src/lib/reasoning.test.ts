import { describe, expect, it } from "vitest";
import { levelsUpTo, REASONING_LABELS, REASONING_LEVELS } from "./reasoning";

describe("REASONING_LEVELS / REASONING_LABELS", () => {
  it("lists the six reasoning levels in ascending order", () => {
    expect(REASONING_LEVELS).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("has a label for every level", () => {
    for (const level of REASONING_LEVELS) {
      expect(REASONING_LABELS[level]).toBeTruthy();
    }
  });
});

describe("levelsUpTo", () => {
  it("caps the list at the given level, inclusive", () => {
    expect(levelsUpTo("medium")).toEqual(["minimal", "low", "medium"]);
  });

  it("returns the full list when the cap is the max level", () => {
    expect(levelsUpTo("max")).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("returns the full list when no cap is given", () => {
    expect(levelsUpTo(undefined)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("returns the full list when the cap isn't a known level", () => {
    expect(levelsUpTo("unknown")).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("returns just the first level when capped at the lowest", () => {
    expect(levelsUpTo("minimal")).toEqual(["minimal"]);
  });
});
