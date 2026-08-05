/**
 * `WorkflowEngineDeps` (Phase 5 plan decision 15) implemented over
 * `EngineHost`. Node executors and the interpreter only see this narrow
 * port — see `@valet/workflow`'s `packages/workflow/src/engine-deps.ts` for
 * the contract.
 *
 * ## Owner plumbing
 *
 * `WorkflowCreateSessionOptions` (fixed by `@valet/workflow`, already
 * consumed by the `session` node executor) carries only `{ id, title?,
 * purpose }` — no owner/orgId/actorUserId. Rather than widen that portable
 * interface (which would ripple into the already-shipped `session` node
 * executor and its tests), this builder resolves the missing context itself
 * by parsing the session id: every workflow session id is
 * `wf:{runId}:{nodeId}` (see `nodes/session.ts`), so `runId` is always
 * recoverable. From `runId` it loads the `WorkflowRun` row (for
 * `owner`/`params.workflowId`) and then the parent `workflow_definitions`
 * row (for `orgId` — `workflow_runs` doesn't carry its own `orgId` column,
 * decision 17). `actorUserId` has no natural value for a team/org-owned
 * run (there's no "acting user" — the run was started by a principal, not a
 * live user session), so it's synthesized as `owner.id` for a user owner or
 * `{ownerType}:{ownerId}` otherwise; `CreateSessionOptions.userId` is only
 * used by the engine for bookkeeping/defaults, never for auth, so this
 * placeholder is safe.
 *
 * Every method (not just `createSession`) re-resolves this context via
 * `EngineHost.workflowSessionFor`, which is itself idempotent (cache hit
 * after the first call in a given process). This makes `prompt`/
 * `awaitResult`/`abort` self-sufficient after a process restart, rather
 * than assuming the session `createSession` warmed is still cached.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import type { Api, Model, Usage } from "@mariozechner/pi-ai";
import {
  parseOrchestratorSessionId,
  parsePrincipal,
  type ActionPlugin,
  type CredentialStore,
  type Principal,
  type SessionStore,
  type SignalContent,
  type ValetPlugin,
} from "@valet/engine";
import type {
  WorkflowAwaitResultOptions,
  WorkflowCreateSessionOptions,
  WorkflowEngineDeps,
  WorkflowInvokeActionRequest,
  WorkflowInvokeActionResult,
  WorkflowLlmCompleteRequest,
  WorkflowLlmCompleteResult,
  WorkflowLlmUsage,
  WorkflowPromptOptions,
  WorkflowPromptOrchestratorOptions,
  WorkflowPromptOrchestratorResult,
  WorkflowPromptReceipt,
  WorkflowStore,
} from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import { buildActionInvoker, type ActionInvokerOpts } from "../plugins/action-invoker.js";
import { orchestratorIdentities, workflowDefinitions } from "../schema/index.js";

// Same compile-time-vs-runtime bridge `resolveModelId` solves in
// `packages/engine/src/thread.ts` and `EngineHost.resolveModel` (host.ts):
// pi-ai's `getModel` is typed against its literal MODELS table, but model
// ids here come from a workflow definition's `LlmNode.model` string at
// runtime. Not re-exported from `@valet/engine`, so duplicated here rather
// than widening that internal export for one caller.
type PiModel = Model<Api>;

export interface WorkflowEngineDepsOpts {
  host: EngineHost;
  store: WorkflowStore;
  db: AppDb;
  /** The engine's own session store — needed only for the non-blocking `isSettled` probe. */
  engineStore: SessionStore;
  /** Assembled plugin action index (plugin-system-v2 plan Task 4) — `invokeAction`'s action resolution seam. */
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
  /** Credential store `invokeAction` scopes a `CredentialProvider` over (Task 3). */
  credentials: CredentialStore;
  /** Threaded straight to `buildActionInvoker` (GH-T10) — lets the `github`
   * service resolve through `resolveGitHubToken` instead of a raw
   * credential-store read. Optional; omit in tests/deployments with no
   * github plugin registered. */
  githubTokenDeps?: ActionInvokerOpts["githubTokenDeps"];
}

function parseWorkflowSessionId(sessionId: string): { runId: string; nodeId: string } {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "wf") {
    throw new Error(`workflow engine-deps: not a workflow session id: ${sessionId}`);
  }
  return { runId: parts[1], nodeId: parts[2] };
}

interface RunContext {
  orgId: string;
  actorUserId: string;
  owner: Principal;
}

async function resolveRunContext(opts: WorkflowEngineDepsOpts, runId: string): Promise<RunContext> {
  const run = await opts.store.getRun(runId);
  if (!run) throw new Error(`workflow engine-deps: run not found: ${runId}`);
  if (!run.owner) throw new Error(`workflow engine-deps: run ${runId} has no recorded owner`);

  const defRows = await opts.db
    .select({ orgId: workflowDefinitions.orgId })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, run.params.workflowId))
    .limit(1);
  const defRow = defRows[0];
  if (!defRow) {
    throw new Error(`workflow engine-deps: definition not found: ${run.params.workflowId}`);
  }

  const owner = parsePrincipal(`${run.owner.ownerType}:${run.owner.ownerId}`);
  if (!owner) {
    throw new Error(
      `workflow engine-deps: run ${runId} has an unrecognized owner: ${JSON.stringify(run.owner)}`,
    );
  }

  return { orgId: defRow.orgId, actorUserId: actorUserIdFor(owner), owner };
}

/**
 * A workflow run's owner is a `Principal` (user/team/org), never a live
 * user session — there's no "acting user" to attribute engine bookkeeping
 * to. `CreateSessionOptions.userId`/`actorUserId` is only used by the
 * engine for bookkeeping/defaults, never for auth, so `owner.id` (user) or
 * `{ownerType}:{ownerId}` (team/org) is a safe placeholder. Shared between
 * `resolveRunContext` and `promptOrchestrator` so both derive the same
 * value from a `Principal` the same way.
 */
function actorUserIdFor(principal: Principal): string {
  return principal.type === "user" ? principal.id : `${principal.type}:${principal.id}`;
}

function workspaceFor(sessionId: string): string {
  // Colons are valid path-segment characters on POSIX, but avoided here for
  // portability/readability — `wf:{runId}:{nodeId}` -> `wf_{runId}_{nodeId}`.
  return join(homedir(), ".valet", "workflows", sessionId.replace(/:/g, "_"));
}

/**
 * Materialize a workflow session so the engine's claim loop can resume any
 * unsettled submission it holds. Exported for `main.ts`'s boot-time
 * `restoreUnsettledSessions`: workflow sessions have no `agent_sessions`
 * app row (they're owned by `workflow_runs`, not the sessions UI), so the
 * generic app-row restore path skips them — without this, a process restart
 * mid-session-node leaves the run parked on a submission that never
 * settles.
 */
export async function ensureWorkflowSession(
  opts: WorkflowEngineDepsOpts,
  sessionId: string,
): Promise<{ id: string }> {
  const session = await ensureSession(opts, sessionId);
  return { id: session.id };
}

async function ensureSession(opts: WorkflowEngineDepsOpts, sessionId: string, title?: string) {
  // Two session kinds reach this seam: `wf:{runId}:{nodeId}` sessions the
  // `session` node spawns, and the owner's ORCHESTRATOR session that the
  // `orchestrator` node's receipt points back at (its wake path calls
  // `awaitResult`/`abort` with `receipt.sessionId`). Each must wake through
  // its own chokepoint — an orchestrator id fed to `workflowSessionFor`
  // would rebuild it without persona/memory (the Phase 4 cache-poisoning
  // class), and a `wf:` id has no orchestrator identity.
  const principal = parseOrchestratorSessionId(sessionId);
  if (principal) {
    return ensureOrchestratorSession(opts, sessionId, principal);
  }
  const { runId } = parseWorkflowSessionId(sessionId);
  const ctx = await resolveRunContext(opts, runId);
  const workspace = workspaceFor(sessionId);
  await mkdir(workspace, { recursive: true });
  return opts.host.workflowSessionFor(sessionId, {
    actorUserId: ctx.actorUserId,
    orgId: ctx.orgId,
    owner: ctx.owner,
    workspace,
    title,
  });
}

/**
 * Wake the owner's orchestrator for the settle-side of an `orchestrator`
 * node (`awaitResult`/`abort`/re-entry after restart). `orgId` isn't in the
 * session id, but `promptOrchestrator`'s dispatch-side
 * `orchestratorSessionFor` upserted an `orchestrator_identities` row (Phase
 * 4), so it's recoverable by owner tuple.
 */
async function ensureOrchestratorSession(
  opts: WorkflowEngineDepsOpts,
  sessionId: string,
  principal: Principal,
) {
  const rows = await opts.db
    .select({ orgId: orchestratorIdentities.orgId })
    .from(orchestratorIdentities)
    .where(eq(orchestratorIdentities.sessionId, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      `workflow engine-deps: no orchestrator identity recorded for ${sessionId} — ` +
        `the dispatch that produced this receipt should have created one`,
    );
  }
  return opts.host.orchestratorSessionFor(principal, {
    actorUserId: actorUserIdFor(principal),
    orgId: row.orgId,
  });
}

export function buildWorkflowEngineDeps(opts: WorkflowEngineDepsOpts): WorkflowEngineDeps {
  const invokeActionImpl = buildActionInvoker({
    db: opts.db,
    credentials: opts.credentials,
    actionPluginByService: opts.actionPluginByService,
    githubTokenDeps: opts.githubTokenDeps,
  });

  return {
    async createSession(sessionOpts: WorkflowCreateSessionOptions): Promise<{ id: string }> {
      const session = await ensureSession(opts, sessionOpts.id, sessionOpts.title);
      return { id: session.id };
    },

    async prompt(
      sessionId: string,
      text: string,
      promptOpts: WorkflowPromptOptions,
    ): Promise<WorkflowPromptReceipt> {
      const session = await ensureSession(opts, sessionId);
      const thread = session.thread();
      const receipt = await thread.submitPrompt(text, {
        dispatchId: promptOpts.dispatchId,
        model: promptOpts.model,
        queueMode: promptOpts.queueMode,
      });
      return { threadId: thread.id, queueItemId: receipt.queueItemId };
    },

    async awaitResult(
      sessionId: string,
      threadId: string,
      queueItemId: string,
      awaitOpts?: WorkflowAwaitResultOptions,
    ) {
      const session = await ensureSession(opts, sessionId);
      const thread = session.threadById(threadId);
      if (!thread) {
        throw new Error(`workflow engine-deps: thread not found: ${threadId} on session ${sessionId}`);
      }
      return thread.awaitResult(queueItemId, {
        resultSchema: awaitOpts?.resultSchema,
      });
    },

    async abort(sessionId: string, threadId: string): Promise<void> {
      const session = await ensureSession(opts, sessionId);
      await session.abort({ threadId });
    },

    async isSettled(sessionId: string, queueItemId: string): Promise<boolean> {
      const item = await opts.engineStore.getQueueItem(sessionId, queueItemId);
      return item?.status === "settled";
    },

    async llmComplete(req: WorkflowLlmCompleteRequest): Promise<WorkflowLlmCompleteResult> {
      const model = resolveWorkflowModel(req.model);
      const result = await completeSimple(
        model,
        {
          systemPrompt: req.system,
          messages: [{ role: "user", content: [{ type: "text", text: req.prompt }], timestamp: Date.now() }],
        },
        {
          temperature: req.temperature,
          maxTokens: req.maxOutputTokens,
        },
      );
      const text = result.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, usage: mapPiAiUsage(result.usage) };
    },

    /**
     * Dispatches a followup `SignalContent` onto `opts.ownerHint`'s
     * orchestrator session (Phase 4 `EngineHost.orchestratorSessionFor` —
     * same "instant wake, reassembled from config" session every other
     * orchestrator entrypoint uses). Deliberately does NOT go through
     * `orchestrator/signals.ts`'s `admitSignal`: that function's edge ACL
     * (`authorizeEdge`) only recognizes parent<->child and
     * orchestrator<->orchestrator edges today — same-org workflow dispatch
     * is an explicitly unimplemented case there (see its comment (c)),
     * left for a future edge-ACL extension. This builder is itself trusted
     * host code (same trust level `ensureSession`'s direct
     * `thread.submitPrompt` calls already have for the `session` node), so
     * it submits directly rather than waiting on that extension.
     *
     * Thread selection: one thread per workflow RUN, keyed
     * `signal:workflow:{runId}` — the bare-key get-or-create convention
     * `orchestrator/signals.ts` documents for cross-orchestrator messages
     * (`signal:{senderId}`), with the workflow run standing in for the
     * "sender". This groups every llm/orchestrator-node prompt a given run
     * sends to this orchestrator (including repair rounds, which reuse the
     * same runId) onto one thread, so the orchestrator's inbox reads as one
     * conversation per run rather than one row per node/dispatch. Node,
     * iteration, and repair identity is carried by `dispatchId`
     * (idempotency) and the signal body — not by thread fragmentation.
     */
    async promptOrchestrator(
      promptText: string,
      promptOpts: WorkflowPromptOrchestratorOptions,
    ): Promise<WorkflowPromptOrchestratorResult> {
      const runId = parseWorkflowDispatchId(promptOpts.dispatchId);
      const principal = parsePrincipal(`${promptOpts.ownerHint.ownerType}:${promptOpts.ownerHint.ownerId}`);
      if (!principal) {
        throw new Error(
          `workflow engine-deps: promptOrchestrator received an unrecognized ownerHint: ${JSON.stringify(promptOpts.ownerHint)}`,
        );
      }
      const ctx = await resolveRunContext(opts, runId);

      const session = await opts.host.orchestratorSessionFor(principal, {
        actorUserId: actorUserIdFor(principal),
        orgId: ctx.orgId,
      });
      const thread = session.thread(`signal:workflow:${runId}`);
      const content: SignalContent = { kind: "signal", signalType: "workflow.request", body: promptText };
      const receipt = await thread.submitPrompt(content, {
        dispatchId: promptOpts.dispatchId,
        queueMode: promptOpts.queueMode,
      });
      return { sessionId: session.id, threadId: thread.id, queueItemId: receipt.queueItemId };
    },

    /**
     * The `tool` node's dispatch primitive, now that the plugin system
     * (Task 4) and the durable dedup store (Task 6) exist. `invocationId`
     * is minted by the tool executor as `workflow:{runId}:{nodeId}
     * [:{iteration}]` — the same convention `parseWorkflowDispatchId`
     * already parses for `promptOrchestrator`'s `dispatchId`, so it's
     * reused here rather than duplicated. Run context (`orgId`/
     * `actorUserId`/`owner`) is resolved the same way every other method on
     * this port resolves it (`resolveRunContext`), then handed to the
     * headless `ActionInvoker` — which owns dedup, credential scoping, and
     * action execution.
     */
    async invokeAction(req: WorkflowInvokeActionRequest): Promise<WorkflowInvokeActionResult> {
      const runId = parseWorkflowDispatchId(req.invocationId);
      const ctx = await resolveRunContext(opts, runId);
      return invokeActionImpl(req, { userId: ctx.actorUserId, orgId: ctx.orgId, owner: ctx.owner });
    },
  };
}

/**
 * Resolves an `LlmNode.model` string to a pi-ai `Model` — `provider/model`
 * form used as-is; a bare id tried under a small set of common providers
 * (anthropic first, matching the engine's own anthropic-default
 * convention in `thread.ts#resolveModelId` / `EngineHost.resolveModel`).
 * Throws descriptively on no match — the `llm` executor treats any throw
 * from `llmComplete` as a node failure, so an unknown model surfaces as a
 * readable per-node error instead of a generic crash.
 */

/** Pure so it's unit-testable without a live completion — the network
 * boundary this maps across (pi-ai's `completeSimple`) isn't itself worth
 * mocking, but the mapping logic is. Exported for that test. */
export function mapPiAiUsage(usage: Usage): WorkflowLlmUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    costUsd: usage.cost.total,
  };
}

function resolveWorkflowModel(spec: string): PiModel {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const provider = spec.slice(0, slash);
    const modelId = spec.slice(slash + 1);
    const model = getModel(provider as never, modelId as never);
    if (model) return model;
    throw new Error(`workflow engine-deps: unknown model "${spec}"`);
  }
  const tryProviders = ["anthropic", "openai", "google"] as const;
  for (const provider of tryProviders) {
    const model = getModel(provider, spec as never);
    if (model) return model;
  }
  throw new Error(
    `workflow engine-deps: unknown model "${spec}" (tried bare id under ${tryProviders.join(", ")}; use "provider/model" for anything else)`,
  );
}

/**
 * Inverse of the `workflow` dispatchId/invocationId convention:
 * `workflow:{runId}:{nodeId}[:{iteration}][:repair]`. Shared by
 * `promptOrchestrator`'s `dispatchId` and `invokeAction`'s `invocationId` —
 * same id shape, same runId position.
 */
function parseWorkflowDispatchId(id: string): string {
  const parts = id.split(":");
  if (parts.length < 3 || parts[0] !== "workflow") {
    throw new Error(`workflow engine-deps: not a workflow:{runId}:{nodeId} id: ${id}`);
  }
  return parts[1];
}
