import { describe, expect, it } from "vitest";
import { mapBounded } from "./bounded-map.js";

describe("mapBounded", () => {
  it("keeps item order and never runs more than the limit at once", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapBounded([5, 1, 4, 2, 3, 0, 6], 3, async (ms) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, ms));
      active--;
      return ms * 10;
    });
    expect(result).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(peak).toBe(3);
  });

  it("returns an empty list for no items", async () => {
    expect(await mapBounded([], 5, async () => 1)).toEqual([]);
  });
});
