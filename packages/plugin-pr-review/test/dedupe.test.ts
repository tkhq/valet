import { describe, expect, it } from "vitest";
import type { ToolContext } from "@valet/engine";
import { applyDuplicateGroups, buildDedupePrompt, clusterExcerpt, createDedupeSpec, duplicateCandidates, type Finding } from "../src/index.js";

const f = (path: string, line: number, extra: Partial<Finding> = {}): Finding => ({
  path,
  line,
  severity: "medium",
  category: "bug",
  title: `${path}:${line}`,
  body: "b",
  ...extra,
});

describe("duplicateCandidates", () => {
  it("clusters findings on one file and side within the window", () => {
    const findings = [f("a.ts", 10), f("a.ts", 28), f("b.ts", 12), f("a.ts", 47), f("a.ts", 200), f("a.ts", 12, { side: "LEFT" })];
    // 10-28 and 28-47 chain into one cluster; b.ts, line 200 and the LEFT line stand alone.
    expect(duplicateCandidates(findings)).toEqual([[0, 1, 3]]);
  });

  it("returns nothing when no two findings are close", () => {
    expect(duplicateCandidates([f("a.ts", 1), f("a.ts", 30), f("b.ts", 1)])).toEqual([]);
  });
});

describe("applyDuplicateGroups", () => {
  it("keeps the most severe, then most confident finding of a group", () => {
    const findings = [f("a.ts", 10, { confidence: 0.9 }), f("a.ts", 14, { severity: "high", confidence: 0.4 }), f("a.ts", 18, { severity: "high", confidence: 0.6 })];
    const result = applyDuplicateGroups(findings, [[0, 1, 2]], { groups: [{ findings: [1, 2, 3], reason: "same unchecked null" }] });
    expect(result.kept).toEqual([findings[2]]);
    expect(result.dropped.map((d) => d.finding)).toEqual([findings[0], findings[1]]);
    expect(result.dropped[0].reason).toBe('same defect as "a.ts:18" at a.ts:18 (same unchecked null)');
  });

  it("ignores a group that crosses clusters or names an unknown finding", () => {
    const findings = [f("a.ts", 10), f("a.ts", 12), f("b.ts", 10), f("b.ts", 12)];
    const clusters = [[0, 1], [2, 3]];
    const result = applyDuplicateGroups(findings, clusters, { groups: [{ findings: [1, 3], reason: "x" }, { findings: [3, 9], reason: "y" }] });
    expect(result.kept).toEqual(findings);
    expect(result.dropped).toEqual([]);
  });

  it("joins overlapping groups and keeps every finding without an answer", () => {
    const findings = [f("a.ts", 10), f("a.ts", 12), f("a.ts", 14)];
    const joined = applyDuplicateGroups(findings, [[0, 1, 2]], { groups: [{ findings: [1, 2], reason: "x" }, { findings: [2, 3], reason: "x" }] });
    expect(joined.kept).toEqual([findings[0]]);
    expect(applyDuplicateGroups(findings, [[0, 1, 2]], undefined).kept).toEqual(findings);
  });
});

describe("dedupe prompt and spec", () => {
  it("numbers findings by their index and shows each cluster's code", () => {
    const findings = [f("x.ts", 1), f("a.ts", 3, { trigger: "empty list" }), f("a.ts", 9)];
    const prompt = buildDedupePrompt({ title: "t", findings, clusters: [[1, 2]], excerpts: [clusterExcerpt("l1\nl2\nl3", findings, [1, 2])] });
    expect(prompt).toContain("### Finding 2: a.ts:3, medium bug");
    expect(prompt).toContain("Trigger: empty list");
    expect(prompt).toContain("### Finding 3: a.ts:9");
    expect(prompt).not.toContain("Finding 1:");
    expect(prompt).toContain("    3  l3");
  });

  it("records a valid submit_duplicates answer and rejects an invalid one", async () => {
    const spec = createDedupeSpec({ title: "t", findings: [f("a.ts", 1), f("a.ts", 2)], clusters: [[0, 1]] });
    const tool = spec.tools[0];
    // The submit tool ignores its context.
    const ctx = {} as ToolContext;
    expect((await tool.execute({ groups: [{ findings: [1], reason: "x" }] } as never, ctx)).text).toContain("rejected");
    expect(spec.answer()).toBeUndefined();
    await tool.execute({ groups: [{ findings: [1, 2], reason: "x" }] } as never, ctx);
    expect(spec.answer()).toEqual({ groups: [{ findings: [1, 2], reason: "x" }] });
    expect(spec.builtinToolNames.size).toBe(0);
  });
});
