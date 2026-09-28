import { describe, expect, it } from "vitest";
import { isSafeFailoverError } from "../src/thread.js";

describe("provider failover classification", () => {
  it.each([
    "no credits remaining",
    "insufficient quota",
    "quota exceeded",
    "out of budget",
    "available balance is too low",
    "rate limit",
    "service unavailable (503)",
  ])("accepts safe provider failure: %s", (message) => {
    expect(isSafeFailoverError(message)).toBe(true);
  });

  it("rejects arbitrary model errors", () => {
    expect(isSafeFailoverError("invalid request body")).toBe(false);
  });
});
