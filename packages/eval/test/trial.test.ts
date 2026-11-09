import { describe, expect, it } from "vitest";
import {
  buildReviewMatcher,
  CaseValidationError,
  formatTrialSummary,
  parseEvalCase,
  scoreReviewText,
  type ReviewMatchCheck,
  type ScorecardEntry,
  type Trajectory,
} from "../src/index.js";
import { codeRabbitCommentText, reviewerBody } from "../src/trial-import.js";

/** Fake LLM: extract returns fixed issues, dedup keeps singletons, judge matches on a keyword. */
function fakeLlm(issues: string[]): (system: string, prompt: string) => Promise<string> {
  return async (system, prompt) => {
    if (system.startsWith("You extract")) return JSON.stringify({ issues });
    if (system.startsWith("You group")) return JSON.stringify({ groups: issues.map((_, i) => [i]) });
    const golden = /Golden Comment[^\n]*\n(.*)\n/.exec(prompt)?.[1] ?? "";
    const candidate = /Candidate Issue[^\n]*\n(.*)\n/.exec(prompt)?.[1] ?? "";
    const match = golden.includes("rename") && candidate.includes("rename");
    return JSON.stringify({ reasoning: "r", match, confidence: match ? 0.9 : 0.1 });
  };
}

const PR = { repo: "r", remote: "https://example.invalid/r.git", base: "a", head: "b", title: "t" };

describe("trial cases", () => {
  it("lets only control and setup cases leave golden empty", () => {
    const raw = (kind?: string, golden: unknown[] = []) => ({ id: "x", pull_request: PR, checks: [{ type: "review_match", golden, ...(kind ? { kind } : {}) }] });
    const control = parseEvalCase(raw("control"), "x.yaml");
    expect(control.checks[0]).toMatchObject({ type: "review_match", kind: "control", golden: [] });
    expect(() => parseEvalCase(raw("planted"), "x.yaml")).toThrow(CaseValidationError);
    expect(() => parseEvalCase(raw(), "x.yaml")).toThrow(/Only a `kind: control`/);
    expect(() => parseEvalCase(raw("odd", [{ comment: "c", category: "bug" }]), "x.yaml")).toThrow(/kind/);
    const planted = parseEvalCase(raw("planted", [{ comment: "c", category: "api", cross_repo: true }]), "x.yaml");
    expect(planted.checks[0]).toMatchObject({ golden: [{ comment: "c", category: "api", cross_repo: true }] });
  });

  it("scores cross-repo golden comments for the reviewer and references, and every control issue as a false positive", async () => {
    const check: ReviewMatchCheck = {
      type: "review_match",
      kind: "planted",
      golden: [{ comment: "Event rename breaks consumers", category: "api", cross_repo: true }],
      reference: { coderabbit: { matched: [0], fp: 0 } },
    };
    const t: Trajectory = {
      caseId: "c",
      prompt: "p",
      model: "m",
      turns: [],
      toolCalls: [],
      finalOutput: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      durationMs: 1,
      metadata: { review: { summary: "s", findings: [{ path: "a.ts", line: 1, title: "Event rename", body: "Consumers break." }] } },
    };
    const result = await buildReviewMatcher({ llm: fakeLlm(["The rename breaks consumers"]) })(check, t);
    expect(result.metrics).toMatchObject({ tp: 1, "cross:tp": 1, "cross:fn": 0, "ref:coderabbit:cross_tp": 1, "ref:coderabbit:cross_fn": 0 });
    const control: ReviewMatchCheck = { type: "review_match", kind: "control", golden: [] };
    expect(await scoreReviewText(control, "Two problems in this clean change, long enough", { llm: fakeLlm(["one", "two"]) })).toEqual({
      matched: [],
      fp: 2,
      candidates: 2,
    });
  });

  it("prints planted recall, control and setup false positives, and cross-repo recall per tool", () => {
    const entry = (kind: "planted" | "control" | "setup", m: Record<string, number>): ScorecardEntry => ({
      caseId: kind,
      status: "pass",
      durationMs: 1,
      checkResults: [{ check: { type: "review_match", kind, golden: [] }, pass: true, metrics: m }],
    });
    const table =
      formatTrialSummary([
        entry("planted", { tp: 1, fp: 1, fn: 0, "cross:tp": 1, "cross:fn": 0, "ref:coderabbit:tp": 0, "ref:coderabbit:fp": 0, "ref:coderabbit:fn": 1, "ref:coderabbit:cross_tp": 0, "ref:coderabbit:cross_fn": 1 }),
        entry("control", { tp: 0, fp: 2, fn: 0, "ref:coderabbit:tp": 0, "ref:coderabbit:fp": 0, "ref:coderabbit:fn": 0 }),
        entry("setup", { tp: 0, fp: 0, fn: 0, "ref:coderabbit:tp": 0, "ref:coderabbit:fp": 3, "ref:coderabbit:fn": 0 }),
      ]) ?? "";
    expect(table).toMatch(/valet\s+1\/1\s+100\.0\s+2\s+1\/1\s+0\s+0\/1\s+1\/1/);
    expect(table).toMatch(/coderabbit\s+0\/1\s+0\.0\s+0\s+0\/1\s+3\s+1\/1\s+0\/1/);
    expect(formatTrialSummary([])).toBeUndefined();
  });

  it("strips CodeRabbit's summary and the trial notes from the reviewed description", () => {
    const body = [
      "Simplifies the options.",
      "",
      "This PR is part of an isolated CodeRabbit evaluation.",
      "",
      "### Expected review features and tier",
      "",
      "Serialization review.",
      "",
      "### Companion context",
      "",
      "- tkhq/test-sdk@trial/setup",
      "",
      "### Validation",
      "",
      "Local harness.",
      "",
      "<!-- This is an auto-generated comment: release notes by coderabbit.ai -->",
      "## Summary by CodeRabbit",
      "<!-- end of auto-generated comment: release notes by coderabbit.ai -->",
    ].join("\n");
    expect(reviewerBody(body)).toBe("Simplifies the options.\n\n### Companion context\n\n- tkhq/test-sdk@trial/setup");
    expect(reviewerBody("Update scheduling.\n\n<!-- This is an auto-generated comment: release notes by coderabbit.ai -->x<!-- end of auto-generated comment: release notes by coderabbit.ai -->")).toBe(
      "Update scheduling.",
    );
  });

  it("keeps the readable text of a CodeRabbit inline comment", () => {
    const body = [
      "<!-- coderabbit-ai-generated:v1 -->",
      "",
      '**<picture><img src="x.svg"></picture> Major** · **Functional Correctness** · **Quick win**',
      "",
      "**Do not retry 4xx.**",
      "",
      "A 400 now retries three times.",
      "",
      "<details>",
      "<summary>Prompt for AI Agents</summary>",
      "Fix it.",
      "</details>",
    ].join("\n");
    expect(codeRabbitCommentText(body)).toBe("**Do not retry 4xx.**\n\nA 400 now retries three times.");
  });
});
