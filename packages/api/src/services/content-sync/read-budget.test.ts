import { expect, it, vi } from "vitest";
import type { SkillRepoReader } from "../skill-repo-reader.js";
import { budgetedReader, MAX_SYNC_READS } from "./read-budget.js";

it("shares the request budget across fallback trees and companion reads", async () => {
  const readFile = vi.fn(async () => null);
  const reader: SkillRepoReader = {
    head: async () => ({ sha: "s", treeSha: "t" }),
    listTree: async () => ({ entries: [], truncated: false }),
    listDirectory: async () => ({ entries: [], complete: true }), readFile,
  };
  const limited = budgetedReader(reader);
  await limited.listTree("a/b", "t");
  await limited.listDirectory("a/b", "skills", "s");
  for (let i = 2; i < MAX_SYNC_READS; i++) await limited.readFile("a/b", "x", "s");
  expect(() => limited.listTree("a/b", "t")).toThrow("600-read");
  expect(readFile).toHaveBeenCalledTimes(MAX_SYNC_READS - 2);
  expect(readFile.mock.calls[0]?.length).toBe(4);
});

it("stops before the five-minute lease even when the request count is small", async () => {
  let now = 0;
  const readFile = vi.fn(async () => null);
  const reader: SkillRepoReader = {
    head: async () => ({ sha: "s", treeSha: "t" }),
    listTree: async () => ({ entries: [], truncated: false }),
    listDirectory: async () => ({ entries: [], complete: true }), readFile,
  };
  const limited = budgetedReader(reader, () => now);
  now = 180_000;
  expect(() => limited.readFile("a/b", "x", "s")).toThrow("180-second");
  expect(readFile).not.toHaveBeenCalled();
});
