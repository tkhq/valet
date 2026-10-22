/**
 * Step-design warnings: places where a workflow expects something a run
 * cannot deliver. A run never asks a person from an agent step, so an agent
 * step must not ask, and an action that policy holds for approval runs from
 * a tool step or is allowed once in Review permissions. A scheduled run
 * reads its schedule's input under `trigger.data.input`. A team run commits
 * under the generic git identity, which deploy checks can block.
 */
import { approvalRequestWarning, pushesGitCommits, scheduledRunMisses, type ScheduledRunMiss } from "@valet/workflow";
import { and, eq, inArray } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_NAME } from "../engine/workspace-prep.js";
import { teams, workflowDefinitions, workflowSchedules } from "../schema/index.js";
import type { WorkflowNodePermissionWire, WorkflowStepCheckResponse } from "../wire/types.js";
import { analyzeDefinitionPermissions, type WorkflowPermissionDeps } from "./permissions.js";
import { rowToDefinition, type WorkflowOwner, type WorkflowOwnerType } from "./service.js";

/** What the warnings read besides the definition and its permission review. */
export interface StepDesignContext {
  /** Who owns the workflow. A team or organization run can commit as the generic git identity. */
  ownerType?: WorkflowOwnerType;
  /** Names of the enabled schedules that start this workflow. */
  schedules?: readonly string[];
}

/** The warning for an action an agent step lists while policy holds it for approval. */
export function heldActionWarning(row: WorkflowNodePermissionWire): string | undefined {
  if (row.agentStep !== true || row.mode !== "require_approval") return undefined;
  return (
    `This step's agent calls ${row.actionId ?? `${row.service}.${row.action}`}, which policy holds for approval. ` +
    "A run refuses it unless a person allows it once in Review permissions. To approve it on each run instead, move it to a tool step."
  );
}

/**
 * The warning for an action whose risk is known only when a run calls it (a
 * dynamic MCP action) and that no saved permission covers. A run refuses it
 * in an agent step, and stops for approval at a tool step, if policy holds it.
 */
export function unknownRiskActionWarning(row: WorkflowNodePermissionWire): string | undefined {
  if (row.mode !== "unknown" || row.granted === true) return undefined;
  const actionId = row.actionId ?? `${row.service}.${row.action}`;
  if (row.agentStep === true) {
    return (
      `This step's agent calls ${actionId}, whose risk is known only when a run calls it. No saved permission covers it, so a run refuses it if policy holds it for approval. ` +
      "To let runs call it, allow it once in Review permissions."
    );
  }
  return (
    `This step calls ${actionId}, whose risk is known only when a run calls it, so Review permissions cannot allow it. ` +
    `If policy holds it for approval, every run stops here until a person clicks "Allow for this workflow" on the step's approval card.`
  );
}

/**
 * The warning for a read that a scheduled run leaves empty. It gives the fix
 * in braces for a template, and bare for a condition, which takes an
 * expression. The language has no `??`, so `||` is the fallback, and it
 * skips a falsy schedule value.
 */
function scheduleInputWarning({ field, sites }: ScheduledRunMiss, schedules: readonly string[]): string {
  const named = schedules.length === 1 ? `schedule "${schedules[0]}"` : `schedules ${schedules.map((name) => `"${name}"`).join(", ")}`;
  // copy-lint: allow trigger
  const either = `trigger.data.input.${field} || trigger.data.${field}`;
  const forms = [
    ...(sites.includes("template") ? [`{{${either}}} in a template`] : []),
    ...(sites.includes("expression") ? [`${either} with no braces in a condition`] : []),
  ];
  return (
    // The text names template paths, which start with the word.
    // copy-lint: allow trigger
    `A scheduled run puts the schedule's input under trigger.data.input, so trigger.data.${field} is empty when ${named} starts this workflow. ` +
    `To read it on every kind of run, write ${forms.join(", and ")}. ` +
    `The || operator skips a schedule value of false, 0, or an empty string. To keep such a value, read trigger.data.input.${field} alone. Only a scheduled run sets it.`
  );
}

/** The warning for an agent step that pushes git commits as the generic identity, or undefined for a personal workflow. */
function gitIdentityWarning(ownerType: WorkflowOwnerType | undefined): string | undefined {
  const runs = ownerType === "team" ? "A team workflow's runs commit" : ownerType === "org" ? "An organization workflow's scheduled and event runs commit" : undefined;
  if (runs === undefined) return undefined;
  return (
    `This step's agent pushes git commits. ${runs} as "${DEFAULT_USER_NAME} <${DEFAULT_USER_EMAIL}>". ` +
    "Deploy checks such as Vercel block a commit whose author they cannot link to a person. " +
    "If the repository deploys from these commits, have the agent open a pull request for a person to merge. Or run the step from a personal workflow."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Step-design warnings by node id, for a stored or validated definition.
 * A foreach reports its body under the foreach id, as the permission rows do.
 */
export function stepDesignWarnings(
  definition: unknown,
  permissions: readonly WorkflowNodePermissionWire[],
  context: StepDesignContext = {},
): Map<string, string[]> {
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
    if (typeof step.type !== "string") continue;
    add(node.id, approvalRequestWarning({ type: step.type, prompt: step.prompt }));
    if (pushesGitCommits({ type: step.type, prompt: step.prompt })) add(node.id, gitIdentityWarning(context.ownerType));
  }
  for (const row of permissions) {
    add(row.nodeId, heldActionWarning(row));
    add(row.nodeId, unknownRiskActionWarning(row));
  }
  if (context.schedules && context.schedules.length > 0) {
    for (const [nodeId, misses] of scheduledRunMisses(definition)) {
      for (const miss of misses) add(nodeId, scheduleInputWarning(miss, context.schedules));
    }
  }
  return warnings;
}

/**
 * The enabled schedules that start each of these workflows, by workflow id.
 * A schedule names its workflow by id, so the read is scoped to the org.
 */
export async function workflowScheduleNames(db: AppQueryable, orgId: string, workflowIds: readonly string[]): Promise<Map<string, string[]>> {
  const names = new Map<string, string[]>();
  if (workflowIds.length === 0) return names;
  const rows = await db.select({ workflowId: workflowSchedules.workflowId, name: workflowSchedules.name }).from(workflowSchedules)
    .where(and(eq(workflowSchedules.orgId, orgId), eq(workflowSchedules.targetKind, "workflow"), eq(workflowSchedules.enabled, true),
      inArray(workflowSchedules.workflowId, [...workflowIds])));
  for (const row of rows) {
    if (row.workflowId === null) continue;
    names.set(row.workflowId, [...(names.get(row.workflowId) ?? []), row.name]);
  }
  return names;
}

/**
 * Every workflow in the caller's organization with a step-design warning.
 * The organization admin route runs it to find workflows that a run cannot
 * carry out as written, so their owners can fix the steps.
 */
export async function checkOrganizationWorkflowSteps(deps: WorkflowPermissionDeps, owner: WorkflowOwner): Promise<WorkflowStepCheckResponse> {
  const rows = await deps.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.orgId, owner.orgId));
  const teamNames = new Map((await deps.db.select({ id: teams.id, name: teams.name }).from(teams)
    .where(eq(teams.orgId, owner.orgId))).map((team) => [team.id, team.name]));
  const schedules = await workflowScheduleNames(deps.db, owner.orgId, rows.map((row) => row.id));
  const workflows: WorkflowStepCheckResponse["workflows"] = [];
  for (const row of rows) {
    const summary = rowToDefinition(row);
    const warnings = stepDesignWarnings(summary.definition, await analyzeDefinitionPermissions(deps, owner, summary),
      { ownerType: row.ownerType, schedules: schedules.get(row.id) });
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
