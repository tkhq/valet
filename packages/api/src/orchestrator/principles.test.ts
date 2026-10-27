import { describe, expect, it } from "vitest";
import type { MemoryFileSummary } from "../services/memory.js";
import { BASE_PRINCIPLE, isPrincipleFile, renderPrinciplesSection } from "./principles.js";

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
});
