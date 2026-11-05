import { describe, expect, it } from "vitest";
import { todayJournalPath } from "./journal-path";

describe("todayJournalPath", () => {
  it("uses the UTC date", () => {
    expect(todayJournalPath(new Date("2026-07-13T23:59:00Z"))).toBe("journal/2026-07-13.md");
    expect(todayJournalPath(new Date("2026-07-13T00:05:00Z"))).toBe("journal/2026-07-13.md");
  });
});
