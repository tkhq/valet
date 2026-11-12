import { describe, expect, it } from "vitest";
import { parseEvalCase } from "../src/index.js";
import { buildCaseMatrix, matrixColumns, matrixTotals, renderMatrixMarkdown } from "../src/review-matrix.js";

/** A fake judge: two texts match when they share the first word. */
const judge = async (_system: string, prompt: string): Promise<string> => {
  const golden = /Golden Comment[^\n]*\n(\S+)/.exec(prompt)?.[1];
  const candidate = /Candidate Issue[^\n]*\n(\S+)/.exec(prompt)?.[1];
  return JSON.stringify({ reasoning: "", match: golden === candidate, confidence: 0.9 });
};

const evalCase = parseEvalCase(
  {
    id: "m",
    pull_request: { repo: "r", remote: "https://github.com/o/r.git", base: "a", head: "b", title: "t" },
    checks: [
      {
        type: "review_match",
        golden: [
          { comment: "race on the cache map", category: "concurrency" },
          { comment: "leak of the token in logs", category: "security" },
        ],
        reference: { vendor: { matched: [1], fp: 2 } },
      },
    ],
  },
  "m.yaml",
);

describe("reviewer matrix", () => {
  it("seeds rows with golden comments and attributes each reviewer", async () => {
    const m = await buildCaseMatrix(
      judge,
      evalCase,
      [{ label: "valet", findings: [{ path: "a.go", line: 3, title: "race in cache", body: "two writers", severity: "high", category: "concurrency" }, { path: "b.go", line: 9, title: "typo here", body: "in a comment" }] }],
      {
        golden_links: [["https://github.com/o/r/pull/1#discussion_r1"], ["https://github.com/o/r/pull/1#discussion_r2"]],
        findings: [
          { reviewer: "copilot", issue: "typo in the doc", url: "https://github.com/o/r/pull/1#discussion_r3" },
          { reviewer: "copilot", issue: "unused import", url: "https://github.com/o/r/pull/1#discussion_r4", noise: true },
          { reviewer: "copilot", issue: "retry storm", url: "https://github.com/o/r/pull/1#discussion_r5", acted: true },
        ],
      },
    );
    const byIssue = Object.fromEntries(m.rows.map((r) => [r.issue.split(" ")[0], r]));
    expect(byIssue.race.caughtBy).toMatchObject({ human: ["https://github.com/o/r/pull/1#discussion_r1"], valet: ["a.go:3"] });
    expect(byIssue.leak.caughtBy.vendor).toEqual([""]);
    expect(byIssue.typo.status).toBe("corroborated");
    expect(byIssue.unused.status).toBe("noise");
    expect(byIssue.retry.status).toBe("acted");
    expect(m.unmatchedCounts).toEqual({ vendor: 2 });

    const cols = matrixColumns([m], ["valet"]);
    expect(cols).toEqual(["human", "valet", "copilot", "vendor"]);
    const totals = matrixTotals([m], cols);
    expect(totals.valet).toMatchObject({ all: 2, human: 1, corroborated: 1 });
    expect(totals.copilot).toMatchObject({ all: 3, acted: 1, corroborated: 1, noise: 1 });
    const md = renderMatrixMarkdown([m], ["valet"]);
    expect(md).toContain("| issue | category | severity | status | human | valet | copilot | vendor |");
    expect(md).toContain("Unmatched issues with no text: vendor 2.");
  });

  it("does not count two Valet runs as corroboration", async () => {
    const finding = { path: "c.ts", line: 1, title: "stale cache", body: "x" };
    const m = await buildCaseMatrix(judge, evalCase, [{ label: "valet", findings: [finding] }, { label: "valet-context", findings: [finding] }], undefined);
    expect(m.rows.find((r) => r.issue.startsWith("stale"))?.status).toBe("unconfirmed");
  });
});
