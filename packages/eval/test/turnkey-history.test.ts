import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REVIEW_PROFILE_CATEGORIES } from "../src/checks/review-match.js";
import { loadCases, parseEvalCase } from "../src/index.js";
import { githubRepo, privateRemoteDenied } from "../src/private-pull-request.js";

const SUITE = fileURLToPath(new URL("../../../evals/cases/turnkey-history", import.meta.url));

describe("turnkey-history suite", () => {
  it("holds remotes, commits and golden findings only", async () => {
    const cases = await loadCases(SUITE);
    expect(cases).toHaveLength(17);
    for (const c of cases) {
      const pr = c.pull_request;
      expect(pr?.private, c.id).toBe(true);
      expect(pr?.number, c.id).toBeGreaterThan(0);
      expect(pr?.body, c.id).toBeUndefined();
      expect(pr?.remote, c.id).toMatch(/^https:\/\/github\.com\/tkhq\/(mono|gitops)\.git$/);
      const check = c.checks.find((k) => k.type === "review_match");
      if (check?.type !== "review_match") throw new Error(`${c.id} has no review_match check`);
      for (const g of check.golden) {
        expect(REVIEW_PROFILE_CATEGORIES.core.has(g.category), `${c.id}: ${g.category}`).toBe(true);
        expect(g.fix?.length ?? 0, c.id).toBeGreaterThan(0);
      }
    }
    const golden = cases.flatMap((c) => c.checks.flatMap((k) => (k.type === "review_match" ? k.golden : [])));
    expect(golden).toHaveLength(20);
  });
});

describe("private pull_request fields", () => {
  const base = {
    id: "p",
    checks: [{ type: "review_match", golden: [{ comment: "c", category: "bug" }] }],
    pull_request: { repo: "r", remote: "https://github.com/o/r.git", base: "a", head: "b", title: "t" },
  };

  it("parses private, number and golden fix", () => {
    const c = parseEvalCase(
      {
        ...base,
        pull_request: { ...base.pull_request, private: true, number: 12 },
        checks: [{ type: "review_match", golden: [{ comment: "c", category: "bug", fix: "f" }] }],
      },
      "t.yaml",
    );
    expect(c.pull_request).toMatchObject({ private: true, number: 12 });
    const check = c.checks[0];
    expect(check.type === "review_match" ? check.golden[0].fix : undefined).toBe("f");
  });

  it("rejects a bad private flag or number", () => {
    expect(() => parseEvalCase({ ...base, pull_request: { ...base.pull_request, private: "yes" } }, "t.yaml")).toThrow(/private/);
    expect(() => parseEvalCase({ ...base, pull_request: { ...base.pull_request, number: 0 } }, "t.yaml")).toThrow(/number/);
  });

  it("reads owner/name from GitHub remotes only", () => {
    expect(githubRepo("https://github.com/tkhq/mono.git")).toBe("tkhq/mono");
    expect(githubRepo("git@github.com:tkhq/gitops.git")).toBe("tkhq/gitops");
    expect(githubRepo("https://example.com/tkhq/mono.git")).toBeUndefined();
  });

  it("gives a skip reason for a remote it cannot read", async () => {
    await expect(privateRemoteDenied("/nonexistent/turnkey-history-remote")).resolves.toMatch(/no read access/);
  });
});
