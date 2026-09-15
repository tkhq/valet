/**
 * What the api does when a workflow run settles. Two observers live here,
 * both driven by `LocalRunHost`'s `onRunSettled` hook: the failed-run
 * notification below, and the per-run thread archive at the end of the
 * file.
 *
 * Failed-run attention (batch-fanout design decision 4). A workflow run
 * that settles `failed` reaches its owner through the attention router an
 * approval park already uses, so `routeAttention` stays the only writer of
 * `notifications` rows.
 *
 * Scope is deliberate:
 *   - Only a `failed` settle notifies. A completed or cancelled run needs
 *     nobody pulled in.
 *   - Only a top-level run notifies. A batch fan-out starts one child run
 *     per item, and every child failure already lands on the parent's own
 *     `workflow` node checkpoint. Without this gate a 250-item batch writes
 *     250 notification rows for one incident.
 *   - The kind is `notification`, not `escalation`. `resolveAudience`
 *     narrows an escalation on a team-owned run to team admins, which would
 *     hide a failed batch from the people who run it.
 */
import { eq } from "drizzle-orm";
import type { SessionStore } from "@valet/engine";
import type { NodeCheckpoint, OnRunSettled, WorkflowStore } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import { principalFromOwner, routeAttention } from "../orchestrator/attention.js";
import { sessionThreads, workflowDefinitions } from "../schema/index.js";
import { workflowRunThreadKey } from "./engine-deps.js";

export function workflowApprovalHref(runId: string, nodeId: string): string {
  return `/workflows?tab=action-required&run=${encodeURIComponent(runId)}&gate=${encodeURIComponent(nodeId)}`;
}

export interface RunSettledAttentionDeps {
  db: AppDb;
  store: Pick<WorkflowStore, "getCheckpoints">;
}

/** How many failed nodes the body names before it counts the rest. */
const NAMED_FAILURES = 2;
/** Per-node error budget in the body. A tool error can carry a whole response. */
const ERROR_CHARS = 200;

/**
 * Builds the `onRunSettled` handler `LocalRunHost` drives. Contained by
 * contract: the hook fires on an already-settled run, so a throw would
 * abandon a drive lease nothing reclaims. A lost notification degrades to a
 * log line — the run stays readable through the API either way.
 */
export function buildRunSettledAttention(deps: RunSettledAttentionDeps): OnRunSettled {
  return async (info) => {
    if (info.outcome !== "failed") return;
    if (info.parentRunId !== undefined) return;
    const owner = principalFromOwner(info.owner);
    if (!owner) return; // no recorded owner: no audience to resolve

    try {
      const name = await workflowName(deps.db, info.workflowId);
      const checkpoints = await deps.store.getCheckpoints(info.runId);
      await routeAttention(
        { db: deps.db },
        {
          kind: "notification",
          urgency: "high",
          owner,
          title: `Workflow run failed: ${name}`,
          body: failedNodeSummary(checkpoints),
          href: `/workflows/runs/${info.runId}`,
          // A run reclaimed while `terminalizing` re-runs settle
          // finalization, so this handler can fire twice for one run. The
          // deterministic key makes the second insert a no-op.
          dedupeKey: `${info.runId}:settled`,
        },
      );
    } catch (err) {
      console.error(`workflow failed-run notification failed for ${info.runId}:`, err);
    }
  };
}

/** The workflow's display name, falling back to its id when the definition is gone. */
async function workflowName(db: AppDb, workflowId: string): Promise<string> {
  const rows = await db
    .select({ name: workflowDefinitions.name })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, workflowId))
    .limit(1);
  return rows[0]?.name ?? workflowId;
}

/**
 * Names the nodes that failed, so the reader knows what broke before
 * opening the run. `foreach` body rows carry a non-zero iteration and are
 * labelled with it — the same node id can fail on several items.
 */
export function failedNodeSummary(checkpoints: NodeCheckpoint[]): string {
  const failed = checkpoints.filter((cp) => cp.status === "failed");
  if (failed.length === 0) return "Open the run to see why it stopped.";

  const named = failed.slice(0, NAMED_FAILURES).map((cp) => {
    const label = cp.iteration > 0 ? `${cp.nodeId}[${cp.iteration}]` : cp.nodeId;
    return `${label}: ${truncate(cp.error ?? "no error recorded")}`;
  });
  const rest = failed.length - named.length;
  const more = rest > 0 ? ` (+${rest} more)` : "";
  return `${named.join("; ")}${more}. Open the run to see the full error.`;
}

function truncate(text: string): string {
  return text.length <= ERROR_CHARS ? text : `${text.slice(0, ERROR_CHARS)}…`;
}

export interface RunThreadArchiveDeps {
  db: AppDb;
  store: Pick<WorkflowStore, "getCheckpoints">;
  /** The engine's own session store, for the thread's key and creation time. */
  engineStore: Pick<SessionStore, "getThread">;
}

/**
 * Archives the assistant thread an unattended run reported on, at the
 * moment the run settles.
 *
 * Each run gets its own thread (`engine-deps.ts#workflowRunThreadKey`), so
 * a workflow that runs every hour would add one live thread to the
 * assistant sidebar every hour. This hook is the single owner of that
 * cleanup: a settled run's thread leaves the default thread list and stays
 * readable under "Show archived". Nothing is deleted, and there is no
 * sweep or timer — a run that never settles keeps its thread, which is the
 * state the person needs to see.
 *
 * Two kinds of thread are deliberately left alone. The thread an attended
 * run was started from belongs to the person, not to the run. A `session`
 * node's thread belongs to a workflow session, which has no sidebar. The
 * thread key is what tells them apart.
 *
 * Contained by contract, like the notification above: the run is already
 * settled when this fires, so a throw would abandon a drive lease nothing
 * reclaims. Idempotent: a run reclaimed while `terminalizing` reports
 * twice, and the second archive write is the same write.
 */
export function buildRunThreadArchive(deps: RunThreadArchiveDeps): OnRunSettled {
  return async (info) => {
    try {
      const key = workflowRunThreadKey(info.runId);
      const done = new Set<string>();
      for (const checkpoint of await deps.store.getCheckpoints(info.runId)) {
        const dispatch = submissionDispatch(checkpoint.effects);
        if (!dispatch) continue;
        const seen = `${dispatch.sessionId}\n${dispatch.threadId}`;
        if (done.has(seen)) continue;
        done.add(seen);
        const thread = await deps.engineStore.getThread(dispatch.sessionId, dispatch.threadId);
        if (!thread) {
          // A thread a node dispatched onto should still be there. Report
          // it rather than archive nothing in silence; a key that does not
          // match is ordinary (an origin thread, or a session node's own).
          console.debug(
            `workflow run thread archive: run ${info.runId} recorded thread ${dispatch.threadId} ` +
              `on session ${dispatch.sessionId}, which the engine store no longer holds.`,
          );
          continue;
        }
        if (thread.key !== key) continue;
        await deps.db
          .insert(sessionThreads)
          .values({
            id: thread.id,
            sessionId: dispatch.sessionId,
            createdAt: thread.createdAt,
            archivedAt: info.settledAt,
          })
          .onConflictDoUpdate({ target: sessionThreads.id, set: { archivedAt: info.settledAt } });
      }
    } catch (err) {
      console.error(`workflow run thread archive failed for ${info.runId}:`, err);
    }
  };
}

/**
 * The session and thread a submission node recorded when it dispatched
 * (`@valet/workflow`'s `submission-node.ts` writes them into the node's
 * checkpoint effects). Returns null for every other node.
 */
function submissionDispatch(
  effects: Record<string, unknown> | undefined,
): { sessionId: string; threadId: string } | null {
  const sessionId = effects?.sessionId;
  const receipt = effects?.receipt;
  if (typeof sessionId !== "string") return null;
  if (typeof receipt !== "object" || receipt === null || !("threadId" in receipt)) return null;
  const threadId = receipt.threadId;
  return typeof threadId === "string" ? { sessionId, threadId } : null;
}
