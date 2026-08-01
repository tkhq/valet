/**
 * Owner-scoped workflow definition/run operations, shared by the HTTP
 * routes (`routes/workflows.ts`) and the agent-facing action plugin
 * (`workflows/actions.ts`). Cross-owner access returns null (routes map
 * that to 404) so an owned row and a missing row stay indistinguishable.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  validateWorkflowDefinition,
  type RunParams,
  type ValidateEnvironment,
  type WorkflowDefinition,
  type WorkflowStore,
  type WorkflowTriggerPayload,
} from "@valet/workflow";
import type { RunHost } from "@valet/workflow";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { workflowDefinitions, workflowRuns } from "../schema/index.js";
import { definitionVersionId } from "./definition-version.js";
import type {
  GetWorkflowRunResponse,
  WorkflowDefinitionSummary,
  WorkflowRunSummary,
} from "../wire/types.js";

export interface WorkflowServiceDeps {
  db: AppDb;
  workflowStore: WorkflowStore;
  workflowRunHost: RunHost;
  /** Plugin catalog index — enables save-time validation of tool nodes'
   * service/action pairs (validator env hook). Optional so tests that
   * exercise definition CRUD without a plugin catalog stay lightweight. */
  actionPluginByService?: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
}

export interface WorkflowOwner {
  userId: string;
  orgId: string;
}

export function newWorkflowId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * `validateWorkflowDefinition` takes a `WorkflowDefinition`, not `unknown` —
 * it assumes `.nodes`/`.edges` already exist as arrays and iterates them
 * directly (a malformed shape would throw a `TypeError`, not produce a
 * validation error). Callers carry `unknown` JSON, so this narrows the
 * bare-minimum top-level shape first (object with array `nodes`/`edges`)
 * before handing off to the real validator, which then checks node/edge
 * *contents* in detail. The final cast is safe: every field the validator
 * dereferences has just been checked to exist with the right container type.
 */
export function validateDefinitionInput(
  value: unknown,
  env?: ValidateEnvironment,
): { ok: true; definition: WorkflowDefinition } | { ok: false; errors: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["definition must be an object"] };
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.nodes)) {
    return { ok: false, errors: ["definition.nodes must be an array"] };
  }
  if (!Array.isArray(obj.edges)) {
    return { ok: false, errors: ["definition.edges must be an array"] };
  }
  const definition = value as WorkflowDefinition;
  const result = validateWorkflowDefinition(definition, env);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, definition };
}

function rowToDefinition(row: typeof workflowDefinitions.$inferSelect): WorkflowDefinitionSummary {
  return {
    id: row.id,
    name: row.name,
    definition: row.definition,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function ownedDefinitionRow(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  id: string,
): Promise<typeof workflowDefinitions.$inferSelect | null> {
  const rows = await deps.db
    .select()
    .from(workflowDefinitions)
    .where(
      and(
        eq(workflowDefinitions.id, id),
        eq(workflowDefinitions.ownerType, "user"),
        eq(workflowDefinitions.ownerId, owner.userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listWorkflowDefinitions(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
): Promise<WorkflowDefinitionSummary[]> {
  const rows = await deps.db
    .select()
    .from(workflowDefinitions)
    .where(
      and(eq(workflowDefinitions.ownerType, "user"), eq(workflowDefinitions.ownerId, owner.userId)),
    )
    .orderBy(desc(workflowDefinitions.updatedAt));
  return rows.map(rowToDefinition);
}

export async function getWorkflowDefinition(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  id: string,
): Promise<WorkflowDefinitionSummary | null> {
  const row = await ownedDefinitionRow(deps, owner, id);
  return row ? rowToDefinition(row) : null;
}

export async function createWorkflowDefinition(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  input: { name: string; definition: unknown },
): Promise<WorkflowDefinitionSummary> {
  const now = Date.now();
  const id = newWorkflowId("wf");
  await deps.db.insert(workflowDefinitions).values({
    id,
    orgId: owner.orgId,
    ownerType: "user",
    ownerId: owner.userId,
    name: input.name,
    definition: input.definition,
    createdAt: now,
    updatedAt: now,
  });
  return { id, name: input.name, definition: input.definition, createdAt: now, updatedAt: now };
}

/** Returns null when the workflow doesn't exist (or isn't owned). */
export async function updateWorkflowDefinition(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  id: string,
  input: { name?: string; definition?: unknown },
): Promise<WorkflowDefinitionSummary | null> {
  const row = await ownedDefinitionRow(deps, owner, id);
  if (!row) return null;

  const now = Date.now();
  // In-flight runs are unaffected: `workflow_runs.definition` snapshots the
  // definition at run-start time (plan decision 17), so updating the
  // definitions row here never reaches back into a running/parked run.
  await deps.db
    .update(workflowDefinitions)
    .set({
      name: input.name ?? row.name,
      definition: input.definition !== undefined ? input.definition : row.definition,
      updatedAt: now,
    })
    .where(eq(workflowDefinitions.id, id));

  return {
    id,
    name: input.name ?? row.name,
    definition: input.definition !== undefined ? input.definition : row.definition,
    createdAt: row.createdAt,
    updatedAt: now,
  };
}

export type DeleteWorkflowResult = "deleted" | "not_found" | "has_active_runs";

/**
 * Hard-deletes a workflow definition. Refuses while the workflow has
 * non-settled runs — runs snapshot their definition so they WOULD keep
 * executing, but they'd be orphaned from every list view; forcing a
 * cancel-first flow keeps the run ledger navigable. Settled runs are kept
 * (they're history, reachable via their runId).
 */
export async function deleteWorkflowDefinition(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  id: string,
): Promise<DeleteWorkflowResult> {
  const row = await ownedDefinitionRow(deps, owner, id);
  if (!row) return "not_found";

  const runRows = await deps.db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, id));
  for (const r of runRows) {
    const run = await deps.workflowStore.getRun(r.id);
    if (run && run.status !== "settled") return "has_active_runs";
  }

  await deps.db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, id));
  return "deleted";
}

/** Returns null when the workflow doesn't exist (or isn't owned). */
export async function startWorkflowRun(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
  input?: Record<string, unknown>,
): Promise<{ runId: string } | null> {
  const row = await ownedDefinitionRow(deps, owner, workflowId);
  if (!row) return null;

  const definition = row.definition;
  const versionId = definitionVersionId(definition);
  const runId = newWorkflowId("wfrun");

  const trigger: WorkflowTriggerPayload = {
    type: "manual",
    timestamp: new Date().toISOString(),
    data: input ?? {},
    metadata: {},
  };
  const params: RunParams = {
    workflowId,
    definitionVersionId: versionId,
    input: trigger,
  };

  await deps.workflowRunHost.start(runId, params, definition, {
    ownerType: "user",
    ownerId: owner.userId,
  });
  return { runId };
}

export async function listWorkflowRuns(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  workflowId: string,
): Promise<WorkflowRunSummary[] | null> {
  const row = await ownedDefinitionRow(deps, owner, workflowId);
  if (!row) return null;

  // `WorkflowStore` has no "list runs by workflowId" method — it's a small,
  // portable port (decision 6) and this is an API-only read concern, so the
  // list is built by asking the app db for the definition's run ids, then
  // re-fetching each through the store for a consistent shape. `workflow_runs`
  // doesn't index by owner alone, but every row here is already scoped by
  // `workflowId`, which we've just verified is owned.
  const runRows = await deps.db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, workflowId))
    .orderBy(desc(workflowRuns.createdAt));

  const runs: WorkflowRunSummary[] = [];
  for (const r of runRows) {
    const run = await deps.workflowStore.getRun(r.id);
    if (!run) continue;
    runs.push({
      runId: run.runId,
      workflowId: run.params.workflowId,
      status: run.status,
      outcome: run.outcome,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
  }
  return runs;
}

/** Owner-gated run lookup shared by cancel/approval below. */
async function ownedRun(deps: WorkflowServiceDeps, owner: WorkflowOwner, runId: string) {
  const run = await deps.workflowStore.getRun(runId);
  if (!run || !run.owner || run.owner.ownerType !== "user" || run.owner.ownerId !== owner.userId) {
    return null;
  }
  return run;
}

/** Terminates a run. `not_found` covers unknown AND un-owned run ids. */
export async function cancelWorkflowRun(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  runId: string,
): Promise<"ok" | "not_found"> {
  const run = await ownedRun(deps, owner, runId);
  if (!run) return "not_found";
  await deps.workflowRunHost.terminate(runId);
  return "ok";
}

/** Resolves an approval gate: inserts the approval signal and wakes the
 * run. The caller decides WHO may resolve (the HTTP route lets the session
 * user; the agent tool rides a high-risk decision gate). */
export async function resolveWorkflowApproval(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  input: { runId: string; nodeId: string; approved: boolean; note?: string },
): Promise<"ok" | "not_found"> {
  const run = await ownedRun(deps, owner, input.runId);
  if (!run) return "not_found";
  await deps.workflowStore.insertSignal({
    runId: input.runId,
    signalId: `approval:${input.nodeId}:resolution`,
    signalType: `approval:${input.nodeId}`,
    payload: { approved: input.approved, resolvedBy: owner.userId, note: input.note },
    createdAt: Date.now(),
  });
  await deps.workflowRunHost.wake(input.runId);
  return "ok";
}

/** Returns null when the run doesn't exist or isn't owned by `owner`. */
export async function getWorkflowRunDetail(
  deps: WorkflowServiceDeps,
  owner: WorkflowOwner,
  runId: string,
): Promise<GetWorkflowRunResponse | null> {
  const run = await deps.workflowStore.getRun(runId);
  if (!run || !run.owner || run.owner.ownerType !== "user" || run.owner.ownerId !== owner.userId) {
    return null;
  }

  const [checkpoints, signals] = await Promise.all([
    deps.workflowStore.getCheckpoints(runId),
    deps.workflowStore.listSignals(runId, { unconsumed: true }),
  ]);

  return {
    run: {
      runId: run.runId,
      workflowId: run.params.workflowId,
      status: run.status,
      outcome: run.outcome,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      waitingOn: run.waitingOn,
      definition: run.definition,
      params: run.params,
    },
    checkpoints: checkpoints.map((cp) => ({
      nodeId: cp.nodeId,
      iteration: cp.iteration,
      status: cp.status,
      result: cp.result,
      error: cp.error,
      createdAt: cp.createdAt,
    })),
    signals: signals.map((s) => ({
      signalId: s.signalId,
      signalType: s.signalType,
      payload: s.payload,
      createdAt: s.createdAt,
    })),
  };
}
