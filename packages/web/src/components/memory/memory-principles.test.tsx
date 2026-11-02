// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { MemoryTreeEntry } from "@valet/api/wire";
import { BUILTIN_PRINCIPLES } from "@valet/shared";
import { isPrincipleEntry, isSyncedPrinciple, sortPrinciples, unchangedBuiltins } from "./memory-principles";

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

  it("keeps principles synced from a repository and lists them after team ones", () => {
    const files = [entry("lib/principles/canonical.md"), entry("team:t1/lib/principles/names.md"), entry("lib/notes/x.md")];
    expect(files.filter(isPrincipleEntry).map((e) => e.path)).toEqual(["lib/principles/canonical.md", "team:t1/lib/principles/names.md"]);
    expect(isSyncedPrinciple("team:t1/lib/principles/names.md")).toBe(true);
    expect(isSyncedPrinciple("principles/mine.md")).toBe(false);
    const sorted = sortPrinciples([entry("lib/principles/canonical.md", { useCount: 9 }), entry("team:t1/principles/a.md"), entry("principles/b.md")]);
    expect(sorted.map((e) => e.path)).toEqual(["principles/b.md", "team:t1/principles/a.md", "lib/principles/canonical.md"]);
  });

  it("shows each built-in principle until a saved file at its path replaces it", () => {
    const [first] = BUILTIN_PRINCIPLES;
    expect(unchangedBuiltins([]).map((p) => p.name)).toEqual(BUILTIN_PRINCIPLES.map((p) => p.name));
    const left = unchangedBuiltins([entry(`principles/${first.name}.md`)]).map((p) => p.name);
    expect(left).not.toContain(first.name);
    expect(left).toHaveLength(BUILTIN_PRINCIPLES.length - 1);
  });
});
