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
import type { Principal, SessionStore } from "@valet/engine";
import type {
  WorkflowAwaitResultOptions,
  WorkflowCreateSessionOptions,
  WorkflowEngineDeps,
  WorkflowPromptOptions,
  WorkflowPromptReceipt,
  WorkflowStore,
} from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import { workflowDefinitions } from "../schema/index.js";

export interface WorkflowEngineDepsOpts {
  host: EngineHost;
  store: WorkflowStore;
  db: AppDb;
  /** The engine's own session store — needed only for the non-blocking `isSettled` probe. */
  engineStore: SessionStore;
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

  const defRow = await opts.db
    .select({ orgId: workflowDefinitions.orgId })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, run.params.workflowId))
    .get();
  if (!defRow) {
    throw new Error(`workflow engine-deps: definition not found: ${run.params.workflowId}`);
  }

  const owner: Principal = {
    type: run.owner.ownerType as Principal["type"],
    id: run.owner.ownerId,
  };
  const actorUserId = owner.type === "user" ? owner.id : `${owner.type}:${owner.id}`;

  return { orgId: defRow.orgId, actorUserId, owner };
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

export function buildWorkflowEngineDeps(opts: WorkflowEngineDepsOpts): WorkflowEngineDeps {
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
  };
}
