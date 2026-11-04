import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@valet/engine";
import { decideFinding, mergeFindings, quoteInFile, runReviewPipeline, type AgentRunner, type AgentSpec } from "../src/index.js";

function repo(): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-pipeline-"));
  const g = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "a.py"), "x = 1\n");
  g("add", ".");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  writeFileSync(join(dir, "a.py"), "x = 1\ny = x / 0\n");
  g("commit", "-qam", "head");
  return { dir, base, head: g("rev-parse", "HEAD") };
}

const finding = (title: string) => ({ path: "a.py", line: 2, severity: "high", category: "bug", title, body: "b" }) as const;

/** Calls the agent's submit tool directly, as the model would. */
async function submit(spec: AgentSpec, name: string, args: unknown): Promise<void> {
  const tool = spec.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no ${name} tool`);
  // The submit tools ignore their context.
  await tool.execute(args as never, {} as ToolContext);
}

describe("runReviewPipeline", () => {
  it("drops findings the verifier rejects and keeps the draft", async () => {
    const { dir, base, head } = repo();
    const seen: string[] = [];
    const run: AgentRunner = async (spec) => {
      seen.push(spec.label);
      if (spec.label === "review") {
        expect(spec.prompt).toContain("y = x / 0");
        await submit(spec, "submit_review", { summary: "s", confidence: 2, findings: [finding("Division by zero"), finding("Bogus")] });
      } else {
        expect(spec.prompt).toContain("## Claim to check");
        const bogus = spec.prompt.includes("Title: Bogus");
        await submit(spec, "submit_verdict", {
          located_code: "y = x / 0",
          evidence: "a.py:2 divides by zero",
          trigger: bogus ? "" : "any call",
          introduced_by_pr: true,
          counter_evidence: bogus ? "a.py:2 is never run" : "",
          verdict: bogus ? "refuted" : "confirmed",
          ...(bogus ? { refutation_reason: "guarded" } : {}),
        });
      }
      return { outcome: "completed" };
    };
    const result = await runReviewPipeline({ workspace: dir, base, head, title: "t", body: "" }, run);
    expect(seen.sort()).toEqual(["review", "verify:0", "verify:1"]);
    expect(result.draft?.findings.map((f) => f.title)).toEqual(["Division by zero", "Bogus"]);
    expect(result.review?.findings.map((f) => f.title)).toEqual(["Division by zero"]);
    expect(result.verdicts.map((v) => v.verdict)).toEqual(["confirmed", "refuted"]);
  });

  it("keeps a finding whose verifier gives no verdict, marked unverified", async () => {
    const { dir, base, head } = repo();
    const run: AgentRunner = async (spec) => {
      if (spec.label === "review") await submit(spec, "submit_review", { summary: "s", confidence: 3, findings: [finding("F")] });
      return spec.label === "review" ? { outcome: "completed" } : { outcome: "timeout", error: "slow" };
    };
    const result = await runReviewPipeline({ workspace: dir, base, head, title: "t", body: "" }, run);
    expect(result.review?.findings).toHaveLength(1);
    expect(result.verdicts[0]).toMatchObject({ verdict: "unverified", reason: "slow" });
  });

  it("merges two reviewer passes and drops a repeat on the same spot", async () => {
    const { dir, base, head } = repo();
    const labels: string[] = [];
    const run: AgentRunner = async (spec) => {
      labels.push(spec.label);
      const findings =
        spec.label === "review"
          ? [finding("Division by zero")]
          : [{ ...finding("Divides by zero again"), line: 3 }, { ...finding("Other file"), path: "b.py" }];
      await submit(spec, "submit_review", { summary: spec.label, confidence: 2, findings });
      return { outcome: "completed" };
    };
    const result = await runReviewPipeline({ workspace: dir, base, head, title: "t", body: "", passes: 2, verify: false }, run);
    expect(labels.sort()).toEqual(["review", "review:2"]);
    expect(result.review?.summary).toBe("review");
    expect(result.review?.findings.map((f) => f.title)).toEqual(["Division by zero", "Other file"]);
  });

  it("runs the verifiers on verifyModel and the reviewer on the host's model", async () => {
    const { dir, base, head } = repo();
    const models: Record<string, string | undefined> = {};
    const run: AgentRunner = async (spec) => {
      models[spec.label] = spec.model;
      if (spec.label === "review") await submit(spec, "submit_review", { summary: "s", confidence: 3, findings: [finding("F")] });
      return { outcome: "completed" };
    };
    await runReviewPipeline({ workspace: dir, base, head, title: "t", body: "", verifyModel: "openai/gpt-5.6-terra" }, run);
    expect(models).toEqual({ review: undefined, "verify:0": "openai/gpt-5.6-terra" });
  });

  it("diffs from the merge-base when the base branch moved on", async () => {
    const { dir, base, head } = repo();
    const g = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    // Move the base branch past the PR's fork point with an unrelated file.
    g("checkout", "-q", "-b", "moved", base);
    writeFileSync(join(dir, "unrelated.py"), "z = 3\n");
    g("add", ".");
    g("commit", "-qm", "base moved");
    const movedBase = g("rev-parse", "HEAD");
    g("checkout", "-q", head);
    let prompt = "";
    const run: AgentRunner = async (spec) => {
      prompt = spec.prompt;
      await submit(spec, "submit_review", { summary: "s", confidence: 5, findings: [] });
      return { outcome: "completed" };
    };
    await runReviewPipeline({ workspace: dir, base: movedBase, head, title: "t", body: "" }, run);
    expect(prompt).toContain("y = x / 0");
    expect(prompt).not.toContain("unrelated.py");
    expect(prompt).toContain(`BASE commit: ${base}`);
  });

  it("skips verification when verify is false", async () => {
    const { dir, base, head } = repo();
    const labels: string[] = [];
    const run: AgentRunner = async (spec) => {
      labels.push(spec.label);
      await submit(spec, "submit_review", { summary: "s", confidence: 3, findings: [finding("F")] });
      return { outcome: "completed" };
    };
    const result = await runReviewPipeline({ workspace: dir, base, head, title: "t", body: "", verify: false }, run);
    expect(labels).toEqual(["review"]);
    expect(result.review?.findings).toHaveLength(1);
  });
});

describe("decideFinding", () => {
  const base = {
    located_code: "y = x / 0",
    evidence: "e",
    trigger: "t",
    introduced_by_pr: true,
    counter_evidence: "",
  };
  const file = "x = 1\ny = x / 0\n";
  const high = finding("F");
  const low = { ...finding("F"), severity: "low" } as const;

  it("keeps a confirmed finding whose quote is in the file", () => {
    expect(decideFinding(high, { ...base, verdict: "confirmed" }, file)).toMatchObject({ keep: true, verdict: "confirmed" });
  });

  it("downgrades a confirmed finding whose quote is not in the file", () => {
    const d = decideFinding(low, { ...base, located_code: "z = 2", verdict: "confirmed" }, file);
    expect(d).toMatchObject({ keep: false, verdict: "unverifiable" });
    expect(decideFinding(high, { ...base, located_code: "z = 2", verdict: "confirmed" }, file).keep).toBe(true);
  });

  it("drops a refuted finding only with counter-evidence or a structural reason", () => {
    expect(decideFinding(high, { ...base, verdict: "refuted", counter_evidence: "a.py:1 guards it", refutation_reason: "guarded" }, file).keep).toBe(false);
    expect(decideFinding(high, { ...base, verdict: "refuted", refutation_reason: "pre_existing" }, file).keep).toBe(false);
    expect(decideFinding(high, { ...base, verdict: "refuted", refutation_reason: "guarded" }, file)).toMatchObject({ keep: true, verdict: "unverifiable" });
    // An argument without a code reference is not counter-evidence.
    expect(
      decideFinding(high, { ...base, verdict: "refuted", counter_evidence: "the feature needs it", refutation_reason: "misread" }, file),
    ).toMatchObject({ keep: true, verdict: "unverifiable" });
  });

  it("keeps unverifiable findings only at high or critical severity", () => {
    expect(decideFinding(high, { ...base, verdict: "unverifiable" }, file).keep).toBe(true);
    expect(decideFinding(low, { ...base, verdict: "unverifiable" }, file).keep).toBe(false);
  });

  it("quoteInFile ignores indentation and blank lines", () => {
    expect(quoteInFile("  y = x / 0\n\n", file)).toBe(true);
    expect(quoteInFile("", file)).toBe(false);
  });
});

describe("mergeFindings", () => {
  it("keeps the first report on a spot and every report elsewhere", () => {
    const at = (path: string, line: number, title: string) => ({ ...finding(title), path, line });
    expect(
      mergeFindings([
        [at("a.py", 10, "A"), at("a.py", 11, "A2"), at("a.py", 40, "B")],
        [at("a.py", 13, "A again"), at("a.py", 20, "C"), at("b.py", 10, "D")],
      ]).map((f) => f.title),
    ).toEqual(["A", "A2", "B", "C", "D"]);
  });
});
