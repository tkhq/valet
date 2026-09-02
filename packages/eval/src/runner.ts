/**
 * Eval runner (TKAI-329): drive one `EvalCase` through a real in-process
 * engine and return the extracted `Trajectory`.
 *
 * The engine is built per case with in-memory providers — no API server, no
 * HTTP, no Docker. LLM calls are real: the resolved model reads
 * `ANTHROPIC_API_KEY` (or the matching provider env var) through pi-ai's
 * env fallback. Tests use the pi-ai faux provider instead.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  InMemoryBlobStore,
  InMemoryCredentialStore,
  InMemoryEventStream,
  InMemorySessionStore,
  TimeoutError,
  VirtualSandboxProvider,
  builtinTools,
  resolveModelId,
  type ChildSpawner,
  type Model,
  type Principal,
  type SandboxProvider,
  type Session,
  type SessionEntry,
  type ToolDef,
  type ValetPlugin,
} from "@valet/engine";
import { buildRealCatalogTools } from "./integration.js";
import { EvalMemoryStore, buildEvalMemoryTools } from "./memory-tools.js";
import { buildMockCatalogTools } from "./mock-catalog.js";
import { extractTrajectory, findSpawnCallId } from "./trajectory.js";
import type { EvalCase, ReasoningLevel, Trajectory, VerificationResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const EVAL_USER_ID = "eval-user";
const EVAL_ORG_ID = "eval-org";

/** Submission outcomes the runner reports. Mirrors the engine's settlement outcomes. */
export type CaseOutcome = "completed" | "failed" | "aborted" | "superseded" | "merged" | "timeout";

export interface RunnerOptions {
  /**
   * Default model for cases without a `model:` pin — a spec string resolved
   * through `resolveModelId`, or a live `Model` handle (tests pass the faux
   * provider's model here; faux models are not in the static catalog).
   */
  model: string | Model<string>;
  /** Default per-case timeout when the case sets no `timeout_ms`. */
  timeoutMs?: number;
  /**
   * Extra tools added to the session — the integration plugin catalog
   * (TKAI-336) plugs in here.
   */
  extraTools?: ToolDef[];
  /**
   * Real plugin manifests backing `profile: mock` cases (TKAI-335). The
   * CLI passes the api's bundled registry. Required when the case profile
   * is `mock`.
   */
  mockPlugins?: ValetPlugin[];
  /**
   * Real plugin manifests backing `profile: integration` and
   * `profile: full` cases (TKAI-336) — actions execute for real against
   * live services. Required for those profiles.
   */
  realPlugins?: ValetPlugin[];
  /**
   * Live credentials keyed by credential service (e.g. `github`), seeded
   * into the case engine's InMemoryCredentialStore for the eval user.
   */
  credentials?: Record<string, string>;
  /**
   * Sandbox provider override. The suite passes a DockerSandboxProvider
   * for `profile: full` cases. Default: VirtualSandboxProvider.
   */
  sandboxProvider?: SandboxProvider;
  /** Override the session system prompt. */
  systemPrompt?: string;
  /**
   * Suite-level reasoning effort for the model under test (a case's own
   * `reasoning:` wins). Threaded to pi-ai via the engine sampling seam.
   */
  reasoning?: ReasoningLevel;
}

/**
 * Model specs the static pi-ai catalog does not know yet, resolved by
 * cloning a same-family catalog model and overriding the wire id. Cost is
 * DROPPED unless independently confirmed: a borrowed price is a wrong
 * price, and the scorecard's "unpriced" reads honestly. Remove entries as
 * pi-ai catalog updates land.
 */
const EXTRA_MODELS: Record<string, { cloneOf: string; id: string }> = {
  // Live Anthropic id confirmed via GET /v1/models on 2026-09-02; absent
  // from pi-ai 0.84.2. Pricing unverified, so it runs unpriced.
  "anthropic/claude-fable-5-1": { cloneOf: "anthropic/claude-fable-5", id: "claude-fable-5-1" },
};

/** Resolve a spec through the catalog, then the extra-models table. */
export function resolveEvalModel(spec: string): Model<string> | undefined {
  const fromCatalog = resolveModelId(spec);
  if (fromCatalog) return fromCatalog;
  const extra = EXTRA_MODELS[spec];
  if (extra === undefined) return undefined;
  const base = resolveModelId(extra.cloneOf);
  if (!base) return undefined;
  const { cost: _droppedCost, ...rest } = base as Model<string> & { cost?: unknown };
  return { ...rest, id: extra.id } as Model<string>;
}

export interface CaseRunResult {
  trajectory: Trajectory;
  outcome: CaseOutcome;
  /** Settlement or timeout error, when the case did not complete. */
  error?: string;
}

const EVAL_PERSONA = [
  "You are Valet, a personal orchestrator agent under automated evaluation.",
  "Work the task with your tools. Spawn child sessions with `task` for",
  "substantial delegated work. Keep replies short and factual.",
].join(" ");

/**
 * Interpolate turn templates against the previous agent output.
 *
 * Supported form: `{{last_output_match(/pattern/)}}` — replaced with the
 * first capture group (or the whole match) of `pattern` applied to the
 * previous turn's output. Throws when there is no previous output or the
 * pattern does not match, so a broken case fails loudly.
 */
export function interpolateTurnContent(content: string, lastOutput: string | undefined): string {
  return content.replace(/\{\{\s*last_output_match\(\/(.+?)\/\)\s*\}\}/g, (_m, pattern: string) => {
    if (lastOutput === undefined) {
      throw new Error(
        `turn template uses last_output_match(/${pattern}/) but there is no previous agent output. ` +
          "Move the template off the first turn.",
      );
    }
    const match = lastOutput.match(new RegExp(pattern));
    if (!match) {
      throw new Error(
        `turn template last_output_match(/${pattern}/) did not match the previous agent output:\n${lastOutput}`,
      );
    }
    return match[1] ?? match[0];
  });
}

interface SpawnedChild {
  session: Session;
  queueItemId: string;
  prompt: string;
  /** Set once the child settles and its child.settled signal is delivered. */
  signaled: boolean;
  /** Wall-clock spawn time; with settledAt it bounds the child's duration. */
  spawnedAt: number;
  /** Set when the child's submission settles. */
  settledAt?: number;
}

/** Filter the session toolset to an eval case's `tools:` pin. */
function restrictTools(all: ToolDef[], pins: string[] | undefined, caseId: string): ToolDef[] {
  if (pins === undefined) return all;
  const known = new Set(all.map((t) => t.name));
  const missing = pins.filter((p) => !known.has(p));
  if (missing.length > 0) {
    throw new Error(
      `case ${caseId} pins unknown tools: ${missing.join(", ")}. Available: ${[...known].sort().join(", ")}`,
    );
  }
  const allowed = new Set(pins);
  return all.filter((t) => allowed.has(t.name));
}

/** Run one eval case through the engine and extract its trajectory. */
export async function runCase(evalCase: EvalCase, opts: RunnerOptions): Promise<CaseRunResult> {
  // The Docker sandbox drives readiness and job eviction with unref'd
  // timers; in provisioning gaps they can be the ONLY pending work, and
  // node then exits mid-case with the run unresolved. Hold one live handle
  // for the duration of the case.
  const keepalive = setInterval(() => {}, 60_000);
  try {
    return await runCaseInner(evalCase, opts);
  } finally {
    clearInterval(keepalive);
  }
}

async function runCaseInner(evalCase: EvalCase, opts: RunnerOptions): Promise<CaseRunResult> {
  let model: Model<string>;
  let modelSpec: string;
  if (evalCase.model === undefined && typeof opts.model !== "string") {
    model = opts.model;
    modelSpec = `${opts.model.provider}/${opts.model.id}`;
  } else {
    modelSpec =
      evalCase.model ??
      (typeof opts.model === "string" ? opts.model : `${opts.model.provider}/${opts.model.id}`);
    const resolved = resolveEvalModel(modelSpec);
    if (!resolved) {
      throw new Error(
        `unknown model spec \`${modelSpec}\`. Use provider/model form, e.g. anthropic/claude-haiku-4-5.`,
      );
    }
    model = resolved;
  }

  const timeoutMs = evalCase.timeout_ms ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - Date.now());

  const store = new InMemorySessionStore();
  const credentialStore = new InMemoryCredentialStore();
  const engine = new Engine({
    providers: {
      store,
      stream: new InMemoryEventStream(),
      blobs: new InMemoryBlobStore(),
      credentials: credentialStore,
      sandboxProvider: opts.sandboxProvider ?? new VirtualSandboxProvider(),
    },
  });

  const owner: Principal = { type: "user", id: EVAL_USER_ID };
  const isOrchestrator = evalCase.session_type === "orchestrator";
  const memoryStore = new EvalMemoryStore();
  const profile = evalCase.profile ?? "unit";
  let catalogTools: ToolDef[] = [];
  if (profile === "mock") {
    if (opts.mockPlugins === undefined || opts.mockPlugins.length === 0) {
      throw new Error(
        `case ${evalCase.id} has profile: mock but the runner got no mockPlugins. ` +
          "Pass the bundled plugin registry in RunnerOptions.mockPlugins.",
      );
    }
    catalogTools = buildMockCatalogTools(evalCase.mock_tools ?? {}, opts.mockPlugins, evalCase.allowed_actions);
  } else if (profile === "integration" || profile === "full") {
    if (opts.realPlugins === undefined || opts.realPlugins.length === 0) {
      throw new Error(
        `case ${evalCase.id} has profile: ${profile} but the runner got no realPlugins. ` +
          "Pass the bundled plugin registry in RunnerOptions.realPlugins.",
      );
    }
    catalogTools = buildRealCatalogTools(opts.realPlugins, profile, evalCase.allowed_actions);
    for (const [service, token] of Object.entries(opts.credentials ?? {})) {
      await credentialStore.save({ type: "user", id: EVAL_USER_ID }, service, {
        type: "api_key",
        accessToken: token,
      });
    }
  }
  const customTools = [
    ...buildEvalMemoryTools(memoryStore),
    ...catalogTools,
    ...(opts.extraTools ?? []),
  ];

  const children: SpawnedChild[] = [];
  const childSpawner: ChildSpawner = async (req, ctx) => {
    const childModel = req.model !== undefined ? resolveEvalModel(req.model) : model;
    if (!childModel) throw new Error(`task: unknown model \`${req.model}\``);
    const child = await engine.createSession({
      userId: ctx.actorUserId,
      orgId: EVAL_ORG_ID,
      workspace: "/workspace",
      purpose: "child",
      parentSessionId: ctx.parentSessionId,
      parentThreadId: ctx.parentThreadId,
      sandbox: {},
      model: childModel,
      owner: ctx.owner,
    });
    const receipt = await child.prompt(req.prompt);
    children.push({
      session: child,
      queueItemId: receipt.queueItemId,
      prompt: req.prompt,
      signaled: false,
      spawnedAt: Date.now(),
    });
    return { childSessionId: child.id, queueItemId: receipt.queueItemId };
  };

  // Restriction applies across builtins and custom tools alike; the engine
  // assembles `session.builtinTools + options.tools`.
  const allTools = [...builtinTools, ...customTools];
  const restricted = evalCase.tools !== undefined ? restrictTools(allTools, evalCase.tools, evalCase.id) : allTools;
  const builtinNames = new Set(builtinTools.map((t) => t.name));

  // A non-virtual provider (profile: full's Docker sandbox) bind-mounts a
  // host workspace directory; give each case a scratch one.
  const sandboxOpts =
    opts.sandboxProvider !== undefined
      ? { workspace: await mkdtemp(join(tmpdir(), `valet-eval-${evalCase.id}-`)) }
      : {};

  const session = await engine.createSession({
    userId: EVAL_USER_ID,
    orgId: EVAL_ORG_ID,
    workspace: "/workspace",
    purpose: isOrchestrator ? "orchestrator" : "interactive",
    sandbox: sandboxOpts,
    model,
    modelSpec,
    owner,
    builtinTools: restricted.filter((t) => builtinNames.has(t.name)),
    tools: restricted.filter((t) => !builtinNames.has(t.name)),
    warmSandboxOnClaim: false,
    ...(evalCase.temperature !== undefined || evalCase.reasoning !== undefined || opts.reasoning !== undefined
      ? {
          sampling: {
            ...(evalCase.temperature !== undefined ? { temperature: evalCase.temperature } : {}),
            ...((evalCase.reasoning ?? opts.reasoning) !== undefined
              ? { reasoning: evalCase.reasoning ?? opts.reasoning }
              : {}),
          },
        }
      : {}),
    systemPrompt: opts.systemPrompt ?? (isOrchestrator ? EVAL_PERSONA : undefined),
    ...(isOrchestrator ? { toolConfig: { childSpawner } } : {}),
    // Evals are unattended, but retries would blur cost/duration numbers —
    // measure the single attempt.
    turnRetry: { maxAttempts: 1 },
  });
  const thread = session.thread();

  let outcome: CaseOutcome = "completed";
  let error: string | undefined;
  let lastOutput: string | undefined;

  const awaitSubmission = async (queueItemId: string): Promise<boolean> => {
    try {
      const result = await thread.awaitResult(queueItemId, { timeoutMs: remaining() });
      lastOutput = result.text ?? lastOutput;
      if (result.outcome === "failed" || result.outcome === "aborted") {
        outcome = result.outcome;
        error = result.error ?? `submission ${result.outcome}`;
        return false;
      }
      return true;
    } catch (err) {
      if (err instanceof TimeoutError) {
        outcome = "timeout";
        error = `case timed out after ${timeoutMs}ms`;
        return false;
      }
      throw err;
    }
  };

  // Deliver settled children back to the parent as child.settled signals,
  // mirroring the api's ChildWatcher (packages/api/src/orchestrator/children.ts)
  // minus the durable re-arm — an eval run lives and dies in this process.
  const drainChildren = async (): Promise<boolean> => {
    for (;;) {
      const next = children.find((c) => !c.signaled);
      if (!next) return true;
      next.signaled = true;
      let body: string;
      let childOutcome: string;
      try {
        const res = await next.session.thread().awaitResult(next.queueItemId, { timeoutMs: remaining() });
        next.settledAt = Date.now();
        childOutcome = res.outcome;
        body =
          res.outcome === "failed" || res.outcome === "aborted"
            ? (res.error ?? res.text ?? `child submission ${res.outcome}`)
            : (res.text ?? "");
      } catch (err) {
        if (err instanceof TimeoutError) {
          outcome = "timeout";
          error = `case timed out after ${timeoutMs}ms waiting for child ${next.session.id}`;
          return false;
        }
        throw err;
      }
      const receipt = await session.prompt(
        {
          kind: "signal",
          signalType: "child.settled",
          body,
          attributes: { child_session_id: next.session.id, outcome: childOutcome },
          tagName: "child_settled",
        },
        {
          dispatchId: `settled:${next.session.id}:${next.queueItemId}`,
          internalSender: { sessionId: next.session.id, owner },
        },
      );
      if (!(await awaitSubmission(receipt.queueItemId))) return false;
    }
  };

  for (const [i, turn] of evalCase.turns.entries()) {
    let content: string;
    try {
      content = interpolateTurnContent(turn.content, lastOutput);
    } catch (err) {
      outcome = "failed";
      error = `turn ${i + 1}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    const receipt = await session.prompt(content);
    if (!(await awaitSubmission(receipt.queueItemId))) break;
    if (!(await drainChildren())) break;
  }

  const durationMs = Date.now() - startedAt;
  const entries = await store.getEntries(session.id, thread.id);

  const childTrajectories: Trajectory[] = [];
  for (const [i, child] of children.entries()) {
    const childEntries = await store.getEntries(child.session.id, child.session.thread().id);
    const t = extractTrajectory({
      caseId: `${evalCase.id}#child-${i}`,
      prompt: child.prompt,
      model: modelSpec,
      // Spawn-to-settle wall time. Children run concurrently with the
      // parent, so these durations overlap and must not be summed.
      durationMs: (child.settledAt ?? Date.now()) - child.spawnedAt,
      entries: childEntries,
    });
    const spawnCall = findSpawnCallId(entries, child.session.id);
    if (spawnCall !== undefined) t.spawnedByCallId = spawnCall;
    childTrajectories.push(t);
  }

  const effectiveReasoning = evalCase.reasoning ?? opts.reasoning;
  const trajectory = extractTrajectory({
    caseId: evalCase.id,
    prompt: evalCase.turns[0].content,
    model: modelSpec,
    durationMs,
    entries,
    children: childTrajectories,
    // Reasoning effort is part of the run's identity for comparisons: the
    // same model at different efforts is a different cost/quality point.
    ...(effectiveReasoning !== undefined ? { metadata: { reasoning: effectiveReasoning } } : {}),
  });

  // Harness-run verifications (builder cases): execute each verify_command
  // in the sandbox the agent just built in, BEFORE teardown. These run
  // outside the agent loop against the produced codebase, so the agent
  // cannot fake them. Run even after a failed/timed-out case — the check
  // details then show what state the build actually reached.
  const verifyChecks = evalCase.checks.filter((c) => c.type === "verify_command");
  if (verifyChecks.length > 0) {
    const verifications: VerificationResult[] = [];
    for (const check of verifyChecks) {
      try {
        // No cwd override: every provider defaults exec to its own
        // workspace root (the same default the bash tool gets).
        const result = await session.sandbox.exec(check.command, {
          timeout: (check.timeout_s ?? 120) * 1000,
        });
        verifications.push({
          command: check.command,
          exitCode: result.exitCode,
          output: [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n"),
          ...(result.timedOut === true ? { timedOut: true } : {}),
        });
      } catch (err) {
        verifications.push({
          command: check.command,
          exitCode: -1,
          output: `verification exec failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    trajectory.verifications = verifications;
  }

  // A real sandbox (Docker) holds a container; tear it down now that the
  // entries are extracted. Virtual sandboxes make this a cheap no-op.
  if (opts.sandboxProvider !== undefined) {
    for (const s of [session, ...children.map((c) => c.session)]) {
      try {
        await s.attachment.destroy();
      } catch (err) {
        console.error(`[eval] sandbox teardown failed for ${s.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return { trajectory, outcome, ...(error !== undefined ? { error } : {}) };
}

