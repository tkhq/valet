import { describe, expect, it } from "vitest";
import type { MemoryTreeEntry } from "@valet/api/wire";
import { memoryStats, todayJournalPath } from "./memory-card";

describe("todayJournalPath", () => {
  it("uses the UTC date", () => {
    expect(todayJournalPath(new Date("2026-07-13T23:59:00Z"))).toBe("journal/2026-07-13.md");
    expect(todayJournalPath(new Date("2026-07-13T00:05:00Z"))).toBe("journal/2026-07-13.md");
  });
});

function entry(path: string, overrides: Partial<MemoryTreeEntry> = {}): MemoryTreeEntry {
  return { path, title: path, type: "note", pinned: false, updatedAt: 100, dir: false, sizeBytes: 100, ...overrides };
}

describe("memoryStats", () => {
  it("splits journal days from notes and counts pins", () => {
    const stats = memoryStats([
      entry("journal/2026-07-30.md"),
      entry("journal/2026-07-31.md", { updatedAt: 500 }),
      entry("projects/valet.md", { pinned: true }),
      entry("people/carey.md"),
    ]);
    expect(stats).toEqual({
      files: 4,
      journalDays: 2,
      notes: 2,
      pinned: 1,
      lastUpdatedAt: 500,
    });
  });

  it("handles an empty tree", () => {
    expect(memoryStats([])).toEqual({ files: 0, journalDays: 0, notes: 0, pinned: 0, lastUpdatedAt: null });
  });
});
