import { describe, expect, it } from "vitest";
import type { MemoryFileSummary } from "../services/memory.js";
import {
  BASE_PRINCIPLE,
  isPrincipleFile,
  PRINCIPLE_INDEX_MAX_CHARS,
  PRINCIPLE_INDEX_MAX_ENTRIES,
  renderPrinciplesSection,
} from "./principles.js";

function file(path: string, title = "", description = ""): MemoryFileSummary {
  return { path, title, description, type: "principle", pinned: false, updatedAt: 0 };
}

describe("principles", () => {
  it("finds principle files in the own scope and under a team prefix", () => {
    expect(isPrincipleFile("principles/prove-it-works.md")).toBe(true);
    expect(isPrincipleFile("team:t1/principles/ship-small.md")).toBe(true);
    expect(isPrincipleFile("principles/")).toBe(false);
    expect(isPrincipleFile("notes/principles/x.md")).toBe(false);
  });

  it("renders the base principle first, then one index line per principle", () => {
    const section = renderPrinciplesSection([
      file("notes/a.md", "A"),
      file("principles/prove-it-works.md", "Prove it works", "Before you report done"),
      file("team:t1/principles/ship-small.md", "Ship small"),
    ]);
    expect(section.indexOf(BASE_PRINCIPLE)).toBeGreaterThan(0);
    expect(section).toContain("- principles/prove-it-works.md — Prove it works: Before you report done");
    expect(section).toContain("- team:t1/principles/ship-small.md — Ship small");
    expect(section).not.toContain("notes/a.md");
    expect(section.indexOf(BASE_PRINCIPLE)).toBeLessThan(section.indexOf("### Index"));
  });

  it("lists own principles before team principles, each in path order", () => {
    const section = renderPrinciplesSection([
      file("team:t2/principles/a.md"),
      file("principles/z.md"),
      file("team:t1/principles/b.md"),
      file("principles/a.md"),
    ]);
    const order = ["principles/a.md", "principles/z.md", "team:t1/principles/b.md", "team:t2/principles/a.md"]
      .map((path) => section.indexOf(`- ${path}`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("caps the index by entry count and says how to list the rest", () => {
    const files = Array.from({ length: 50 }, (_, i) => file(`principles/p${String(i).padStart(2, "0")}.md`));
    const lines = renderPrinciplesSection(files).split("\n").filter((line) => line.startsWith("- principles/"));
    expect(lines).toHaveLength(PRINCIPLE_INDEX_MAX_ENTRIES);
    expect(renderPrinciplesSection(files)).toContain("(10 more principles are not listed. To see all of them, read the directory with mem_read `principles/`");
  });

  it("caps the index by size", () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`principles/p${i}.md`, "Title", "d".repeat(300)));
    const section = renderPrinciplesSection(files);
    const index = section.slice(section.indexOf("### Index"));
    expect(index.length).toBeLessThan(PRINCIPLE_INDEX_MAX_CHARS + 300);
    expect(section).toMatch(/\(\d+ more principles are not listed\./);
  });

  it("does not tell the agent to infer team rules or write them without a request", () => {
    expect(BASE_PRINCIPLE).not.toContain("two or more times");
    expect(BASE_PRINCIPLE).toContain("only when a person in this conversation asks you to add the rule to a team");
  });
});
