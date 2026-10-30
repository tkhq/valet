import { workflowStepToolScope } from "./tool-scope.js";
import { actionInScope, scopeRefusal, MODEL_CALL_LIMIT_KEY, UNATTENDED_WORKFLOW_KEY, WORKFLOW_STEP_KEY } from "@valet/shared";
import { mergeAppearance, readAppearance, type Appearance } from "@valet/shared";
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
 * `wf:{runId}:{nodeId}[:{iteration}]` (see `nodes/session.ts`), so `runId`
 * is always recoverable. From `runId` it loads the `WorkflowRun` row (for
 * `owner`/`params.workflowId`) and then the parent `workflow_definitions`
 * row (for `orgId` — `workflow_runs` doesn't carry its own `orgId` column,
 * decision 17). `actorUserId` is the run's recorded actor, the member who
 * clicked Run. An unattended start (schedule, event, webhook) records none,
 * so it is synthesized: `owner.id` for a user owner, `{ownerType}:{ownerId}`
 * otherwise. It also becomes the principal of the session's sandbox token.
 * The sandbox-facing routes that authorize git and secrets read the run's
 * owner instead (`workflows/session-owner.ts`), so a member who clicked Run
 * never lends a team-owned run their credentials.
 *
 * Every method (not just `createSession`) re-resolves this context via
 * `EngineHost.workflowSessionFor`, which is itself idempotent (cache hit
 * after the first call in a given process). This makes `prompt`/
 * `awaitResult`/`abort` self-sufficient after a process restart, rather
 * than assuming the session `createSession` warmed is still cached.
 */

import { runEventChannel, slackEventsThreadKey } from "../services/thread-access.js";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  isUnattendedWorkflowRefusal,
  parsePrincipal,
  type ActionPlugin,
  type CredentialStore,
  type DecisionGate,
  type Principal,
  type SessionStore,
  type SignalContent,
  type ValetPlugin,
} from "@valet/engine";
import { bundledModel } from "@valet/engine/model-catalog";
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
  WorkflowRunOrigin,
  WorkflowStore,
} from "@valet/workflow";
import { and, eq } from "drizzle-orm";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ArchivedAssistantError,
  ensureAssistantRuntime, ensureAssistantExecution,
  loadAssistantBySessionId,
  resolveDefaultAssistant,
} from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import type { AppDb } from "../lib/drizzle.js";
import { buildActionInvoker, type ActionInvokerOpts } from "../plugins/action-invoker.js";
import { legacyWorkflowRunRuntime, legacyWorkflowAdmission, isLegacyAssistantRuntime, legacyWorkflowRuntime } from "../services/legacy-runtime.js";
import { legacyWorkflowRuntimes, legacyWorkflowRunRuntimes, assistants, assistantExecutions, workflowDefinitions } from "../schema/index.js";
import { resolveModelSpec } from "../services/model-resolution.js";
import { workflowReasoningLevel } from "../services/reasoning.js";
import type { OnePasswordService } from "../services/onepassword.js";
import { isTeamMember } from "../services/teams.js";
import { resolveWorkflowReportTarget } from "./report-target.js";
import { definitionVersionId } from "./definition-version.js";
import { submissionWorkflowStep } from "./step-grants.js";
import { recordLlmStepUsage } from "./step-usage.js";
import { delegatedWorkOpen, lastStepTurn, openStepWork } from "./delegated-work.js";

/** How often a step wait re-reads a delegated child's watch row. */
const DELEGATED_WORK_POLL_MS = 2_000;

export interface WorkflowEngineDepsOpts {
  host: EngineHost;
  store: WorkflowStore;
  db: AppDb;
  /** The engine's own session store — needed only for the non-blocking `isSettled` probe. */
  engineStore: SessionStore;
  /** Assembled plugin action index (plugin-system-v2 plan Task 4) — `invokeAction`'s action resolution seam. */
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
  /** Full assembled plugin set, for the availability gate (see
   * `ActionInvokerOpts.plugins`). Optional; the invoker falls back to the
   * plugins in `actionPluginByService`. */
  plugins?: ValetPlugin[];
  /** Credential store `invokeAction` scopes a `CredentialProvider` over (Task 3). */
  credentials: CredentialStore;
  /** Threaded straight to `buildActionInvoker` (GH-T10) — lets the `github`
   * service resolve through `resolveGitHubToken` instead of a raw
   * credential-store read. Optional; omit in tests/deployments with no
   * github plugin registered. */
  githubTokenDeps?: ActionInvokerOpts["githubTokenDeps"];
  /**
   * 1Password reference-credential resolver (owner-precedence contract,
   * Task 6) — threaded straight to `buildActionInvoker`'s `onePassword`
   * opt. Optional; omit in tests/deployments with no 1Password service
   * wired.
   */
  onePassword?: OnePasswordService;
}

/**
 * Inverse of the `session` node's id convention: `wf:{runId}:{nodeId}` at
 * iteration 0, `wf:{runId}:{nodeId}:{iteration}` after it. A `SessionNode`
 * is a legal `foreach` body, and a body runs at one iteration per item, so
 * the 4-part form is as ordinary as the 3-part one — see `iterationSuffix`
 * in `@valet/workflow`'s `nodes/index.ts`. Run ids and node ids are
 * colon-free (the definition validator's `NODE_ID_PATTERN`), so the part
 * count identifies the form without ambiguity.
 *
 * `resolveRunContext` reads `runId` alone. `workspaceFor` reads all three
 * parts — each one becomes a separate segment of the session's workspace
 * path — so the parser checks the format of each part. A malformed id fails
 * here instead of resolving to the wrong run, or to a path outside the
 * workflows root.
 */
interface WorkflowSessionIdParts {
  runId: string;
  nodeId: string;
  iteration?: number;
}

/**
 * Both id parts that `workspaceFor` turns into a path segment must be a
 * plain name. Every minted run id is already one (`wfrun_{base36}`,
 * `wfrun_sch_{hex}_{ms}`, `wfrun_hook_{hex}`, `wfrun_evt_{uuid}`), and so is
 * every node id the definition validator admits (`NODE_ID_PATTERN`). The
 * check is the barrier against a `.`, a `..`, or a `/` reaching `join`.
 */
const ID_PART_PATTERN = /^[A-Za-z0-9_-]+$/;

export function parseWorkflowSessionId(sessionId: string): WorkflowSessionIdParts {
  const parts = sessionId.split(":");
  if (parts[0] !== "wf" || (parts.length !== 3 && parts.length !== 4)) {
    throw new Error(
      `workflow engine-deps: not a workflow session id: ${sessionId}. ` +
        `Use the wf:{runId}:{nodeId}[:{iteration}] form that the session node mints.`,
    );
  }
  const runId = parts[1];
  const nodeId = parts[2];
  if (!ID_PART_PATTERN.test(runId) || !ID_PART_PATTERN.test(nodeId)) {
    throw new Error(
      `workflow engine-deps: workflow session id ${sessionId} has an unusable run id or node id. ` +
        `Use letters, digits, "-", and "_" only — each part becomes one workspace path segment.`,
    );
  }
  if (parts.length === 3) return { runId, nodeId };

  const iteration = Number(parts[3]);
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error(
      `workflow engine-deps: workflow session id ${sessionId} has an invalid iteration suffix. ` +
        `Use a whole number of 1 or more, or remove the suffix for iteration 0.`,
    );
  }
  return { runId, nodeId, iteration };
}

/**
 * The key of the assistant thread one unattended run reports on. One
 * thread per run: the engine runs a thread's queue in series and aborts it
 * as a whole, so runs of one workflow must not share one. Read back by
 * `run-attention.ts`, which archives the thread at settlement.
 */
export function workflowRunThreadKey(runId: string, slackChannel?: string): string {
  // A run a Slack channel's event started is that channel's audience's.
  return slackChannel ? slackEventsThreadKey(slackChannel, `workflow:${runId}`) : `signal:workflow:${runId}`;
}

/**
 * The key of one step's own thread (`thread: "step"`): the run's key with
 * the step id appended, the same `{nodeId}[:{iteration}]` suffix a dispatch
 * id carries. It lives in the session the run's thread would, so it keeps
 * the run's audience, memory and working directory. A deterministic key is
 * what makes a re-issued dispatch find the thread it was admitted on.
 */
export function workflowStepThreadKey(runId: string, nodeId: string, iteration: number, slackChannel?: string): string {
  return `${workflowRunThreadKey(runId, slackChannel)}:${nodeId}${iteration > 0 ? `:${iteration}` : ""}`;
}

interface RunContext {
  presence?: Appearance;
  legacyRuntimeId?: string;
  orgId: string;
  actorUserId: string;
  owner: Principal;
  origin?: WorkflowRunOrigin;
  /** The Slack channel whose event started the run (`runEventChannel`). */
  slackChannel?: string;
}

/** The assistant a run belongs to: the one whose runtime the upgrade kept
 * for this workflow or run. Undefined for a workflow no assistant claims. */
async function runAssistantId(opts: WorkflowEngineDepsOpts, ctx: RunContext): Promise<string | undefined> {
  return ctx.legacyRuntimeId ? (await loadAssistantBySessionId(opts.db, ctx.legacyRuntimeId))?.id : undefined;
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

  const [retainedRun] = await opts.db.select({ id: legacyWorkflowRunRuntimes.runId }).from(legacyWorkflowRunRuntimes)
    .where(eq(legacyWorkflowRunRuntimes.runId, runId)).limit(1);
  const [retainedDefinition] = await opts.db.select({ id: legacyWorkflowRuntimes.workflowId }).from(legacyWorkflowRuntimes)
    .where(eq(legacyWorkflowRuntimes.workflowId, run.params.workflowId)).limit(1);
  const legacyRuntimeId = retainedRun
    ? await legacyWorkflowRunRuntime(opts.db, runId, defRow.orgId)
    : await legacyWorkflowRuntime(opts.db, run.params.workflowId, defRow.orgId);
  if ((retainedRun || retainedDefinition) && !legacyRuntimeId) {
    throw new Error("The workflow's original assistant is unavailable. Restore its authorized runtime before starting this workflow.");
  }
  const slackChannel = runEventChannel(run.params);
  const input = run.params.input;
  const data = input && typeof input === "object" && "type" in input && input.type === "event" && "data" in input
    ? input.data : undefined;
  if (!legacyRuntimeId && !slackChannel && data && typeof data === "object" && "key" in data
    && typeof data.key === "string" && data.key.startsWith("slack.")) {
    throw new Error("The Slack workflow event has no channel audience.");
  }
  const definitionPresence = run.definition && typeof run.definition === "object" && "presence" in run.definition
    ? readAppearance(run.definition.presence) : undefined;
  const presence = mergeAppearance(definitionPresence, readAppearance(run.params.presence));
  return { presence, legacyRuntimeId, orgId: defRow.orgId, actorUserId: run.actorUserId ?? actorUserIdFor(owner), owner,
    origin: run.params.origin, ...(slackChannel ? { slackChannel } : {}) };
}

/**
 * The actor of an unattended run. Its owner is a `Principal`
 * (user/team/org), and no member clicked Run, so `owner.id` (user) or
 * `{ownerType}:{ownerId}` (team/org) stands in for one. The sandbox-facing
 * credential routes do not trust this value for a workflow session; they
 * read the run's owner (`workflows/session-owner.ts`). Shared between
 * `resolveRunContext` and `promptOrchestrator` so both derive the same
 * value from a `Principal` the same way.
 */
export function actorUserIdFor(principal: Principal): string {
  return principal.type === "user" ? principal.id : `${principal.type}:${principal.id}`;
}

/**
 * The host directory one workflow session works in:
 * `~/.valet/workflows/{runId}/{nodeId}/{iteration}`, built from the PARSED
 * id parts.
 *
 * The invariant is that two different session ids never give one directory.
 * A separate path segment for each part is what holds it: no part can run
 * into the next one, because none of them accepts `/` (`ID_PART_PATTERN`).
 * A flat name built by substitution cannot hold it — node ids accept `_`,
 * so `wf:{runId}:x:1` (foreach body `x`, iteration 1) and `wf:{runId}:x_1`
 * (a sibling node) both map to `wf_{runId}_x_1`.
 *
 * Iteration 0 writes an explicit `0` segment. Without it, iteration 1 is a
 * child of iteration 0's own directory.
 *
 * The shape of this path changed with the collision fix. A run that is
 * in-flight across the deploy gets a new, empty directory for each of its
 * sessions. A workflow session lives for one run, so no long-lived work
 * moves.
 */
function workspaceFor(parts: WorkflowSessionIdParts): string {
  return join(homedir(), ".valet", "workflows", parts.runId, parts.nodeId, String(parts.iteration ?? 0));
}

/**
 * The workspace path a workflow session's sandbox was provisioned under —
 * the same string `ensureSession` hands `workflowSessionFor`, and therefore
 * the same key `SandboxProvider.deriveId` names the sandbox from. Exported
 * for the settled-run sandbox reclaim (`sandbox-reclaim.ts`), which must
 * destroy sandboxes of sessions that are no longer cached and have no
 * recorded handle. Throws on a non-workflow session id.
 */
export function workflowSessionWorkspace(sessionId: string): string {
  return workspaceFor(parseWorkflowSessionId(sessionId));
}

/**
 * Materialize a workflow session so the engine's claim loop can resume any
 * unsettled submission it holds. Exported for `main.ts`'s boot-time
 * `restoreUnsettledSessions`: workflow sessions have no `agent_sessions`
 * app row (they're owned by `workflow_runs`, not the sessions UI), so the
 * generic app-row restore path skips them — without this, a process restart
 * mid-session-node leaves the run parked on a submission that never
 * settles. Decision routes also use this path after verifying the run owner.
 */
export async function ensureWorkflowSession(
  opts: WorkflowEngineDepsOpts,
  sessionId: string,
) {
  return ensureSession(opts, sessionId);
}

async function ensureSession(opts: WorkflowEngineDepsOpts, sessionId: string, title?: string) {
  // Two session kinds reach this seam: `wf:{runId}:{nodeId}[:{iteration}]`
  // sessions the `session` node spawns, and the ASSISTANT session that the
  // `orchestrator` node's receipt points back at (its wake path calls
  // `awaitResult`/`abort` with `receipt.sessionId`). Each must wake through
  // its own chokepoint — an assistant id fed to `workflowSessionFor` would
  // rebuild it without persona/memory (the Phase 4 cache-poisoning class),
  // and a `wf:` id has no assistant row.
  const assistant = await loadAssistantBySessionId(opts.db, sessionId);
  if (assistant) {
    return (await ensureAssistantRuntime({ db: opts.db, engineHost: opts.host }, assistant,
      { actorUserId: actorUserIdFor({ type: assistant.ownerType, id: assistant.ownerId }), orgId: assistant.orgId })).session;
  }
  const parts = parseWorkflowSessionId(sessionId);
  const ctx = await resolveRunContext(opts, parts.runId);
  if (ctx.owner.type === "team" && ctx.origin) {
    const [root] = await opts.db.select().from(assistants)
      .where(eq(assistants.sessionId, ctx.origin.assistantSessionId)).limit(1);
    if (root?.ownerType === "team" && root.ownerId === ctx.owner.id) {
      const thread = await opts.engineStore.getThread(root.sessionId, ctx.origin.threadId);
      if (root.orgId !== ctx.orgId || root.archivedAt !== null || !thread) {
        throw new Error("The workflow origin is unavailable.");
      }
      // Establish the same durable execution a later thread node/report uses,
      // before a session node can write any memory for a legacy origin.
      await ensureAssistantExecution({ db: opts.db, engineHost: opts.host }, ctx.owner,
        { orgId: ctx.orgId, actorUserId: ctx.actorUserId }, thread.key);
    }
  }
  const workspace = workspaceFor(parts);
  await mkdir(workspace, { recursive: true });
  const assistantId = await runAssistantId(opts, ctx);
  const run = await opts.store.getRun(parts.runId);
  const toolScope = run ? workflowStepToolScope(run.params, run.definition, parts.nodeId) : undefined;
  return opts.host.workflowSessionFor(sessionId, {
    toolScope,
    actorUserId: ctx.actorUserId,
    orgId: ctx.orgId,
    owner: ctx.owner,
    workspace,
    title,
    ...(assistantId ? { assistantId } : {}),
  });
}

export function buildWorkflowEngineDeps(opts: WorkflowEngineDepsOpts): WorkflowEngineDeps {
  const invokeActionImpl = buildActionInvoker({
    db: opts.db,
    credentials: opts.credentials,
    actionPluginByService: opts.actionPluginByService,
    plugins: opts.plugins,
    githubTokenDeps: opts.githubTokenDeps,
    onePassword: opts.onePassword,
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
      const thread = await session.ensureDefaultThread();
      const context = await resolveRunContext(opts, parseWorkflowDispatchId(promptOpts.dispatchId));
      const previous = await legacyWorkflowAdmission(opts.db, promptOpts.dispatchId, context.orgId);
      if (previous) {
        if (previous.sessionId !== session.id || previous.threadId !== thread.id) {
          throw new Error("The workflow dispatch belongs to another session. Restore its original workflow checkpoint.");
        }
        return { threadId: previous.threadId, queueItemId: previous.queueItemId };
      }
      const receipt = await thread.submitPrompt(text, {
        dispatchId: promptOpts.dispatchId,
        model: promptOpts.model,
        metadata: { preserveTask: true, [UNATTENDED_WORKFLOW_KEY]: true, ...(promptOpts.taskSourceQueueItemId ? { taskSourceQueueItemId: promptOpts.taskSourceQueueItemId } : {}),
          ...(promptOpts.modelCallLimit ? { [MODEL_CALL_LIMIT_KEY]: promptOpts.modelCallLimit } : {}),
          ...(context.presence ? { presence: context.presence } : {}) },
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
      // The wake can refuse: a retired assistant's session must not
      // rebuild (TKAI-296), and its submission can never produce more
      // output. A throw here strikes the drive loop (an in-memory counter
      // that resets on restart) instead of failing the node — report a
      // failed outcome so `handleOutcome` settles the node cleanly.
      let session;
      try {
        session = await ensureSession(opts, sessionId);
      } catch (err) {
        if (err instanceof ArchivedAssistantError) {
          return {
            queueItemId,
            outcome: "failed" as const,
            error:
              "The assistant for this node was deleted. Re-run the workflow to use the owner's current assistant.",
          };
        }
        throw err;
      }
      const thread = session.threadById(threadId);
      if (!thread) {
        throw new Error(`workflow engine-deps: thread not found: ${threadId} on session ${sessionId}`);
      }
      await thread.awaitResult(queueItemId);
      // A turn that delegated with `task` ends before its child reports back.
      // The turn that the report starts finishes the step, so wait for it
      // and report its result.
      const item = await opts.engineStore.getQueueItem(sessionId, queueItemId);
      if (!item) throw new Error(`workflow engine-deps: queue item not found: ${queueItemId} on session ${sessionId}`);
      for (;;) {
        const work = await openStepWork(opts.db, opts.engineStore, sessionId, item);
        if (work.reportTurn) {
          await thread.awaitResult(work.reportTurn.id);
          continue;
        }
        if (!work.childPending) break;
        // The child watcher publishes no event this wait can subscribe to.
        // Poll its durable watch row, like the engine's own settlement wait.
        await new Promise((resolve) => setTimeout(resolve, DELEGATED_WORK_POLL_MS));
      }
      const lastTurn = await lastStepTurn(opts.db, opts.engineStore, sessionId, item);
      const result = await thread.awaitResult(lastTurn, {
        resultSchema: awaitOpts?.resultSchema,
      });
      if (result.outcome !== "completed") return result;
      // A step whose approval was refused skipped that action, so the run must
      // not report success. Failing the step notifies the run's owner.
      const gates = await opts.engineStore.listDecisionGatesForQueueItem(sessionId, threadId, queueItemId);
      if (lastTurn !== queueItemId) gates.push(...await opts.engineStore.listDecisionGatesForQueueItem(sessionId, threadId, lastTurn));
      const refused = gates
        .filter((gate) => gate.resolution !== undefined && isUnattendedWorkflowRefusal(gate.resolution));
      if (refused.length === 0) return result;
      // A run an agent started never uses saved permissions in agent steps
      // (`step-grants.ts`), so the review fix would not help there.
      const step = await submissionWorkflowStep(opts.engineStore, sessionId, queueItemId);
      const run = step ? await opts.store.getRun(step.runId) : null;
      return { queueItemId, outcome: "failed" as const,
        error: unattendedRefusalError(refused, { agentStarted: run?.params.startedBy === "agent" }) };
    },

    async abort(sessionId: string, threadId: string, queueItemId?: string): Promise<void> {
      // A retired assistant has nothing left to abort — the delete already
      // tore its session down. Throwing here would break run cancellation.
      let session;
      try {
        session = await ensureSession(opts, sessionId);
      } catch (err) {
        if (err instanceof ArchivedAssistantError) return;
        throw err;
      }
      if (queueItemId) {
        await session.threadById(threadId)?.abortSubmission(queueItemId);
      } else {
        await session.abort({ threadId });
      }
    },

    async isSettled(sessionId: string, queueItemId: string): Promise<boolean> {
      const item = await opts.engineStore.getQueueItem(sessionId, queueItemId);
      if (item?.status !== "settled") return false;
      // The step is not done while a child it spawned still owes its report.
      return !(await delegatedWorkOpen(opts.db, opts.engineStore, sessionId, item));
    },

    async llmComplete(req: WorkflowLlmCompleteRequest): Promise<WorkflowLlmCompleteResult> {
      const ctx = await resolveRunContext(opts, req.runId);
      // Resolve the provider before reading its settings. An unrelated disabled
      // Anthropic provider must not block legacy bare OpenAI or Google IDs.
      let modelSpec = req.model;
      if (!modelSpec.includes("/")) {
        for (const provider of ["anthropic", "openai", "google"] as const) {
          if (!bundledModel(provider, modelSpec)) continue;
          modelSpec = `${provider}/${modelSpec}`;
          break;
        }
      }
      const resolved = await resolveModelSpec(opts.db, opts.credentials, ctx.orgId, modelSpec);
      if (!resolved) {
        throw new Error(`workflow engine-deps: unknown or unavailable model "${req.model}"`);
      }
      // Without a level, a reasoning model runs with reasoning off, so a review
      // step reasoned less than the same model does in a chat thread.
      const reasoning = await workflowReasoningLevel(opts.db, ctx.orgId, ctx.owner, req.reasoning);
      const result = await completeSimple(
        resolved.model,
        {
          systemPrompt: req.system,
          messages: [{ role: "user", content: [{ type: "text", text: req.prompt }], timestamp: Date.now() }],
        },
        {
          apiKey: resolved.apiKey,
          temperature: req.temperature,
          maxTokens: req.maxOutputTokens,
          ...(reasoning ? { reasoning } : {}),
        },
      );
      // Record before the error check: a failed call can still bill tokens.
      // Usage is accounting, so a failed write is logged and the step goes on.
      await recordLlmStepUsage(opts.db, {
        runId: req.runId, nodeId: req.nodeId, iteration: req.iteration, model: result.model || resolved.model.id, usage: result.usage,
      }).catch((err: unknown) => {
        console.error(`[workflow] Cannot record usage for step ${req.nodeId} of run ${req.runId}; Usage omits this call.`, err);
      });
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        throw new Error(`Workflow model "${req.model}" ${result.stopReason}: ${result.errorMessage || "The provider did not complete the request."}`);
      }
      const text = result.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, usage: mapPiAiUsage(result.usage) };
    },

    /**
     * Dispatches a followup `SignalContent` onto `opts.ownerHint`'s
     * default assistant session (Phase 4 `EngineHost.assistantSessionFor` —
     * same "instant wake, reassembled from config" session every other
     * assistant entrypoint uses). Deliberately does NOT go through
     * `orchestrator/signals.ts`'s `admitSignal`: that function's edge ACL
     * (`authorizeEdge`) only recognizes parent<->child and
     * orchestrator<->orchestrator edges today — same-org workflow dispatch
     * is an explicitly unimplemented case there (see its comment (c)),
     * left for a future edge-ACL extension. This builder is itself trusted
     * host code (same trust level `ensureSession`'s direct
     * `thread.submitPrompt` calls already have for the `session` node), so
     * it submits directly rather than waiting on that extension.
     *
     * An explicit assistant origin reuses its exact durable session and
     * thread. Every other run reports on its own thread. A missing origin
     * thread must not create a replacement.
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
      const scopedRun = await opts.store.getRun(runId);
      const nodeId = promptOpts.dispatchId.split(":")[2];
      const toolScope = scopedRun ? workflowStepToolScope(scopedRun.params, scopedRun.definition, nodeId) : undefined;
      // An origin runtime cannot represent the intersection of a conversation
      // and a Slack-event audience. Reusing it could publish channel-private
      // inputs through shared memory. Do not dispatch until both can be carried.
      if (principal.type === "team" && ctx.slackChannel && ctx.origin &&
          !ctx.legacyRuntimeId && !await isLegacyAssistantRuntime(opts.db, ctx.origin.assistantSessionId, ctx.orgId)) {
        throw new Error("A Slack-event workflow cannot dispatch a thread step into a separate origin conversation. Run it without a conversation origin.");
      }

      // An explicit conversation origin takes precedence over definition
      // routing. Older and unattended runs keep the snapshot/default route.
      //
      // The origin resolves through the assistants table, never through an
      // id prefix: rows migrated from `orchestrator_identities` keep legacy
      // `orchestrator:*` session ids that no prefix parse recognizes
      // (`assistants/service.ts#loadAssistantBySessionId`). A prefix parse
      // here failed every orchestrator node of every run such a thread
      // started. The lookup is by session id, so the loaded row always
      // carries the origin's own session id.
      //
      // An unavailable explicit origin must not fall back to a broader team audience.
      const originAssistant = ctx.origin
        ? await loadAssistantBySessionId(opts.db, ctx.origin.assistantSessionId)
        : undefined;
      if (ctx.origin && (!originAssistant || originAssistant.archivedAt !== null)) {
        throw new Error("The workflow origin assistant is unavailable. Start a new run from an active assistant thread.");
      }
      const previous = await legacyWorkflowAdmission(opts.db, promptOpts.dispatchId, ctx.orgId);
      const previousAssistant = previous ? await loadAssistantBySessionId(opts.db, previous.sessionId) : undefined;
      const origin = ctx.origin;
      const assistant = previous ? previousAssistant : origin ? originAssistant : ctx.legacyRuntimeId
        ? await loadAssistantBySessionId(opts.db, ctx.legacyRuntimeId)
        : await resolveDefaultAssistant(opts.db, ctx.orgId, principal);
      const assistantOwnsRun = assistant?.ownerType === principal.type && assistant.ownerId === principal.id;
      const assistantOwnsActor = assistant?.ownerType === "user" && assistant.ownerId === ctx.actorUserId;
      if (!assistant || assistant.orgId !== ctx.orgId ||
          (!assistantOwnsRun && !(origin && assistantOwnsActor))) {
        throw new Error("The workspace assistant is unavailable. Open the workflow from its owning workspace and retry.");
      }
      if (assistant.archivedAt !== null) throw new ArchivedAssistantError();
      if (origin && assistantOwnsActor && !assistantOwnsRun && principal.type === "team" &&
          !(await isTeamMember(opts.db, principal.id, ctx.actorUserId))) {
        throw new Error("Workflow origin owner is no longer a team member. Start a new run from an authorized assistant.");
      }
      if (previous) {
        return { sessionId: previous.sessionId, threadId: previous.threadId, queueItemId: previous.queueItemId };
      }
      // Through the shared helper, so a runtime first woken by a workflow
      // gets the same API session record as one opened by a person. Without
      // it, the run's threads and artifact publishing report "not found".
      const deps = { db: opts.db, engineHost: opts.host };
      const meta = { actorUserId: ctx.actorUserId, orgId: ctx.orgId };
      const runKey = workflowRunThreadKey(runId, ctx.slackChannel);
      const [existingExecution] = await opts.db.select({ id: assistantExecutions.sessionId }).from(assistantExecutions)
        .where(and(eq(assistantExecutions.assistantId, assistant.id), eq(assistantExecutions.conversationKey, runKey))).limit(1);
      let { session } = origin
        ? await ensureAssistantRuntime(deps, assistant, meta)
        : ctx.legacyRuntimeId === assistant.sessionId && !existingExecution
          ? await ensureAssistantRuntime(deps, assistant, meta)
          : await ensureAssistantExecution(deps, principal, meta, runKey);
      // One thread per run. A thread is the engine's unit of serial
      // execution and of abort: a shared thread makes one run's approval
      // gate hold every other run of the same workflow, and makes the
      // thread's Stop button cancel all of them. `run-attention.ts`
      // archives the thread when the run settles, so the sidebar does not
      // fill up. An attended run reports into the thread it was started
      // from instead.
      //
      // A `thread: "step"` step gets its own thread in the same session, so
      // its turn runs beside the run's other agent work (the engine claims
      // one item per thread) with a new conversation. Its dispatch id is
      // only ever admitted there: the run snapshot fixes the node's
      // placement, and a retry starts a new run.
      const stepKey = promptOpts.stepThread
        ? workflowStepThreadKey(runId, promptOpts.stepThread.nodeId, promptOpts.stepThread.iteration, ctx.slackChannel)
        : undefined;
      let thread = origin
        ? session.threadById(origin.threadId)
        // `createThread`, not `thread`: a new run thread stamps the user's
        // current timezone (TKAI-584).
        : await session.createThread(stepKey ?? runKey);
      if (!thread) {
        throw new Error(
          `Workflow origin thread ${origin?.threadId} is missing from session ${session.id}. ` +
            "Start a new run from an active assistant thread.",
        );
      }
      if (origin) {
        // A step dispatch has no admission from before execution mappings
        // existed, so only a run-thread dispatch looks one up.
        const target = await resolveWorkflowReportTarget(deps,
          { type: assistant.ownerType, id: assistant.ownerId }, meta, session, thread, stepKey ? undefined : promptOpts.dispatchId);
        if (target.priorQueueItemId) {
          const item = await opts.engineStore.getQueueItem(session.id, target.priorQueueItemId);
          const content = item?.content;
          if (!content || typeof content === "string" || !("kind" in content) || content.kind !== "signal" ||
              content.signalType !== "workflow.request" || content.body !== promptText || content.attributes?.runId !== runId) {
            throw new Error("The legacy workflow dispatch has different content. Start a new workflow run.");
          }
          return { sessionId: session.id, threadId: thread.id, queueItemId: target.priorQueueItemId };
        }
        ({ session, thread } = target);
        if (stepKey) thread = await session.createThread(stepKey);
      }
      // `runId` as an attribute, so the client can render a link back to the
      // run instead of the bare signal type. `attributes` is flat and
      // string-valued by contract (`SignalContent`), and nothing set it
      // before — which is why a workflow report showed up in a person's
      // assistant as an envelope labelled "workflow.request" and nothing else.
      const content: SignalContent = {
        kind: "signal",
        signalType: "workflow.request",
        body: promptText,
        attributes: { runId },
      };
      const receipt = await thread.submitPrompt(content, {
        // The step lets the run's agent use the workflow's saved grants (`step-grants.ts`).
        metadata: { preserveTask: true, [UNATTENDED_WORKFLOW_KEY]: true, [WORKFLOW_STEP_KEY]: { runId, nodeId },
          ...(promptOpts.taskSourceQueueItemId ? { taskSourceQueueItemId: promptOpts.taskSourceQueueItemId } : {}),
          ...(promptOpts.modelCallLimit ? { [MODEL_CALL_LIMIT_KEY]: promptOpts.modelCallLimit } : {}),
          ...(ctx.presence ? { presence: ctx.presence } : {}), ...(toolScope ? { toolScope } : {}) },
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
      const scopedRun = await opts.store.getRun(runId);
      const scope = scopedRun ? workflowStepToolScope(scopedRun.params, scopedRun.definition) : undefined;
      const actionId = req.action.includes(".") ? req.action : `${req.service}.${req.action}`;
      if (!actionInScope(scope, actionId)) return { ok: false, error: scopeRefusal(actionId) };
      // `workflowExecutionId: runId` scopes `appliesIn: "workflow"` policy
      // enforcement + exec-scoped grant matching (action-policies plan, T3).
      const assistantId = await runAssistantId(opts, ctx);
      return invokeActionImpl(req, {
        toolScope: scope,
        userId: ctx.actorUserId,
        orgId: ctx.orgId,
        owner: ctx.owner,
        workflowExecutionId: runId,
        presence: ctx.presence,
        ...(assistantId ? { assistantId } : {}),
      });
    },

    /**
     * The `workflow` node's definition lookup (batch-fanout design
     * decision 1). Exact-owner match only: the calling run's principal
     * must equal the referenced definition's `{ownerType, ownerId}` —
     * team-shared references arrive with RBAC Phase B. A mismatch answers
     * the same `null` as a missing id.
     */
    async resolveWorkflow(workflowId, owner) {
      if (owner === undefined) return null;
      const rows = await opts.db
        .select()
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, workflowId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      if (row.ownerType !== owner.ownerType || row.ownerId !== owner.ownerId) return null;
      return { definition: row.definition, definitionVersionId: definitionVersionId(row.definition) };
    },
  };
}

/**
 * The failed-step error for approvals an unattended run refused before a
 * gate opened (`Thread.requestDecision`). An action gate carries its
 * `tool_id`. A Tool step for that action stops and asks on each run, and
 * Review permissions can allow it in the agent step instead (only there for
 * an MCP action, which the review cannot resolve in a Tool step). An
 * ask_approval request can never be answered in a run, so it gets the
 * Approval step fix. A run an agent started never uses saved permissions in
 * agent steps, so for it the error says that instead of the review fix.
 */
export function unattendedRefusalError(
  gates: Array<Pick<DecisionGate, "title" | "context">>,
  opts: { agentStarted?: boolean } = {},
): string {
  const toolId = (gate: Pick<DecisionGate, "context">) => {
    const id = gate.context?.tool_id;
    return typeof id === "string" ? id : undefined;
  };
  const actions = [...new Set(gates.flatMap((gate) => toolId(gate) ?? []))];
  const requests = gates.filter((gate) => toolId(gate) === undefined).map((gate) => `"${gate.title}"`);
  const parts = ["A workflow run cannot ask a person for approval, so Valet sent no approval request."];
  if (opts.agentStarted && actions.length > 0) {
    // The marker comes from the source run or from an agent's retry
    // (`startWorkflowRun`), so only a new run is sure to clear it.
    parts.push("An agent started or retried this run, so its agent steps do not use the workflow's saved permissions. " +
      "Start a new run from the workflow page, or wait for the workflow to start one on its own.");
  }
  for (const action of actions) {
    parts.push(
      `${action} did not run. To approve it on each run, move ${action} to a Tool step, which asks for approval on each run.` +
        (opts.agentStarted
          ? ` A new run uses saved permissions for ${action} only if this step lists it in its actions and Review permissions allows it.`
          : ` To let it run without asking, list ${action} in this step's actions, then use Review permissions on the workflow page.`),
    );
  }
  if (requests.length > 0) {
    parts.push(
      `This step asked for approval: ${requests.join(", ")}. To approve on each run, add an Approval step before this step, ` +
        "and remove the request for approval from this step's prompt. A Tool step asks for approval on each run by itself, " +
        "so an integration action that needs approval can move to a Tool step instead.",
    );
  }
  if (actions.length > 0) parts.push("A team admin can also allow an action by policy.");
  if (gates.some((gate) => gate.context?.approver !== undefined)) {
    parts.push("For a teammate's shared account, connect a team account on the team's Integrations page.");
  }
  return parts.join(" ");
}

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
