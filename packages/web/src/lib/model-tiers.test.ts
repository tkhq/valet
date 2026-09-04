import { describe, expect, it } from "vitest";
import { isSizeTier, SIZE_TIERS, TIER_LABELS, tierLabel } from "./model-tiers";

describe("SIZE_TIERS / TIER_LABELS", () => {
  it("lists the five size tiers in size order", () => {
    expect(SIZE_TIERS).toEqual(["xs", "s", "m", "l", "xl"]);
  });

  it("has a label for every tier", () => {
    for (const tier of SIZE_TIERS) {
      expect(TIER_LABELS[tier]).toBeTruthy();
    }
  });
});

describe("isSizeTier", () => {
  it("narrows a known tier id", () => {
    expect(isSizeTier("m")).toBe(true);
  });

  it("rejects an unknown id", () => {
    expect(isSizeTier("xxl")).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isSizeTier(null)).toBe(false);
    expect(isSizeTier(undefined)).toBe(false);
  });
});

describe("tierLabel", () => {
  it("looks up the label for a known tier", () => {
    expect(tierLabel("xs")).toBe("Extra Small");
    expect(tierLabel("s")).toBe("Small");
    expect(tierLabel("m")).toBe("Medium");
    expect(tierLabel("l")).toBe("Large");
    expect(tierLabel("xl")).toBe("X-Large");
  });

  it("returns the id unchanged when it isn't a known tier", () => {
    expect(tierLabel("custom_1/llama-3")).toBe("custom_1/llama-3");
  });
});
