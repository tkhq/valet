import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDef } from "@valet/engine";
import { consolidateFindings, type Consolidation } from "./consolidate.js";
import { applyDuplicateGroups, clusterExcerpt, createDedupeSpec, duplicateCandidates } from "./dedupe.js";
import { gatherContext, type PackMemory } from "./context/gather.js";
import type { ContextPack } from "./context/pack.js";
import { rankPatch } from "./context/rank.js";
import { gitFileAt, localRunner } from "./context/repo.js";
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
  /** The gather stage's pack, when `contextBudget` is set. */
  context?: ContextPack;
  /** What the consolidate stage dropped from `draft`, and why. */
  consolidation?: Consolidation["dropped"];
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
  /** Character budget of the context pack built before the review. 0 or unset: no pack. */
  contextBudget?: number;
  /** Team memory for the pack's principles and notes. */
  memory?: PackMemory;
  /** `owner/name`, for memory queries. */
  repo?: string;
  /** Drop findings the reviewer rated below this confidence (0-1). A finding with no rating stays. Unset: keep all. */
  minConfidence?: number;
  /** Ask a model which nearby findings report the same defect, and keep one of each. Default false. */
  dedupe?: boolean;
  /** provider/model for the dedupe stage. Unset: the reviewer's model. */
  dedupeModel?: string;
}

/** Whether a finding clears the confidence threshold. */
export function confidentEnough(f: Finding, minConfidence: number | undefined): boolean {
  return minConfidence === undefined || f.confidence === undefined || f.confidence >= minConfidence;
}

/** Characters of diff in the review prompt (the reviewer's default); the pack's drop log names the files past it. */
const DIFF_BUDGET = 150_000;

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
      // LEFT and RIGHT lines number different files, so only the same side can repeat.
      const sameSpot = (k: Finding): boolean => k.path === f.path && (k.side ?? "RIGHT") === (f.side ?? "RIGHT") && Math.abs(k.line - f.line) <= SAME_SPOT_LINES;
      if (!earlier.some(sameSpot)) kept.push(f);
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
  // Gather once, before any pass: every pass reads the same pack.
  let context: ContextPack | undefined;
  if ((opts.contextBudget ?? 0) > 0) {
    const from = opts.incrementFrom ?? opts.base;
    const patch = await git(opts.workspace, ["diff", "--unified=5", from, opts.head]);
    context = await gatherContext({
      runner: localRunner(opts.workspace),
      // Instructions come from the merge base, never from the PR head.
      readTrusted: (path) => gitFileAt(opts.workspace, opts.base, path),
      patch,
      diffDropped: rankPatch(patch, opts.diffBudgetChars ?? DIFF_BUDGET).dropped,
      title: opts.title,
      budgetChars: opts.contextBudget ?? 0,
      ...(opts.memory ? { memory: opts.memory } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
    });
  }
  const withContext = { ...opts, ...(context ? { contextPack: context.text } : {}) };
  // Passes run in parallel; each samples its own path through the PR, so
  // their union finds more than one pass. Pass 1 keeps the label "review".
  const passCount = Math.max(1, opts.passes ?? 1);
  const passes = await Promise.all(
    Array.from({ length: passCount }, async (_, i) => {
      const reviewer = await createReviewerSpec(withContext);
      const result = await run({ ...reviewer, label: i === 0 ? "review" : `review:${i + 1}` });
      return { result, review: result.outcome === "completed" ? reviewer.review() : undefined };
    }),
  );
  const done = passes.filter((p): p is { result: AgentRunResult; review: Review } => p.review !== undefined);
  const reviewRun = done[0]?.result ?? passes[0].result;
  const merged: Review | undefined =
    done.length > 0 ? { ...done[0].review, findings: mergeFindings(done.map((p) => p.review.findings)) } : passes[0].review;
  // Consolidate: drop repeats inside the merged review before anything else sees it.
  let consolidated = merged ? consolidateFindings(merged.findings) : undefined;
  if (consolidated && opts.dedupe === true) {
    const deduped = await dedupeFindings(opts, consolidated.kept, run);
    consolidated = { kept: deduped.kept, dropped: [...consolidated.dropped, ...deduped.dropped] };
  }
  const draft: Review | undefined = merged && consolidated ? { ...merged, findings: consolidated.kept } : merged;
  const stages = { ...(context ? { context } : {}), ...(consolidated ? { consolidation: consolidated.dropped } : {}) };
  if (reviewRun.outcome !== "completed" || draft === undefined) {
    return {
      outcome: reviewRun.outcome === "completed" ? "no_review" : reviewRun.outcome,
      ...(reviewRun.error !== undefined ? { error: reviewRun.error } : {}),
      ...(draft !== undefined ? { draft, review: draft } : {}),
      verdicts: [],
      ...stages,
    };
  }
  // `draft` stays whole, so a run can score what the threshold cost.
  const gate = (f: Finding): boolean => confidentEnough(f, opts.minConfidence);
  if (opts.verify !== true || draft.findings.length === 0) {
    return { outcome: "completed", review: { ...draft, findings: draft.findings.filter(gate) }, draft, verdicts: [], ...stages };
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
  return { outcome: "completed", review: { ...draft, findings: kept }, draft, verdicts: verdicts.filter((v): v is FindingVerdict => v !== undefined), ...stages };
}

/**
 * The dedupe stage: one agent compares the findings that sit close together
 * and names those that report one defect. No close findings: no agent. A
 * failed agent or no answer keeps every finding.
 */
async function dedupeFindings(opts: PipelineOptions, findings: Finding[], run: AgentRunner): Promise<Consolidation> {
  const clusters = duplicateCandidates(findings);
  if (clusters.length === 0) return { kept: findings, dropped: [] };
  const excerpts = await Promise.all(
    clusters.map(async (cluster) => {
      const f = findings[cluster[0]];
      const text = f.side === "LEFT" ? await gitFileAt(opts.workspace, opts.base, f.path) : await readFile(join(opts.workspace, f.path), "utf8").catch(() => undefined);
      return clusterExcerpt(text, findings, cluster);
    }),
  );
  const spec = createDedupeSpec({ title: opts.title, findings, clusters, excerpts, ...(opts.dedupeModel !== undefined ? { model: opts.dedupeModel } : {}) });
  const result = await run(spec);
  return applyDuplicateGroups(findings, clusters, result.outcome === "completed" ? spec.answer() : undefined);
}

async function mergeBase(workspace: string, base: string, head: string): Promise<string> {
  const sha = (await git(workspace, ["merge-base", base, head])).trim();
  if (!sha) throw new Error(`No merge-base between ${base} and ${head}. Fetch both commits with their history.`);
  return sha;
}
