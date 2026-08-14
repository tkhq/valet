/**
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
import type { NodeCheckpoint, OnRunSettled, WorkflowStore } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import { principalFromOwner, routeAttention } from "../orchestrator/attention.js";
import { workflowDefinitions } from "../schema/index.js";

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
