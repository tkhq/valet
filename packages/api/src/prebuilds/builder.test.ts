import { describe, expect, it } from "vitest";
import { reorderWaitingBuilds } from "./builder.js";

describe("reorderWaitingBuilds", () => {
  it("preserves other organizations' slots", () => {
    const queue = ["a", "foreign", "b"];
    expect(reorderWaitingBuilds(queue, ["a", "b"], ["b", "a"])).toBe(true);
    expect(queue).toEqual(["b", "foreign", "a"]);
  });
  it.each([["a"], ["a", "a"], ["a", "foreign"], ["a", "running"]])("rejects invalid orders atomically: %j", (...order) => {
    const queue = ["a", "foreign", "b"];
    expect(reorderWaitingBuilds(queue, ["a", "b"], order)).toBe(false);
    expect(queue).toEqual(["a", "foreign", "b"]);
  });
  it("rejects work that dispatched after the caller's snapshot", () => {
    const queue = ["b"];
    expect(reorderWaitingBuilds(queue, ["a", "b"], ["b", "a"])).toBe(false);
  });
});
