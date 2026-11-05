import { describe, expect, it } from "vitest";
import { ApiError } from "~/api/client";
import { isNotFound, retryUnlessNotFound } from "./not-found";

describe("retryUnlessNotFound", () => {
  it("does not retry a 404", () => {
    expect(isNotFound(new ApiError(404, "not found"))).toBe(true);
    expect(retryUnlessNotFound(0, new ApiError(404, "not found"))).toBe(false);
  });

  it("retries another failure twice", () => {
    const error = new ApiError(500, "boom");
    expect(isNotFound(error)).toBe(false);
    expect(retryUnlessNotFound(0, error)).toBe(true);
    expect(retryUnlessNotFound(1, error)).toBe(true);
    expect(retryUnlessNotFound(2, error)).toBe(false);
    expect(retryUnlessNotFound(0, new Error("network"))).toBe(true);
  });
});
