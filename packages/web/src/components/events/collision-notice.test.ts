import { describe, expect, it } from "vitest";
import { ApiError } from "~/api/client";
import { collisionsFromError } from "./collision-notice";

describe("collisionsFromError", () => {
  it("reads the collision report of a refused write", () => {
    const report = { blocking: [], overlapping: [] };
    expect(collisionsFromError(new ApiError(409, "conflict", { collisions: report }))).toEqual(report);
  });

  it("is null for any other failure", () => {
    expect(collisionsFromError(new Error("boom"))).toBeNull();
    expect(collisionsFromError(new ApiError(500, "down"))).toBeNull();
    expect(collisionsFromError(new ApiError(409, "conflict", { collisions: { blocking: "no" } }))).toBeNull();
  });
});
