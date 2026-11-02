// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { MemoryTreeEntry } from "@valet/api/wire";
import { isPrincipleEntry, sortPrinciples } from "./memory-principles";

function entry(path: string, overrides: Partial<MemoryTreeEntry> = {}): MemoryTreeEntry {
  return { path, title: path, type: "principle", pinned: false, updatedAt: 1, dir: false, sizeBytes: 10, lastUsedAt: null, useCount: 0, lastLoadedAt: null, ...overrides };
}

describe("principles view", () => {
  it("keeps own and team principle files and drops other memory", () => {
    const files = [entry("principles/prove-it.md"), entry("team:t1/principles/ship-small.md"), entry("notes/a.md"), entry("principles/", { dir: true }), entry("principles/sub/deep.md")];
    expect(files.filter(isPrincipleEntry).map((e) => e.path)).toEqual(["principles/prove-it.md", "team:t1/principles/ship-small.md"]);
  });

  it("lists own principles before team ones, most used first", () => {
    const sorted = sortPrinciples([
      entry("team:t1/principles/a.md", { useCount: 9 }),
      entry("principles/rare.md", { useCount: 1 }),
      entry("principles/often.md", { useCount: 5 }),
    ]);
    expect(sorted.map((e) => e.path)).toEqual(["principles/often.md", "principles/rare.md", "team:t1/principles/a.md"]);
  });
});
