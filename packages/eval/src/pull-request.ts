/**
 * `pull_request` cases: check out a PR's head commit and run the
 * `@valet/plugin-pr-review` reviewer over it in a local sandbox.
 *
 * Repos are cached as blobless bare clones under
 * `VALET_EVAL_REPO_CACHE` (default `~/.cache/valet-eval/repos`), one per
 * `pull_request.repo`. Each remote that holds a case's commits becomes a
 * promisor remote, so a worktree checkout downloads only the blobs it reads.
 *
 * The local sandbox has no isolation: the reviewer's `bash` runs on this
 * machine with the harness environment. Run code-review cases only on
 * repos you trust to be read, such as the public benchmark forks.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  Engine,
  InMemoryBlobStore,
  InMemoryCredentialStore,
  InMemoryEventStream,
  InMemorySessionStore,
  TimeoutError,
  builtinTools,
  resolveModelId,
  type Model,
} from "@valet/engine";
import { runReviewPipeline, type AgentRunResult, type AgentRunner } from "@valet/plugin-pr-review";
import { LocalSandboxProvider } from "@valet/sandbox-local";
import { gatewayModelResolver, viaGateway } from "./gateway.js";
import { extractTrajectory } from "./trajectory.js";
import type { CaseOutcome, CaseRunResult, RunnerOptions } from "./runner.js";
import type { EvalCase, PullRequestSpec, Trajectory } from "./types.js";

const run = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
/** Baselines are tracked in git; keep each recorded tool result short. */
const BASELINE_RESULT_CHARS = 2_000;

export function repoCacheDir(): string {
  return process.env.VALET_EVAL_REPO_CACHE ?? join(homedir(), ".cache", "valet-eval", "repos");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

/** Worktree add/remove and fetches on one bare repo race on its metadata; serialize them. */
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const next = (repoLocks.get(repo) ?? Promise.resolve()).catch(() => undefined).then(fn);
  repoLocks.set(repo, next);
  return next;
}

async function hasCommit(repo: string, sha: string): Promise<boolean> {
  try {
    return (await git(repo, ["cat-file", "-t", sha])).trim() === "commit";
  } catch {
    return false;
  }
}

/** Make sure the cached bare repo has both commits, fetching them if needed. */
async function ensureCommits(spec: PullRequestSpec): Promise<string> {
  const repo = join(repoCacheDir(), `${spec.repo}.git`);
  const remote = `r-${createHash("sha1").update(spec.remote).digest("hex").slice(0, 12)}`;
  await withRepoLock(repo, async () => {
    if (!existsSync(repo)) {
      await mkdir(repoCacheDir(), { recursive: true });
      await git(repoCacheDir(), ["init", "--quiet", "--bare", repo]);
      await git(repo, ["config", "core.repositoryformatversion", "1"]);
      await git(repo, ["config", "extensions.partialClone", remote]);
    }
    const remotes = (await git(repo, ["remote"])).split("\n");
    if (!remotes.includes(remote)) {
      await git(repo, ["remote", "add", remote, spec.remote]);
      await git(repo, ["config", `remote.${remote}.promisor`, "true"]);
      await git(repo, ["config", `remote.${remote}.partialclonefilter`, "blob:none"]);
    }
    if ((await hasCommit(repo, spec.base)) && (await hasCommit(repo, spec.head))) return;
    await git(repo, ["fetch", "--quiet", "--filter=blob:none", remote, spec.base, spec.head]);
  });
  return repo;
}

/** Run one `pull_request` case. Called by `runCase`. */
export async function runPullRequestCase(evalCase: EvalCase, opts: RunnerOptions): Promise<CaseRunResult> {
  const spec = evalCase.pull_request;
  if (spec === undefined) throw new Error(`case ${evalCase.id} has no pull_request`);
  const modelSpec =
    evalCase.model ?? (typeof opts.model === "string" ? opts.model : `${opts.model.provider}/${opts.model.id}`);
  const model = typeof opts.model !== "string" && evalCase.model === undefined ? opts.model : resolveModelId(modelSpec);
  if (!model) throw new Error(`unknown model spec \`${modelSpec}\`. Use provider/model form, e.g. anthropic/claude-sonnet-5-5.`);

  const repo = await ensureCommits(spec);
  const workspace = await mkdtemp(join(tmpdir(), `valet-eval-${evalCase.id}-`));
  await rm(workspace, { recursive: true, force: true });
  await withRepoLock(repo, () => git(repo, ["worktree", "add", "--quiet", "--detach", workspace, spec.head]));
  try {
    return await reviewInWorkspace(evalCase, opts, spec, workspace, model, modelSpec);
  } finally {
    await withRepoLock(repo, () => git(repo, ["worktree", "remove", "--force", workspace])).catch(() => undefined);
  }
}

async function reviewInWorkspace(
  evalCase: EvalCase,
  opts: RunnerOptions,
  spec: PullRequestSpec,
  workspace: string,
  model: Model<string>,
  modelSpec: string,
): Promise<CaseRunResult> {
  const timeoutMs = evalCase.timeout_ms ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  const store = new InMemorySessionStore();
  const engine = new Engine({
    providers: {
      store,
      stream: new InMemoryEventStream(),
      blobs: new InMemoryBlobStore(),
      credentials: new InMemoryCredentialStore(),
      sandboxProvider: new LocalSandboxProvider(),
    },
  });
  const reasoning = evalCase.reasoning ?? opts.reasoning;

  // One trajectory per agent: the reviewer's becomes the case trajectory,
  // each verifier's a child, so cost and tool calls roll up.
  const agentTrajectories: { label: string; trajectory: Trajectory }[] = [];
  const runAgent: AgentRunner = async (agent) => {
    const agentStarted = Date.now();
    const agentModel = agent.model !== undefined ? resolveModelId(agent.model) : model;
    if (!agentModel) throw new Error(`unknown model spec \`${agent.model}\`. Use provider/model form, e.g. openai/gpt-5.6-terra.`);
    const session = await engine.createSession({
      userId: "eval-user",
      orgId: "eval-org",
      workspace,
      sandbox: { workspace },
      model: opts.gateway !== undefined ? viaGateway(agentModel, opts.gateway) : agentModel,
      modelSpec: agent.model ?? modelSpec,
      ...(opts.gateway !== undefined ? { resolveModel: gatewayModelResolver(opts.gateway) } : {}),
      systemPrompt: agent.systemPrompt,
      builtinTools: builtinTools.filter((t) => agent.builtinToolNames.has(t.name)),
      tools: agent.tools,
      warmSandboxOnClaim: false,
      ...(reasoning !== undefined ? { sampling: { reasoning } } : {}),
      turnRetry: { maxAttempts: 1 },
    });
    const thread = session.thread();
    let result: AgentRunResult = { outcome: "completed" };
    try {
      const receipt = await session.prompt(agent.prompt);
      const settled = await thread.awaitResult(receipt.queueItemId, { timeoutMs: Math.max(1, deadline - Date.now()) });
      if (settled.outcome === "failed" || settled.outcome === "aborted") {
        result = { outcome: "failed", error: settled.error ?? `submission ${settled.outcome}` };
      }
    } catch (err) {
      if (!(err instanceof TimeoutError)) throw err;
      result = { outcome: "timeout", error: `case timed out after ${timeoutMs}ms` };
    }
    const entries = await store.getEntries(session.id, thread.id);
    await session.destroy().catch(() => undefined);
    agentTrajectories.push({
      label: agent.label,
      trajectory: compactForBaseline(
        extractTrajectory({
          caseId: `${evalCase.id}#${agent.label}`,
          prompt: agent.label.startsWith("review") ? reviewPrompt(spec) : `Verify finding ${agent.label}`,
          model: agent.model ?? modelSpec,
          durationMs: Date.now() - agentStarted,
          entries,
        }),
      ),
    });
    return result;
  };

  const verify = opts.verify ?? evalCase.pull_request?.verify ?? false;
  const pipeline = await runReviewPipeline(
    {
      workspace,
      base: spec.base,
      head: spec.head,
      title: spec.title,
      body: spec.body ?? "",
      verify,
      ...(opts.verifyModel !== undefined ? { verifyModel: opts.verifyModel } : {}),
      ...(opts.reviewPasses !== undefined ? { passes: opts.reviewPasses } : {}),
      ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
    },
    runAgent,
  );
  const main = agentTrajectories.find((a) => a.label === "review")?.trajectory;
  if (main === undefined) throw new Error(`case ${evalCase.id}: the reviewer agent did not run`);
  const trajectory: Trajectory = {
    ...main,
    caseId: evalCase.id,
    durationMs: Date.now() - startedAt,
    children: agentTrajectories.filter((a) => a.label !== "review").map((a) => a.trajectory),
    metadata: {
      ...(pipeline.review !== undefined ? { review: pipeline.review } : {}),
      ...(pipeline.draft !== undefined ? { draft: pipeline.draft } : {}),
      ...(pipeline.verdicts.length > 0 ? { verdicts: pipeline.verdicts } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    },
  };
  const outcome: CaseOutcome =
    pipeline.outcome === "timeout" ? "timeout" : pipeline.outcome === "failed" ? "failed" : "completed";
  return { trajectory, outcome, ...(pipeline.error !== undefined ? { error: pipeline.error } : {}) };
}

function reviewPrompt(spec: PullRequestSpec): string {
  return `Review pull request: ${spec.title} (${spec.base.slice(0, 12)}..${spec.head.slice(0, 12)})`;
}

/**
 * The review prompt carries the whole diff and tool results carry source
 * files. Trim both so a saved baseline stays small; the review itself is
 * kept whole in metadata.
 */
function compactForBaseline(t: Trajectory): Trajectory {
  return {
    ...t,
    ...(t.userTurns !== undefined ? { userTurns: t.userTurns.map((u) => ({ ...u, content: t.prompt })) } : {}),
    toolCalls: t.toolCalls.map((c) => {
      const text = typeof c.result === "string" ? c.result : JSON.stringify(c.result ?? "");
      return text.length > BASELINE_RESULT_CHARS ? { ...c, result: `${text.slice(0, BASELINE_RESULT_CHARS)}… (+${text.length - BASELINE_RESULT_CHARS} chars)` } : c;
    }),
  };
}
