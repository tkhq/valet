/**
 * Step-design warnings: places where a workflow expects a person's approval
 * in a way a run cannot deliver. A run never asks a person from an agent
 * step, so an agent step must not ask, and an action that policy holds for
 * approval runs from a tool step or is allowed once in Review permissions.
 */
import { approvalRequestWarning } from "@valet/workflow";
import { eq } from "drizzle-orm";
import { teams, workflowDefinitions } from "../schema/index.js";
import type { WorkflowNodePermissionWire, WorkflowStepCheckResponse } from "../wire/types.js";
import { analyzeDefinitionPermissions, type WorkflowPermissionDeps } from "./permissions.js";
import { rowToDefinition, type WorkflowOwner } from "./service.js";

/** The warning for an action an agent step lists while policy holds it for approval. */
export function heldActionWarning(row: WorkflowNodePermissionWire): string | undefined {
  if (row.agentStep !== true || row.mode !== "require_approval") return undefined;
  return (
    `This step's agent calls ${row.actionId ?? `${row.service}.${row.action}`}, which policy holds for approval. ` +
    "A run refuses it unless a person allows it once in Review permissions. To approve it on each run instead, move it to a tool step."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Step-design warnings by node id, for a stored or validated definition.
 * A foreach reports its body under the foreach id, as the permission rows do.
 */
export function stepDesignWarnings(definition: unknown, permissions: readonly WorkflowNodePermissionWire[]): Map<string, string[]> {
  const warnings = new Map<string, string[]>();
  const add = (nodeId: string, warning: string | undefined) => {
    if (warning === undefined) return;
    const list = warnings.get(nodeId) ?? [];
    if (!list.includes(warning)) list.push(warning);
    warnings.set(nodeId, list);
  };
  const nodes = isRecord(definition) && Array.isArray(definition.nodes) ? definition.nodes : [];
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.id !== "string") continue;
    const step = node.type === "foreach" && isRecord(node.body) ? node.body : node;
    if (typeof step.type === "string") add(node.id, approvalRequestWarning({ type: step.type, prompt: step.prompt }));
  }
  for (const row of permissions) add(row.nodeId, heldActionWarning(row));
  return warnings;
}

/**
 * Every workflow in the caller's organization with a step-design warning.
 * The organization admin route runs it once to find workflows built before
 * runs stopped asking a person, so their owners can move the approval.
 */
export async function checkOrganizationWorkflowSteps(deps: WorkflowPermissionDeps, owner: WorkflowOwner): Promise<WorkflowStepCheckResponse> {
  const rows = await deps.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.orgId, owner.orgId));
  const teamNames = new Map((await deps.db.select({ id: teams.id, name: teams.name }).from(teams)
    .where(eq(teams.orgId, owner.orgId))).map((team) => [team.id, team.name]));
  const workflows: WorkflowStepCheckResponse["workflows"] = [];
  for (const row of rows) {
    const summary = rowToDefinition(row);
    const warnings = stepDesignWarnings(summary.definition, await analyzeDefinitionPermissions(deps, owner, summary));
    if (warnings.size === 0) continue;
    workflows.push({
      workflowId: row.id,
      name: row.name,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      ...(row.ownerType === "team" && teamNames.has(row.ownerId) ? { ownerName: teamNames.get(row.ownerId) } : {}),
      steps: [...warnings].map(([nodeId, list]) => ({ nodeId, warnings: list })),
    });
  }
  return { scanned: rows.length, workflows };
}
