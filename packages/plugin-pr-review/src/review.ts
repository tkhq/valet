import {
  builtinTools,
  Engine,
  InMemoryBlobStore,
  InMemoryCredentialStore,
  InMemoryEventStream,
  InMemorySessionStore,
  resolveModelId,
  type Model,
  type ReasoningLevel,
  type SessionEntry,
  type ToolDef,
} from "@valet/engine";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalSandboxProvider } from "@valet/sandbox-local";
import { Value } from "typebox/value";
import { reviewerBashTool } from "./bash.js";
import { diffPullRequest, git } from "./git.js";
import { runReviewPipeline, type AgentRunner, type AgentRunResult, type AgentSpec } from "./pipeline.js";
import { buildReviewPrompt, REVIEWER_SYSTEM_PROMPT } from "./prompt.js";
import { ReviewSchema, type Finding, type Review, type ReviewRun, type ReviewUsage } from "./types.js";

/** Built-in tools the reviewer keeps. Everything that writes or delegates is dropped; bash is the reviewer's own. */
const REVIEWER_BUILTINS = new Set(["read"]);

export interface ReviewPullRequestOptions {
  /** Absolute path of a checkout at `head`. */
  workspace: string;
  base: string;
  head: string;
  title: string;
  body: string;
  /** provider/model, e.g. anthropic/claude-sonnet-5-5. */
  model: string;
  reasoning?: ReasoningLevel;
  timeoutMs?: number;
  diffBudgetChars?: number;
  /** Called for each tool call, for progress logs. */
  onToolCall?: (tool: string, args: unknown) => void;
  /** Check each finding with a verifier agent. Default false. */
  verify?: boolean;
  /** provider/model for the verifiers. Unset: `model`. */
  verifyModel?: string;
  /** Send every model call through this Valet gateway with its key. */
  gateway?: LlmGatewayConfig;
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_DIFF_BUDGET = 150_000;

export async function reviewPullRequest(opts: ReviewPullRequestOptions): Promise<ReviewRun> {
  // Sandbox and engine timers are unref'd; in a gap between model calls they
  // can be the only pending work, and node would exit with the review open.
  const keepalive = setInterval(() => {}, 60_000);
  try {
    return await runReview(opts);
  } finally {
    clearInterval(keepalive);
  }
}

/**
 * Everything a host needs to run the reviewer in its own engine session:
 * the system prompt, the tools, and the first prompt (diff included). The
 * eval runner builds its session from this, so the benchmark measures the
 * same reviewer that `reviewPullRequest` runs.
 */
export interface ReviewerSpec extends AgentSpec {
  /** The review the agent submitted, once it calls `submit_review`. */
  review(): Review | undefined;
}

export interface ReviewerSpecOptions {
  /** Absolute path of a checkout at `head`. */
  workspace: string;
  base: string;
  head: string;
  title: string;
  body: string;
  diffBudgetChars?: number;
  /** Follow-up review: show only the changes since this commit, in the PR's files. */
  incrementFrom?: string;
  /** Findings already posted and still open, so the reviewer does not repeat them. */
  knownFindings?: { path: string; line: number; title: string }[];
  /** The gather stage's context pack, put in the first prompt. */
  contextPack?: string;
}

/** Lines in a file's text; a trailing newline does not start another line. */
export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/**
 * Findings whose anchor cannot exist: a path the PR does not add or change
 * at HEAD, or a line past the end of the file. `lineCounts` maps each such
 * path to its line count at HEAD. A line outside the diff hunks is not a
 * problem: hosts post those findings outside the inline comments.
 */
export function anchorProblems(
  findings: Finding[],
  lineCounts: ReadonlyMap<string, number>,
  /**
   * Line counts in the base file, for findings on deleted code (side LEFT).
   * Unset: LEFT findings are checked against `lineCounts`, for a caller that
   * splits findings by side and passes base counts for the LEFT ones.
   */
  baseLineCounts?: ReadonlyMap<string, number>,
): { index: number; problem: string }[] {
  const problems: { index: number; problem: string }[] = [];
  findings.forEach((f, index) => {
    if (f.side === "LEFT") {
      const n = (baseLineCounts ?? lineCounts).get(f.path);
      if (n === undefined) {
        problems.push({ index, problem: `${f.path} does not exist in the base commit, so a LEFT finding cannot anchor there. Use side RIGHT with a HEAD line.` });
      } else if (f.line > n) {
        problems.push({ index, problem: `${f.path} has ${n} lines in the base commit, so LEFT line ${f.line} does not exist. Give the deleted line's number in the base file.` });
      }
      return;
    }
    const n = lineCounts.get(f.path);
    if (n === undefined) {
      problems.push({ index, problem: `${f.path} is not a file this PR adds or changes at HEAD. Anchor the finding to a line of a changed file.` });
    } else if (f.line > n) {
      problems.push({ index, problem: `${f.path} has ${n} lines at HEAD, so line ${f.line} does not exist. Read the file and give the line of the faulty code.` });
    }
  });
  return problems;
}

/**
 * Line count at `commit` of each path that exists there; an absent file is
 * left out. A submodule counts as one line: its diff shows one
 * "Subproject commit" line. With `checkedOut`, blobs are read from the
 * working tree, which is at `commit`; otherwise from git.
 */
async function treeLineCounts(workspace: string, commit: string, paths: string[], checkedOut: boolean): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (paths.length === 0) return counts;
  const tree = await git(workspace, ["ls-tree", "-z", commit, "--", ...paths]).catch(() => "");
  for (const entry of tree.split("\0").filter(Boolean)) {
    // "<mode> <type> <sha>\t<path>"
    const tab = entry.indexOf("\t");
    const type = entry.slice(0, tab).split(" ")[1];
    const path = entry.slice(tab + 1);
    if (type === "commit") counts.set(path, 1);
    else if (type === "blob") {
      const text = checkedOut
        ? await readFile(join(workspace, path), "utf8").catch(() => undefined)
        : await git(workspace, ["show", `${commit}:${path}`]).catch(() => undefined);
      if (text !== undefined) counts.set(path, lineCount(text));
    }
  }
  return counts;
}

/** A `path:line` reference, e.g. `pkg/a.go:42` or `a.py:3-9`. */
const CODE_REF = /[\w./-]+\.\w+:\d+/;

/**
 * Findings the reviewer cannot back: no concrete trigger, or evidence with
 * no `path:line` reference to code it read. A claim without both is
 * speculation, and speculation is the main source of false positives.
 */
export function evidenceProblems(findings: Finding[]): { index: number; problem: string }[] {
  const problems: { index: number; problem: string }[] = [];
  findings.forEach((f, index) => {
    if ((f.trigger ?? "").trim().length === 0) {
      problems.push({ index, problem: "trigger is empty. Name the input or state that makes the code fail, or drop the finding." });
    } else if (!CODE_REF.test(f.evidence ?? "")) {
      problems.push({ index, problem: "evidence has no path:line reference. Cite the code you read that shows the failure, or drop the finding." });
    }
  });
  return problems;
}

/** Times submit_review refuses unanchored or unsupported findings before it drops them instead. */
const ANCHOR_REFUSALS = 2;

export async function createReviewerSpec(opts: ReviewerSpecOptions): Promise<ReviewerSpec> {
  const budget = opts.diffBudgetChars ?? DEFAULT_DIFF_BUDGET;
  let diff = await diffPullRequest(opts.workspace, opts.base, opts.head, budget);
  // A follow-up review may still anchor to any file of the PR.
  const prFiles = diff.files;
  if (opts.incrementFrom !== undefined) {
    // Only the PR's own files: a merge of the base branch into the PR is not new PR code.
    diff = await diffPullRequest(opts.workspace, opts.incrementFrom, opts.head, budget, diff.files);
  }
  const lineCounts = await treeLineCounts(opts.workspace, opts.head, prFiles, true);
  const baseLineCounts = await treeLineCounts(opts.workspace, opts.base, prFiles, false);
  let refusals = 0;
  let submitted: Review | undefined;
  const submitReview: ToolDef<typeof ReviewSchema> = {
    name: "submit_review",
    description: "Submit the finished review. Call exactly once, at the end.",
    parameters: ReviewSchema,
    sideEffect: "none",
    execute: async (args) => {
      if (!Value.Check(ReviewSchema, args)) {
        const first = [...Value.Errors(ReviewSchema, args)].slice(0, 3);
        return { text: `Review rejected: ${first.map((e) => `${e.instancePath} ${e.message}`).join("; ")}. Fix and call again.` };
      }
      const problems = [...anchorProblems(args.findings, lineCounts, baseLineCounts), ...evidenceProblems(args.findings)];
      if (problems.length > 0 && refusals < ANCHOR_REFUSALS) {
        refusals++;
        return {
          text: `Review rejected: ${problems.map((p) => `finding ${p.index + 1} (${args.findings[p.index].path}:${args.findings[p.index].line}): ${p.problem}`).join(" ")} Fix those findings and call submit_review again with every finding.`,
        };
      }
      const bad = new Set(problems.map((p) => p.index));
      submitted = { ...args, findings: args.findings.filter((_, i) => !bad.has(i)) };
      return { text: bad.size > 0 ? `Review recorded without ${bad.size} finding(s) that had no valid line, trigger or evidence. Stop now.` : "Review recorded. Stop now." };
    },
  };
  return {
    label: "review",
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    builtinToolNames: REVIEWER_BUILTINS,
    tools: [reviewerBashTool(opts.workspace), submitReview],
    prompt: buildReviewPrompt({
      title: opts.title,
      body: opts.body,
      base: opts.base,
      head: opts.head,
      diff,
      ...(opts.incrementFrom !== undefined ? { increment: { from: opts.incrementFrom } } : {}),
      ...(opts.knownFindings !== undefined ? { knownFindings: opts.knownFindings } : {}),
      ...(opts.contextPack !== undefined ? { contextPack: opts.contextPack } : {}),
    }),
    review: () => submitted,
  };
}

/** A Valet LLM gateway: `url` is the Valet host, `apiKey` a `vlt_` key. */
export interface LlmGatewayConfig {
  url: string;
  apiKey: string;
}

export interface LocalAgentRunnerOptions {
  workspace: string;
  /** provider/model, e.g. anthropic/claude-sonnet-5-5. */
  model: string;
  reasoning?: ReasoningLevel;
  timeoutMs?: number;
  /** Send every model call through this Valet gateway with its key. */
  gateway?: LlmGatewayConfig;
  onToolCall?: (tool: string, args: unknown) => void;
}

/**
 * An `AgentRunner` on an in-process engine and a local sandbox over
 * `workspace`. `entries` collects every agent's transcript for cost tallies.
 */
export function createLocalAgentRunner(opts: LocalAgentRunnerOptions): { run: AgentRunner; entries: SessionEntry[] } {
  const resolved = resolveModelId(opts.model);
  if (!resolved) throw new Error(`Unknown model "${opts.model}". Use provider/model, e.g. anthropic/claude-sonnet-5-5.`);
  const gateway = opts.gateway;
  const viaGateway = (m: Model<string>): Model<string> => {
    if (gateway === undefined) return m;
    if (m.provider === "anthropic") return { ...m, baseUrl: `${gateway.url}/proxy/anthropic` };
    if (m.provider === "openai") return { ...m, baseUrl: `${gateway.url}/proxy/openai/v1` };
    throw new Error(`The Valet gateway has no route for provider ${m.provider}. Use an anthropic or openai model.`);
  };
  const resolveSpecModel = (spec: string): Model<string> => {
    const m = resolveModelId(spec);
    if (!m) throw new Error(`Unknown model "${spec}". Use provider/model, e.g. anthropic/claude-sonnet-5-5.`);
    return viaGateway(m);
  };
  const model = viaGateway(resolved);

  const store = new InMemorySessionStore();
  const stream = new InMemoryEventStream();
  const engine = new Engine({
    providers: {
      store,
      stream,
      blobs: new InMemoryBlobStore(),
      credentials: new InMemoryCredentialStore(),
      sandboxProvider: new LocalSandboxProvider(),
    },
  });
  if (opts.onToolCall) {
    const onToolCall = opts.onToolCall;
    stream.subscribe({}, (e) => {
      if (e.event.type === "tool_start") onToolCall(e.event.tool, e.event.args);
    });
  }

  const entries: SessionEntry[] = [];
  const run: AgentRunner = async (spec) => {
    const session = await engine.createSession({
      userId: "pr-review",
      orgId: "pr-review",
      workspace: opts.workspace,
      sandbox: { workspace: opts.workspace },
      model: spec.model !== undefined ? resolveSpecModel(spec.model) : model,
      modelSpec: spec.model ?? opts.model,
      ...(gateway !== undefined
        ? { resolveModel: async (s: string) => { const m = resolveModelId(s); return m ? { model: viaGateway(m), apiKey: gateway.apiKey } : null; } }
        : {}),
      systemPrompt: spec.systemPrompt,
      builtinTools: builtinTools.filter((t) => spec.builtinToolNames.has(t.name)),
      tools: spec.tools,
      warmSandboxOnClaim: false,
      ...(opts.reasoning !== undefined ? { sampling: { reasoning: opts.reasoning } } : {}),
      // A failed turn fails the review instead of running it again at full cost.
      turnRetry: { maxAttempts: 1 },
    });
    const thread = session.thread();
    let result: AgentRunResult = { outcome: "completed" };
    try {
      const receipt = await session.prompt(spec.prompt);
      const settled = await thread.awaitResult(receipt.queueItemId, { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
      if (settled.outcome === "failed" || settled.outcome === "aborted") {
        result = { outcome: "failed", error: settled.error ?? `submission ${settled.outcome}` };
      }
    } catch (err) {
      result = {
        outcome: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    entries.push(...(await store.getEntries(session.id, thread.id)));
    await session.destroy().catch(() => undefined);
    return result;
  };
  return { run, entries };
}

async function runReview(opts: ReviewPullRequestOptions): Promise<ReviewRun> {
  const startedAt = Date.now();
  const { run, entries } = createLocalAgentRunner(opts);
  const result = await runReviewPipeline(opts, run);
  return {
    ...(result.review ? { review: result.review } : {}),
    ...(result.draft ? { draft: result.draft } : {}),
    verdicts: result.verdicts,
    outcome: result.outcome,
    ...(result.error !== undefined ? { error: result.error } : {}),
    model: opts.model,
    durationMs: Date.now() - startedAt,
    ...tally(entries),
  };
}

export function tally(entries: SessionEntry[]): { toolCalls: number; usage: ReviewUsage } {
  const usage: ReviewUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  let toolCalls = 0;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.role !== "assistant") continue;
    toolCalls += (entry.parts ?? []).filter((p) => p.type === "tool_call").length;
    if (entry.usage) {
      usage.input += entry.usage.input;
      usage.output += entry.usage.output;
      usage.cacheRead += entry.usage.cacheRead;
      usage.cacheWrite += entry.usage.cacheWrite;
    }
    if (entry.cost) usage.costUsd += entry.cost.total;
  }
  return { toolCalls, usage };
}
