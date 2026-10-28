import { describe, expect, it } from "vitest";
import { niceTicks } from "./chart-view";

describe("niceTicks", () => {
  it("covers the data with round steps from zero", () => {
    expect(niceTicks(7, 18)).toEqual([0, 5, 10, 15, 20]);
    expect(niceTicks(120, 640)).toEqual([0, 200, 400, 600, 800]);
  });
  it("spans negative values and a flat series", () => {
    expect(niceTicks(-30, 45)).toEqual([-40, -20, 0, 20, 40, 60]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });
});
