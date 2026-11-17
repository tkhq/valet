import { describe, expect, it } from "vitest";
import { compareRuns, parseEvalOutput, type CaseRuns, type RunMetrics } from "../src/review-compare.js";

const run = (tp: number, fp: number, fn: number, costUsd = 0.1): RunMetrics => ({ tp, fp, fn, costUsd });
const suite = (n: number, make: (i: number) => RunMetrics[]): CaseRuns => new Map(Array.from({ length: n }, (_, i) => [`case-${i}`, make(i)]));

describe("parseEvalOutput", () => {
  it("reads per-run metrics and costs, and skips text before and after the JSON", () => {
    const json = JSON.stringify({
      entries: [
        { caseId: "a", costUsd: 0.4, checkResults: [{ check: { type: "review_match" }, metrics: { tp: 1, fp: 1, fn: 0 } }], sampling: { metricsPerRun: [{ tp: 1, fp: 1, fn: 0 }, { tp: 0, fp: 2, fn: 1 }], costPerRun: [0.2, 0.2] } },
        { caseId: "b", costUsd: 0.1, checkResults: [{ check: { type: "review_match" }, metrics: { tp: 0, fp: 0, fn: 1 } }] },
      ],
    });
    const out = parseEvalOutput(`[eval] log line\n${json}\n[eval] done in 12s`);
    expect(out.get("a")).toEqual([run(1, 1, 0, 0.2), run(0, 2, 1, 0.2)]);
    expect(out.get("b")).toEqual([run(0, 0, 1, 0.1)]);
  });

  it("names the fix when the file is not eval JSON", () => {
    expect(() => parseEvalOutput("scorecard text")).toThrow(/Run the eval CLI with --json/);
  });
});

describe("compareRuns", () => {
  it("ships a candidate that keeps recall and lowers false findings", () => {
    const base = suite(60, () => [run(1, 2, 1), run(1, 2, 1), run(1, 2, 1)]);
    const candidate = suite(60, () => [run(1, 1, 1), run(1, 1, 1), run(1, 1, 1)]);
    const c = compareRuns(base, candidate);
    expect(c.verdict).toBe("ship");
    expect(c.fpRatio.mean).toBeCloseTo(0.5);
    expect(c.changed).toHaveLength(60);
  });

  it("holds a candidate that loses recall on many cases", () => {
    const base = suite(60, () => [run(1, 1, 0), run(1, 1, 0)]);
    const candidate = suite(60, (i) => (i % 3 === 0 ? [run(0, 1, 1), run(0, 1, 1)] : [run(1, 1, 0), run(1, 1, 0)]));
    const c = compareRuns(base, candidate);
    expect(c.verdict).toBe("hold");
    expect(c.reasons.join(" ")).toMatch(/^recall: /);
  });

  it("holds a candidate over the cost budget", () => {
    const base = suite(60, () => [run(1, 1, 1, 0.1)]);
    const candidate = suite(60, () => [run(1, 1, 1, 0.2)]);
    const c = compareRuns(base, candidate);
    expect(c.verdict).toBe("hold");
    expect(c.reasons).toEqual(["cost: 2.00x the base per review (limit 1.25x)"]);
  });

  it("calls a small, noisy suite inconclusive instead of passing it", () => {
    const base = suite(4, (i) => [run(i % 2, 1, 1 - (i % 2))]);
    const candidate = suite(4, (i) => [run((i + 1) % 2, 1, 1 - ((i + 1) % 2))]);
    expect(compareRuns(base, candidate).verdict).not.toBe("ship");
  });

  it("leaves out and lists cases found in only one file", () => {
    const base: CaseRuns = new Map([["a", [run(1, 0, 0)]], ["b", [run(1, 0, 0)]]]);
    const candidate: CaseRuns = new Map([["a", [run(1, 0, 0)]], ["c", [run(1, 0, 0)]]]);
    const c = compareRuns(base, candidate);
    expect(c.cases).toBe(1);
    expect(c.unmatched).toEqual(["b", "c"]);
  });
});
