/**
 * Seeds the two rows a workflow session's owner is read from
 * (`workflows/session-owner.ts`): the `workflow_definitions` row that
 * carries the org, and the `workflow_runs` row that carries the owner and the
 * actor who clicked Run. Returns the session id a `session` node named
 * `nodeId` gets in that run.
 */
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { workflowDefinitions, workflowRuns } from "../schema/index.js";

export async function seedWorkflowRun(
  db: AppDb,
  opts: { runId: string; orgId: string; owner: Principal; actorUserId?: string; nodeId?: string },
): Promise<string> {
  const now = Date.now();
  const workflowId = `wf_def_${opts.runId}`;
  const definition = { version: "dag/v1", nodes: [], edges: [] };
  await db.insert(workflowDefinitions).values({
    id: workflowId,
    orgId: opts.orgId,
    ownerType: opts.owner.type,
    ownerId: opts.owner.id,
    name: `workflow ${opts.runId}`,
    definition,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workflowRuns).values({
    id: opts.runId,
    workflowId,
    definitionVersionId: "v1",
    definition,
    params: { workflowId, definitionVersionId: "v1" },
    ownerType: opts.owner.type,
    ownerId: opts.owner.id,
    actorUserId: opts.actorUserId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return `wf:${opts.runId}:${opts.nodeId ?? "sync"}`;
}
