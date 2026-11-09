import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDef } from "@valet/engine";
import { git } from "./git.js";
import { createReviewerSpec, type ReviewerSpecOptions } from "./review.js";
import type { Finding, Review } from "./types.js";
import { createVerifierSpec, decideFinding, type FinalVerdict } from "./verify.js";

/** One agent session to run: the host supplies the engine, model and sandbox. */
export interface AgentSpec {
  /** `review` or `verify:<n>`, for logs and trajectories. */
  label: string;
  systemPrompt: string;
  /** Names of the engine built-ins the agent keeps. */
  builtinToolNames: ReadonlySet<string>;
  tools: ToolDef[];
  prompt: string;
  /** provider/model for this agent. Unset: the host's model. */
  model?: string;
}

export interface AgentRunResult {
  outcome: "completed" | "failed" | "timeout";
  error?: string;
}

/** Runs one agent to completion. The plugin CLI and the eval runner each supply one. */
export type AgentRunner = (spec: AgentSpec) => Promise<AgentRunResult>;

export interface FindingVerdict {
  /** Index into `draft.findings`. */
  index: number;
  /** `unverified`: the verifier ended without a verdict; the finding is kept and counted. */
  verdict: FinalVerdict;
  /** Whether the finding stays in the posted review. */
  kept: boolean;
  reason: string;
}

export interface PipelineResult {
  outcome: AgentRunResult["outcome"] | "no_review";
  error?: string;
  /** The review after verification: the findings `decideFinding` kept. */
  review?: Review;
  /** The reviewer's own review, before verification. */
  draft?: Review;
  verdicts: FindingVerdict[];
}

export interface PipelineOptions extends ReviewerSpecOptions {
  /** Check each finding with a verifier agent. Default false. */
  verify?: boolean;
  /** Verifier agents in flight at once. Default 4. */
  verifyConcurrency?: number;
  /** provider/model for the verifiers. Unset: the reviewer's model. */
  verifyModel?: string;
  /** Independent reviewer passes, merged by location before verification. Default 1. */
  passes?: number;
  /** Drop findings the reviewer rated below this confidence (0-1). A finding with no rating stays. Unset: keep all. */
  minConfidence?: number;
}

/** Whether a finding clears the confidence threshold. */
export function confidentEnough(f: Finding, minConfidence: number | undefined): boolean {
  return minConfidence === undefined || f.confidence === undefined || f.confidence >= minConfidence;
}

/** Findings this close on the same file are one report. */
const SAME_SPOT_LINES = 3;

/**
 * Union of the passes' findings, in pass order. A finding on the same file
 * within SAME_SPOT_LINES of one an earlier pass reported is a repeat and is
 * dropped: it would read, and score, as a second comment. Findings within
 * one pass are all kept; the reviewer already split them as distinct.
 */
export function mergeFindings(passes: Finding[][]): Finding[] {
  const kept: Finding[] = [];
  for (const findings of passes) {
    const earlier = [...kept];
    for (const f of findings) {
      if (!earlier.some((k) => k.path === f.path && Math.abs(k.line - f.line) <= SAME_SPOT_LINES)) kept.push(f);
    }
  }
  return kept;
}

/**
 * Review a pull request: the reviewer proposes findings, then one verifier
 * per finding checks it in a fresh session, and `decideFinding` keeps or
 * drops it. Refuted findings are dropped; see `decideFinding` for the rest.
 */
export async function runReviewPipeline(input: PipelineOptions, run: AgentRunner): Promise<PipelineResult> {
  // Review what GitHub shows: the change since the merge-base. A two-dot
  // diff from a base branch that moved on shows its later commits reversed.
  const opts = { ...input, base: await mergeBase(input.workspace, input.base, input.head) };
  // Passes run in parallel; each samples its own path through the PR, so
  // their union finds more than one pass. Pass 1 keeps the label "review".
  const passCount = Math.max(1, opts.passes ?? 1);
  const passes = await Promise.all(
    Array.from({ length: passCount }, async (_, i) => {
      const reviewer = await createReviewerSpec(opts);
      const result = await run({ ...reviewer, label: i === 0 ? "review" : `review:${i + 1}` });
      return { result, review: result.outcome === "completed" ? reviewer.review() : undefined };
    }),
  );
  const done = passes.filter((p): p is { result: AgentRunResult; review: Review } => p.review !== undefined);
  const reviewRun = done[0]?.result ?? passes[0].result;
  const draft: Review | undefined =
    done.length > 0 ? { ...done[0].review, findings: mergeFindings(done.map((p) => p.review.findings)) } : passes[0].review;
  if (reviewRun.outcome !== "completed" || draft === undefined) {
    return {
      outcome: reviewRun.outcome === "completed" ? "no_review" : reviewRun.outcome,
      ...(reviewRun.error !== undefined ? { error: reviewRun.error } : {}),
      ...(draft !== undefined ? { draft, review: draft } : {}),
      verdicts: [],
    };
  }
  // `draft` stays whole, so a run can score what the threshold cost.
  const gate = (f: Finding): boolean => confidentEnough(f, opts.minConfidence);
  if (opts.verify !== true || draft.findings.length === 0) {
    return { outcome: "completed", review: { ...draft, findings: draft.findings.filter(gate) }, draft, verdicts: [] };
  }

  const verdicts: (FindingVerdict | undefined)[] = new Array(draft.findings.length);
  let next = 0;
  const limit = Math.max(1, opts.verifyConcurrency ?? 4);
  await Promise.all(
    Array.from({ length: Math.min(limit, draft.findings.length) }, async () => {
      while (next < draft.findings.length) {
        const index = next++;
        if (!gate(draft.findings[index])) continue;
        const spec = await createVerifierSpec({
          ...opts,
          finding: draft.findings[index],
          label: `verify:${index}`,
          ...(opts.verifyModel !== undefined ? { model: opts.verifyModel } : {}),
        });
        const result = await run(spec);
        const finding = draft.findings[index];
        const fileText = await readFile(join(opts.workspace, finding.path), "utf8").catch(() => undefined);
        const decision = decideFinding(finding, spec.verdict(), fileText);
        verdicts[index] = {
          index,
          verdict: decision.verdict,
          kept: decision.keep,
          reason: decision.verdict === "unverified" ? (result.error ?? `verifier ended (${result.outcome}) without a verdict`) : decision.reason,
        };
      }
    }),
  );
  const kept = draft.findings.filter((_, i) => verdicts[i]?.kept === true);
  return { outcome: "completed", review: { ...draft, findings: kept }, draft, verdicts: verdicts.filter((v): v is FindingVerdict => v !== undefined) };
}

async function mergeBase(workspace: string, base: string, head: string): Promise<string> {
  const sha = (await git(workspace, ["merge-base", base, head])).trim();
  if (!sha) throw new Error(`No merge-base between ${base} and ${head}. Fetch both commits with their history.`);
  return sha;
}
