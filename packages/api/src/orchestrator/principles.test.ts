import { describe, expect, it } from "vitest";
import { BUILTIN_PRINCIPLES } from "@valet/shared";
import {
  BASE_PRINCIPLE,
  isPrincipleFile,
  PRINCIPLE_INDEX_MAX_CHARS,
  PRINCIPLE_INDEX_MAX_ENTRIES,
  renderPrinciplesSection,
  type PrincipleIndexEntry,
} from "./principles.js";

function file(path: string, title = "", description = ""): PrincipleIndexEntry {
  return { path, title, description };
}

describe("principles", () => {
  it("tells a session that cannot write memory to report a rule instead", () => {
    const section = renderPrinciplesSection([file("principles/a.md", "A")], { readOnly: true });
    expect(section).toContain("learn-from-the-org (built in)");
    expect(section).not.toContain(BASE_PRINCIPLE);
    expect(section).not.toContain("mem_write");
    expect(section).toContain("Read a principle with mem_read before you follow it.");
    expect(section).toContain("- principles/a.md — A");
  });

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
    const lines = renderPrinciplesSection(files).split("\n").filter((line) => /^- principles\/p\d\d\.md$/.test(line));
    expect(lines).toHaveLength(PRINCIPLE_INDEX_MAX_ENTRIES);
    expect(renderPrinciplesSection(files)).toContain("(10 more principles are not listed. To see all of them, read the directory with mem_read `principles/`");
  });

  it("caps the index by size", () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`principles/p${i}.md`, "Title", "d".repeat(300)));
    const section = renderPrinciplesSection(files);
    // The built-in lines are a fixed set outside the cap.
    const index = section.slice(section.indexOf("### Index")).split("\n").filter((line) => !line.includes("(built in)")).join("\n");
    expect(index.length).toBeLessThan(PRINCIPLE_INDEX_MAX_CHARS + 300);
    expect(section).toMatch(/\(\d+ more principles are not listed\./);
  });

  it("lists every built-in principle until an own file at its path replaces it", () => {
    const [first, second] = BUILTIN_PRINCIPLES;
    const section = renderPrinciplesSection([file(`principles/${first.name}.md`, "My version", "When I say so")]);
    expect(section).toContain(`- principles/${first.name}.md — My version: When I say so`);
    expect(section).not.toContain(`${first.rule} (built in)`);
    expect(section).toContain(`- principles/${second.name}.md — ${second.rule} (built in): ${second.when}`);
    expect(section).not.toContain("No principles yet");
  });

  it("indexes principles synced from a repository under lib/principles/", () => {
    expect(isPrincipleFile("lib/principles/canonical-source-wins.md")).toBe(true);
    expect(isPrincipleFile("team:t1/lib/principles/canonical-source-wins.md")).toBe(true);
    expect(isPrincipleFile("lib/notes/x.md")).toBe(false);
    const section = renderPrinciplesSection([file("team:t1/lib/principles/canonical-source-wins.md", "The canonical source wins")]);
    expect(section).toContain("- team:t1/lib/principles/canonical-source-wins.md — The canonical source wins");
  });

  it("tells the agent to change principles as it learns and that synced ones are read-only", () => {
    expect(BASE_PRINCIPLE).toContain("If a principle you followed was wrong or incomplete");
    expect(BASE_PRINCIPLE).toContain("call save_principle with the same name");
    expect(BASE_PRINCIPLE).toContain("`lib/principles/` comes from a synced repository and is read-only");
  });

  it("does not tell the agent to infer team rules or write them without a request", () => {
    expect(BASE_PRINCIPLE).not.toContain("two or more times");
    expect(BASE_PRINCIPLE).toContain("only when a person in this conversation asks you to add the rule to a team");
  });
});
