/** Which saved workflow grants an agent step's call may use
 * (`docs/specs/2026-10-17-agent-step-workflow-grants-design.md`). */
import { and, eq } from "drizzle-orm";
import { WORKFLOW_STEP_KEY } from "@valet/shared";
import type { SessionStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { workflowDefinitions, workflowRuns } from "../schema/index.js";
import { policyOwner } from "../policies/service.js";
import { sameWorkflowSteps } from "./definition-version.js";
import { agentStepEntries, entryService, isExactAction } from "./tool-scope.js";

export interface WorkflowStepRef {
  runId: string;
  nodeId: string;
}

/** An agent step that passed every check, with what it declares. */
export interface WorkflowStepGrant {
  workflowId: string;
  runId: string;
  /** Exact `service.action` entries in the step's own `toolScope.actions`. */
  actions: readonly string[];
  /** Credential services of every entry, exact or `service.*`. Saved account
   * consent covers only these. */
  services: readonly string[];
}

const ID = /^[A-Za-z0-9_-]+$/;

function readStepRef(value: unknown): WorkflowStepRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { runId, nodeId } = value as Record<string, unknown>;
  return typeof runId === "string" && typeof nodeId === "string" && ID.test(runId) && ID.test(nodeId) ? { runId, nodeId } : undefined;
}

/** The step a submission's host metadata names, else the step a
 * `wf:{runId}:{nodeId}[:{iteration}]` session id names. A tool step's
 * `wf:{runId}` scope is not an agent step. */
export function workflowStepOf(sessionId: string, metadata: Record<string, unknown> | undefined): WorkflowStepRef | undefined {
  const stamped = readStepRef(metadata?.[WORKFLOW_STEP_KEY]);
  if (stamped) return stamped;
  const parts = sessionId.split(":");
  if (parts[0] !== "wf" || (parts.length !== 3 && parts.length !== 4)) return undefined;
  return readStepRef({ runId: parts[1], nodeId: parts[2] });
}

/** The step the host wrote on a submission, for a child to inherit. */
export async function submissionWorkflowStep(
  engineStore: Pick<SessionStore, "getQueueItem">,
  sessionId: string,
  queueItemId: string | undefined,
): Promise<WorkflowStepRef | undefined> {
  const item = queueItemId ? await engineStore.getQueueItem(sessionId, queueItemId) : null;
  return workflowStepOf(sessionId, item?.metadata);
}

/**
 * The step this call runs in, when its run may use the workflow's saved
 * grants. The run must be live, the node an agent step, the workflow still
 * owned by the run owner with the same steps, the session's policy owner the
 * run owner, and the run not started by an agent on its own.
 */
export async function resolveWorkflowStepGrant(
  deps: { db: AppQueryable; engineStore: Pick<SessionStore, "getQueueItem">; credentialServiceFor: (service: string) => string },
  input: { orgId: string; sessionId: string; queueItemId?: string; teamId?: string; userId?: string },
): Promise<WorkflowStepGrant | undefined> {
  const step = await submissionWorkflowStep(deps.engineStore, input.sessionId, input.queueItemId);
  if (!step) return undefined;
  const [run] = await deps.db.select({
    workflowId: workflowRuns.workflowId, definition: workflowRuns.definition, params: workflowRuns.params,
    status: workflowRuns.status, ownerType: workflowRuns.ownerType, ownerId: workflowRuns.ownerId,
  }).from(workflowRuns).where(eq(workflowRuns.id, step.runId)).limit(1);
  if (!run || run.status === "settled") return undefined;
  const params = run.params as { startedBy?: unknown } | null;
  if (params?.startedBy === "agent") return undefined;
  const entries = agentStepEntries(run.definition, step.nodeId);
  if (!entries) return undefined;
  const [saved] = await deps.db.select({ ownerType: workflowDefinitions.ownerType, ownerId: workflowDefinitions.ownerId, definition: workflowDefinitions.definition })
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.id, run.workflowId), eq(workflowDefinitions.orgId, input.orgId))).limit(1);
  if (!saved || saved.ownerType !== run.ownerType || saved.ownerId !== run.ownerId) return undefined;
  // A team run reporting into a member's personal assistant resolves for that
  // member, without team policies, so the team's grants do not apply there.
  const owner = await policyOwner(deps.db, input);
  const sameOwner = run.ownerType === "team" ? owner.teamId === run.ownerId : owner.teamId === undefined && owner.userId === run.ownerId;
  if (!sameOwner || !sameWorkflowSteps(saved.definition, run.definition)) return undefined;
  return { workflowId: run.workflowId, runId: step.runId, actions: entries.filter(isExactAction),
    services: [...new Set(entries.map((entry) => deps.credentialServiceFor(entryService(entry))))] };
}
