import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEvalCase } from "../src/index.js";
import { githubRepo, privateRemoteAccess, resolvePrivateCases } from "../src/private-pull-request.js";

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
    expect(githubRepo("https://github.com/acme/app.git")).toBe("acme/app");
    expect(githubRepo("git@github.com:acme/ops.git")).toBe("acme/ops");
    expect(githubRepo("https://example.com/acme/app.git")).toBeUndefined();
  });
});

describe("private remote access", () => {
  it("treats a remote it cannot read as denied, so the case SKIPs", async () => {
    const access = await privateRemoteAccess("/nonexistent/private-suites-remote");
    expect(access.kind).toBe("denied");
  });

  it("treats a connection failure as an error, so the case fails", async () => {
    const access = await privateRemoteAccess("https://127.0.0.1:1/o/r.git");
    expect(access).toMatchObject({ kind: "error" });
  });
});

describe("--cases private:<suite>", () => {
  it("passes other values through", () => {
    expect(resolvePrivateCases("evals/cases/hard", {})).toBeUndefined();
  });

  it("skips when the variable is unset or the suite is missing", () => {
    expect(resolvePrivateCases("private:turnkey-history", {})).toMatchObject({ skip: expect.stringMatching(/VALET_EVAL_PRIVATE_CASES/) });
    const root = mkdtempSync(join(tmpdir(), "private-suites-"));
    expect(resolvePrivateCases("private:turnkey-history", { VALET_EVAL_PRIVATE_CASES: root })).toMatchObject({ skip: expect.stringMatching(/not in/) });
    expect(resolvePrivateCases("private:../x", { VALET_EVAL_PRIVATE_CASES: root })).toMatchObject({ skip: expect.stringMatching(/not a suite name/) });
  });

  it("resolves the suite directory when it exists", () => {
    const root = mkdtempSync(join(tmpdir(), "private-suites-"));
    mkdirSync(join(root, "turnkey-history"));
    expect(resolvePrivateCases("private:turnkey-history", { VALET_EVAL_PRIVATE_CASES: root })).toEqual({ dir: join(root, "turnkey-history") });
  });
});
