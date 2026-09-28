import { describe, expect, it } from "vitest";
import {
  failoverSpecForTurn,
  isDistinctFailoverCandidate,
  isSafeFailoverError,
} from "../src/thread.js";

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

  it("never retries the concrete model that already failed", () => {
    const failed = { provider: "openai", id: "gpt-4.1-mini" };
    expect(isDistinctFailoverCandidate(failed, failed)).toBe(false);
    expect(isDistinctFailoverCandidate({ provider: "anthropic", id: "claude-haiku-4-5" }, failed)).toBe(true);
  });

  it("uses the role model class instead of the session selection", () => {
    expect(failoverSpecForTurn("anthropic/claude-opus-4-7", "s", "openai/gpt-4.1-mini"))
      .toBe("anthropic/claude-opus-4-7");
  });

  it("rejects arbitrary model errors", () => {
    expect(isSafeFailoverError("invalid request body")).toBe(false);
  });
});
