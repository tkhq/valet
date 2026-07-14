/**
 * Memory card pure derivations: today's journal path (must match the
 * server's `journal/YYYY-MM-DD.md` UTC convention,
 * `packages/api/src/orchestrator/bootstrap.ts`) and the excerpt truncation.
 */
import { describe, expect, it } from "vitest";
import { journalExcerpt, todayJournalPath } from "./memory-card";

describe("todayJournalPath", () => {
  it("formats journal/YYYY-MM-DD.md in UTC", () => {
    expect(todayJournalPath(new Date("2026-07-13T23:59:00Z"))).toBe("journal/2026-07-13.md");
  });

  it("does not roll over based on local time near a UTC day boundary", () => {
    // Just after UTC midnight — a naive local-time formatter in a
    // negative-offset timezone could still report the previous day.
    expect(todayJournalPath(new Date("2026-07-13T00:05:00Z"))).toBe("journal/2026-07-13.md");
  });
});

describe("journalExcerpt", () => {
  it("returns content unchanged when under the limit", () => {
    expect(journalExcerpt("short entry")).toBe("short entry");
  });

  it("trims surrounding whitespace", () => {
    expect(journalExcerpt("  entry with padding  ")).toBe("entry with padding");
  });

  it("truncates with an ellipsis past the limit", () => {
    const long = "a".repeat(300);
    const result = journalExcerpt(long, 220);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBe(221);
  });
});
