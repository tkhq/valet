import type { ToolDef } from "@valet/engine";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { reviewerBashTool } from "./bash.js";
import { git } from "./git.js";
import type { AgentSpec } from "./pipeline.js";
import type { Finding } from "./types.js";

/**
 * Evidence comes before the verdict: in BitsAI-CR (arXiv 2501.15134) a
 * verdict-first filter lost 12.8 recall points against reasoning-first.
 */
export const VerdictSchema = Type.Object({
  located_code: Type.String({
    description: "The cited code, copied verbatim from the HEAD file (one or more whole lines). Empty if it does not exist.",
  }),
  evidence: Type.String({ description: "What you read that bears on the claim, each fact with path:line." }),
  trigger: Type.String({ description: "The concrete input or state that makes the code fail, or empty if none." }),
  introduced_by_pr: Type.Boolean({
    description: "True if the faulty code is in a hunk or function the PR changes, or the PR newly reaches it. An older defect in code the PR touches counts.",
  }),
  counter_evidence: Type.String({
    description: "Code that rules the claim out (a guard, a type, a caller contract), with path:line. Empty if none.",
  }),
  current_line: Type.Optional(Type.Integer({ minimum: 1, description: "The line at HEAD where the cited code is now." })),
  verdict: Type.Union([Type.Literal("confirmed"), Type.Literal("refuted"), Type.Literal("unverifiable")]),
  refutation_reason: Type.Optional(
    Type.Union([
      Type.Literal("not_found"),
      Type.Literal("pre_existing"),
      Type.Literal("guarded"),
      Type.Literal("misread"),
      Type.Literal("out_of_scope"),
      Type.Literal("style"),
    ]),
  ),
});
export type Verdict = Static<typeof VerdictSchema>;

/** Per-file diff budget in the verifier prompt. */
const FILE_DIFF_CHARS = 30_000;

export const VERIFIER_SYSTEM_PROMPT = `You check one claim that another reviewer made about a pull request. The claim is unconfirmed until the code shows it. You have the repository checked out at the PR head commit, with read-only tools: \`read\` and \`bash\` (grep, rg, git log/show/diff/blame). Stay inside the repository.

How to work:
1. Find the cited code at the cited path and line, and copy it verbatim. If it does not exist there or nearby, the claim is refuted (not_found).
2. Before you judge anything about a symbol defined elsewhere, look up its definition and its callers. Do not assume what a function, type or config does.
3. Look for evidence on both sides: what makes the code fail, and what would prevent it (a guard, a type, a caller contract, framework behavior visible in the repository).
4. Check whether the faulty code is in a hunk or function the PR changes, or whether the PR newly reaches it. Use the diff below or \`git diff\`.

Decide:
- confirmed: you can name the concrete trigger (an input or state that real callers can produce) and the wrong result, and the faulty code is in a hunk or function the PR changes, or the PR newly reaches it. A defect the PR did not create still counts when it sits in code the PR touches: the PR is the time to fix it.
- refuted: code you read rules the claim out (cite it as path:line), the cited code is not there, the faulty code is outside every hunk and function the PR changes and the PR does not change how it is reached (pre_existing), or it is style, naming, docs, or a request for tests without a concrete defect. Give the counter-evidence and a refutation_reason.
- unverifiable: you could neither confirm nor refute it from the code. Do not guess either way.

A behavior that looks intended is not a refutation. Refute only when the code shows the failure cannot happen or the PR does not cause it.

Fill the fields in order, evidence before the verdict. Call \`submit_verdict\` exactly once, then stop.`;

export interface VerifierSpecOptions {
  workspace: string;
  base: string;
  head: string;
  title: string;
  finding: Finding;
  /** Label for logs and trajectories. */
  label: string;
  /** Recheck of a finding posted on an earlier commit whose code has since changed. */
  recheckFrom?: string;
  /** provider/model for the verifier. Unset: the host's model. */
  model?: string;
}

export interface VerifierSpec extends AgentSpec {
  verdict(): Verdict | undefined;
}

export async function createVerifierSpec(opts: VerifierSpecOptions): Promise<VerifierSpec> {
  const f = opts.finding;
  let fileDiff = await git(opts.workspace, ["diff", "--unified=5", opts.base, opts.head, "--", f.path]).catch(() => "");
  if (fileDiff.length > FILE_DIFF_CHARS) fileDiff = `${fileDiff.slice(0, FILE_DIFF_CHARS)}\n# (diff cut; run git diff for the rest)\n`;

  let submitted: Verdict | undefined;
  const submitVerdict: ToolDef<typeof VerdictSchema> = {
    name: "submit_verdict",
    description: "Submit the verdict on the finding. Call exactly once, at the end.",
    parameters: VerdictSchema,
    sideEffect: "none",
    execute: async (args) => {
      if (!Value.Check(VerdictSchema, args)) {
        const first = [...Value.Errors(VerdictSchema, args)].slice(0, 3);
        return { text: `Verdict rejected: ${first.map((e) => `${e.instancePath} ${e.message}`).join("; ")}. Fix and call again.` };
      }
      submitted = args;
      return { text: "Verdict recorded. Stop now." };
    },
  };

  const prompt = [
    `# Pull request: ${opts.title}`,
    `BASE commit: ${opts.base}`,
    `HEAD commit: ${opts.head} (checked out)`,
    "",
    "## Claim to check",
    opts.recheckFrom !== undefined
      ? `A reviewer posted this claim on commit ${opts.recheckFrom}. Later commits changed the code at that line. Check whether the defect is still present at HEAD; the line may have moved. Refute it if the new code fixes it.`
      : "Another reviewer posted this claim. Check it against the code.",
    `File: ${f.path}, line ${f.line} (HEAD)`,
    `Severity claimed: ${f.severity}, category: ${f.category}`,
    `Title: ${f.title}`,
    `Body: ${f.body}`,
    "",
    `## Diff of ${f.path}`,
    "```diff",
    fileDiff.trimEnd() || "(no changes to this file in the PR)",
    "```",
    "",
    "Check the claim, then call submit_verdict.",
  ].join("\n");

  return {
    label: opts.label,
    systemPrompt: VERIFIER_SYSTEM_PROMPT,
    builtinToolNames: new Set(["read"]),
    tools: [reviewerBashTool(opts.workspace), submitVerdict],
    prompt,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    verdict: () => submitted,
  };
}

/** A `path:line` reference, e.g. `pkg/a.go:42` or `a.py:3-9`. */
const CODE_REF = /[\w./-]+\.\w+:\d+/;

/** Severities whose unverifiable findings stay posted: missing one costs more than a false alarm. */
const KEEP_UNVERIFIABLE = new Set(["critical", "high"]);

export type FinalVerdict = "confirmed" | "refuted" | "unverifiable" | "unverified";

/**
 * Turn the verifier's answer into the decision the pipeline acts on:
 * - a "confirmed" whose quoted code is not in the file is downgraded to
 *   unverifiable (a confirmation the verifier did not read);
 * - a "refuted" needs counter-evidence or a not_found/style/out_of_scope/
 *   pre_existing reason, else it is unverifiable;
 * - unverifiable findings are kept only at high or critical severity.
 */
export function decideFinding(
  finding: Finding,
  verdict: Verdict | undefined,
  fileText: string | undefined,
): { keep: boolean; verdict: FinalVerdict; reason: string } {
  if (verdict === undefined) return { keep: true, verdict: "unverified", reason: "the verifier gave no verdict" };
  let v: FinalVerdict = verdict.verdict;
  let reason = verdict.verdict === "refuted" ? (verdict.counter_evidence || verdict.refutation_reason || "") : verdict.evidence;
  if (v === "confirmed" && !quoteInFile(verdict.located_code, fileText)) {
    v = "unverifiable";
    reason = "confirmed, but the quoted code is not in the file";
  }
  // "guarded" and "misread" claim the code rules the finding out, so they must cite it.
  const needsCode = verdict.refutation_reason === undefined || verdict.refutation_reason === "guarded" || verdict.refutation_reason === "misread";
  const groundless = needsCode && !CODE_REF.test(verdict.counter_evidence);
  if (v === "refuted" && groundless) {
    v = "unverifiable";
    reason = `refuted without cited code: ${verdict.counter_evidence.slice(0, 200)}`;
  }
  if (v === "confirmed") return { keep: true, verdict: v, reason };
  if (v === "refuted") return { keep: false, verdict: v, reason: `${verdict.refutation_reason ?? "refuted"}: ${reason}` };
  return { keep: KEEP_UNVERIFIABLE.has(finding.severity), verdict: v, reason };
}

/** Every non-blank quoted line appears in the file, ignoring indentation. */
export function quoteInFile(quote: string, fileText: string | undefined): boolean {
  if (fileText === undefined) return false;
  const lines = new Set(fileText.split("\n").map((l) => l.trim()));
  const quoted = quote.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return quoted.length > 0 && quoted.every((l) => lines.has(l));
}
