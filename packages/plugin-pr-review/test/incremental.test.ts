import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@valet/engine";
import {
  mapLineThroughHunks,
  memoryReviewState,
  parseHunks,
  reviewPullRequestIncrement,
  sameIssue,
  type AgentRunner,
  type AgentSpec,
} from "../src/index.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** main has a.py; the PR branch adds a buggy line and a bad helper. */
function prRepo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-incr-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.py"), "def f(x):\n    return x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "pr");
  writeFileSync(join(dir, "a.py"), "def f(x):\n    return x / 0\n\ndef g(y):\n    return y[0]\n");
  git(dir, "commit", "-qam", "pr commit 1");
  return { dir, base };
}

const finding = (line: number, title: string) =>
  ({ path: "a.py", line, severity: "high", category: "bug", trigger: `any call (${title})`, evidence: `a.py:${line}`, title, body: "b" }) as const;

async function submit(spec: AgentSpec, name: string, args: unknown): Promise<void> {
  const tool = spec.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no ${name} tool`);
  // The submit tools ignore their context.
  await tool.execute(args as never, {} as ToolContext);
}

const confirm = { located_code: "x", evidence: "e", trigger: "t", introduced_by_pr: true, refutation_attempt: "r", counter_evidence: "", verdict: "unverifiable" };

/** Scripted agents: the reviewer posts `findings`; verifiers keep everything; rechecks refute when told to. */
function agents(findings: ReturnType<typeof finding>[], opts: { refuteRecheck?: boolean; prompts?: string[] } = {}): AgentRunner {
  return async (spec) => {
    opts.prompts?.push(`${spec.label}\n${spec.prompt}`);
    if (spec.label === "review") await submit(spec, "submit_review", { summary: "s", confidence: 3, findings });
    else if (spec.label.startsWith("recheck") && opts.refuteRecheck && spec.prompt.includes("Division")) {
      await submit(spec, "submit_verdict", { ...confirm, verdict: "refuted", counter_evidence: "a.py:2 now returns x", refutation_reason: "guarded" });
    } else await submit(spec, "submit_verdict", confirm);
    return { outcome: "completed" };
  };
}

describe("reviewPullRequestIncrement", () => {
  it("reviews the first push in full, then only the new commits, carrying findings forward", async () => {
    const { dir, base } = prRepo();
    const store = memoryReviewState();
    const opts = { workspace: dir, base, head: "HEAD", title: "t", body: "", key: "o/r#1", store };

    const r1 = await reviewPullRequestIncrement(opts, agents([finding(2, "Division by zero in f"), finding(5, "Index error on empty y in g")]));
    expect(r1.mode).toBe("full");
    expect(r1.posted.map((f) => f.id)).toEqual(["f1", "f2"]);

    // Commit 2 fixes f's division and adds a docstring line above g, shifting g down by one.
    writeFileSync(join(dir, "a.py"), "def f(x):\n    return x\n\n# helper\ndef g(y):\n    return y[0]\n\ndef h(z):\n    return z.k\n");
    git(dir, "commit", "-qam", "pr commit 2");
    const prompts: string[] = [];
    const r2 = await reviewPullRequestIncrement(
      opts,
      agents([finding(9, "Attribute error on z in h"), finding(6, "Index error on empty y in g")], { refuteRecheck: true, prompts }),
    );
    expect(r2.mode).toBe("incremental");
    // Both are in the changed file, so both are rechecked: f1 is fixed, f2 is not.
    expect(r2.resolved.map((f) => f.id)).toEqual(["f1"]);
    expect(r2.stillOpen.map((f) => f.id)).toEqual(["f2"]);
    // The duplicate of f2 is dropped; the new finding gets the next id.
    expect(r2.posted.map((f) => [f.id, f.title])).toEqual([["f3", "Attribute error on z in h"]]);
    const review = prompts.find((p) => p.startsWith("review\n")) ?? "";
    expect(review).toContain("## Follow-up review");
    expect(review).toContain("Index error on empty y in g");
    expect(review).toContain("+def h(z):");
    expect(review).not.toContain("+def g(y):");
    expect(r2.state.findings.map((f) => `${f.id}:${f.status}`)).toEqual(["f1:resolved", "f2:open", "f3:open"]);

    const r3 = await reviewPullRequestIncrement(opts, agents([]));
    expect(r3.mode).toBe("unchanged");
  });

  it("falls back to a full review after a force-push, keeping open findings", async () => {
    const { dir, base } = prRepo();
    const store = memoryReviewState();
    const opts = { workspace: dir, base, head: "HEAD", title: "t", body: "", key: "o/r#2", store };
    await reviewPullRequestIncrement(opts, agents([finding(5, "Index error on empty y in g")]));
    writeFileSync(join(dir, "a.py"), "def f(x):\n    return x / 0\n\ndef g(y):\n    return y[0]\n# amended\n");
    git(dir, "commit", "-q", "--amend", "-am", "pr commit 1 (amended)");
    const r = await reviewPullRequestIncrement(opts, agents([finding(5, "Index error on empty y in g")]));
    expect(r.mode).toBe("full");
    expect(r.stillOpen.map((f) => f.id)).toEqual(["f1"]);
    expect(r.posted).toEqual([]);
  });

  it("does not advance the state when the review fails", async () => {
    const { dir, base } = prRepo();
    const store = memoryReviewState();
    const opts = { workspace: dir, base, head: "HEAD", title: "t", body: "", key: "o/r#3", store };
    await reviewPullRequestIncrement(opts, async () => ({ outcome: "timeout", error: "slow" }));
    expect(await store.get("o/r#3")).toBeUndefined();
  });
});

describe("line mapping", () => {
  const hunks = parseHunks("@@ -2 +2 @@\n-a\n+b\n@@ -4,0 +5,2 @@\n+c\n+d\n@@ -8,2 +10 @@\n-e\n-f\n+g\n");
  it("marks changed lines touched and shifts the rest", () => {
    expect(mapLineThroughHunks(hunks, 1)).toEqual({ kind: "moved", line: 1 });
    expect(mapLineThroughHunks(hunks, 2)).toEqual({ kind: "touched" });
    expect(mapLineThroughHunks(hunks, 4)).toEqual({ kind: "moved", line: 4 });
    expect(mapLineThroughHunks(hunks, 5)).toEqual({ kind: "moved", line: 7 });
    expect(mapLineThroughHunks(hunks, 9)).toEqual({ kind: "touched" });
    expect(mapLineThroughHunks(hunks, 12)).toEqual({ kind: "moved", line: 13 });
  });
});

describe("sameIssue", () => {
  it("matches near lines with overlapping titles only", () => {
    expect(sameIssue(finding(5, "Index error on empty y in g"), finding(7, "Index error when y is empty in g"))).toBe(true);
    expect(sameIssue(finding(5, "Index error on empty y in g"), finding(12, "Index error on empty y in g"))).toBe(false);
    expect(sameIssue(finding(5, "Index error on empty y in g"), finding(5, "Race on shared cache"))).toBe(false);
  });
});
