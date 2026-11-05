import { describe, expect, it } from "vitest";
import { RetryBackoff } from "./retry-backoff.js";

describe("RetryBackoff", () => {
  it("doubles the wait per failure up to the cap, and clears on success", () => {
    const backoff = new RetryBackoff({ baseMs: 100, maxMs: 350, maxEntries: 10 });
    expect(backoff.ready("a", 0)).toBe(true);
    expect(backoff.failed("a", 0)).toBe(100);
    expect(backoff.ready("a", 99)).toBe(false);
    expect(backoff.ready("a", 100)).toBe(true);
    expect(backoff.failed("a", 100)).toBe(200);
    expect(backoff.failed("a", 300)).toBe(350);
    backoff.succeeded("a");
    expect(backoff.ready("a", 301)).toBe(true);
    expect(backoff.size).toBe(0);
  });

  it("forgets the oldest failure past maxEntries", () => {
    const backoff = new RetryBackoff({ baseMs: 1_000, maxMs: 1_000, maxEntries: 2 });
    backoff.failed("a", 0);
    backoff.failed("b", 0);
    backoff.failed("c", 0);
    expect(backoff.size).toBe(2);
    expect(backoff.ready("a", 1)).toBe(true);
    expect(backoff.ready("c", 1)).toBe(false);
  });
});
