/**
 * `/api/workflows` (Phase 5 plan decision 18). Definitions + runs, owner-
 * scoped to the authenticated principal exactly like `routes/sessions.ts`
 * (cross-owner access 404s, never 403s — an owned row and a missing row are
 * indistinguishable to the caller).
 *
 * Run state is read through `providers.workflowStore` (the same
 * `WorkflowStore` port `providers.workflowRunHost` drives runs against) —
 * never through the raw `workflow_runs`/`workflow_checkpoints`/
 * `workflow_signals` tables directly, so this route file stays correct
 * regardless of the store's backing implementation.
 */
import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import {
  validateWorkflowDefinition,
  type RunParams,
  type WorkflowDefinition,
  type WorkflowTriggerPayload,
} from "@valet/workflow";
import type { AppEnv } from "../env.js";
import { workflowDefinitions, workflowRuns } from "../schema/index.js";
import { definitionVersionId } from "../workflows/definition-version.js";
import type {
  CancelWorkflowRunResponse,
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  GetWorkflowResponse,
  GetWorkflowRunResponse,
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
  ResolveWorkflowApprovalRequest,
  ResolveWorkflowApprovalResponse,
  StartWorkflowRunRequest,
  StartWorkflowRunResponse,
  UpdateWorkflowRequest,
  UpdateWorkflowResponse,
  WorkflowDefinitionSummary,
  WorkflowRunSummary,
} from "../wire/types.js";

export const workflowsRouter = new Hono<AppEnv>();

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * `validateWorkflowDefinition` takes a `WorkflowDefinition`, not `unknown` —
 * it assumes `.nodes`/`.edges` already exist as arrays and iterates them
 * directly (a malformed shape would throw a `TypeError`, not produce a
 * validation error). Requests carry `unknown` JSON, so this narrows the
 * bare-minimum top-level shape first (object with array `nodes`/`edges`)
 * before handing off to the real validator, which then checks node/edge
 * *contents* in detail. The final cast is safe: every field the validator
 * dereferences has just been checked to exist with the right container type.
 */
function validateDefinitionInput(
  value: unknown,
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
  const result = validateWorkflowDefinition(definition);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, definition };
}

function rowToDefinition(row: typeof workflowDefinitions.$inferSelect): WorkflowDefinitionSummary {
  return {
    id: row.id,
    name: row.name,
    definition: JSON.parse(row.definition) as unknown,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Definitions ───────────────────────────────────────────────────────────

workflowsRouter.post("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  let body: CreateWorkflowRequest;
  try {
    body = (await c.req.json()) as CreateWorkflowRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  if (body.definition === undefined || body.definition === null) {
    return c.json({ error: "definition is required" }, 400);
  }

  const validation = validateDefinitionInput(body.definition);
  if (!validation.ok) {
    return c.json({ error: "invalid workflow definition", errors: validation.errors }, 400);
  }

  const now = Date.now();
  const id = newId("wf");
  await db
    .insert(workflowDefinitions)
    .values({
      id,
      orgId: user.orgId,
      ownerType: "user",
      ownerId: user.id,
      name: body.name,
      definition: JSON.stringify(body.definition),
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const resp: CreateWorkflowResponse = {
    id,
    name: body.name,
    definition: body.definition,
    createdAt: now,
    updatedAt: now,
  };
  return c.json(resp, 201);
});

workflowsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const rows = await db
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.ownerType, "user"), eq(workflowDefinitions.ownerId, user.id)))
    .orderBy(desc(workflowDefinitions.updatedAt))
    .all();

  const resp: ListWorkflowsResponse = { workflows: rows.map(rowToDefinition) };
  return c.json(resp);
});

workflowsRouter.get("/:id", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const row = await db
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.id, id), eq(workflowDefinitions.ownerType, "user"), eq(workflowDefinitions.ownerId, user.id)))
    .get();
  if (!row) return c.json({ error: "workflow not found" }, 404);

  const resp: GetWorkflowResponse = rowToDefinition(row);
  return c.json(resp);
});

workflowsRouter.put("/:id", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const row = await db
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.id, id), eq(workflowDefinitions.ownerType, "user"), eq(workflowDefinitions.ownerId, user.id)))
    .get();
  if (!row) return c.json({ error: "workflow not found" }, 404);

  let body: UpdateWorkflowRequest;
  try {
    body = (await c.req.json()) as UpdateWorkflowRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (body.definition !== undefined) {
    const validation = validateDefinitionInput(body.definition);
    if (!validation.ok) {
      return c.json({ error: "invalid workflow definition", errors: validation.errors }, 400);
    }
  }

  const now = Date.now();
  // In-flight runs are unaffected: `workflow_runs.definition` snapshots the
  // definition at run-start time (plan decision 17), so updating the
  // definitions row here never reaches back into a running/parked run.
  await db
    .update(workflowDefinitions)
    .set({
      name: body.name ?? row.name,
      definition: body.definition !== undefined ? JSON.stringify(body.definition) : row.definition,
      updatedAt: now,
    })
    .where(eq(workflowDefinitions.id, id))
    .run();

  const resp: UpdateWorkflowResponse = {
    id,
    name: body.name ?? row.name,
    definition: body.definition !== undefined ? body.definition : (JSON.parse(row.definition) as unknown),
    createdAt: row.createdAt,
    updatedAt: now,
  };
  return c.json(resp);
});

// ── Runs ──────────────────────────────────────────────────────────────────

workflowsRouter.post("/:id/runs", async (c) => {
  const { db, workflowRunHost } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const row = await db
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.id, id), eq(workflowDefinitions.ownerType, "user"), eq(workflowDefinitions.ownerId, user.id)))
    .get();
  if (!row) return c.json({ error: "workflow not found" }, 404);

  let body: StartWorkflowRunRequest = {};
  try {
    const text = await c.req.text();
    if (text.length > 0) body = JSON.parse(text) as StartWorkflowRunRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const definition = JSON.parse(row.definition) as unknown;
  const versionId = definitionVersionId(definition);
  const runId = `wfrun_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const trigger: WorkflowTriggerPayload = {
    type: "manual",
    timestamp: new Date().toISOString(),
    data: body.input ?? {},
    metadata: {},
  };
  const params: RunParams = {
    workflowId: id,
    definitionVersionId: versionId,
    input: trigger,
  };

  await workflowRunHost.start(runId, params, definition, { ownerType: "user", ownerId: user.id });

  const resp: StartWorkflowRunResponse = { runId };
  return c.json(resp, 201);
});

workflowsRouter.get("/:id/runs", async (c) => {
  const { db, workflowStore } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const defRow = await db
    .select({ id: workflowDefinitions.id })
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.id, id), eq(workflowDefinitions.ownerType, "user"), eq(workflowDefinitions.ownerId, user.id)))
    .get();
  if (!defRow) return c.json({ error: "workflow not found" }, 404);

  // `WorkflowStore` has no "list runs by workflowId" method — it's a small,
  // portable port (decision 6) and this is an API-only read concern, so the
  // list is built by asking the app db for the definition's run ids, then
  // re-fetching each through the store for a consistent shape. `workflow_runs`
  // doesn't index by owner alone, but every row here is already scoped by
  // `workflowId`, which we've just verified is owned.
  const runRows = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, id))
    .orderBy(desc(workflowRuns.createdAt))
    .all();

  const runs: WorkflowRunSummary[] = [];
  for (const r of runRows) {
    const run = await workflowStore.getRun(r.id);
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

  const resp: ListWorkflowRunsResponse = { runs };
  return c.json(resp);
});

workflowsRouter.get("/runs/:runId", async (c) => {
  const { workflowStore } = c.var.providers;
  const user = c.var.user;
  const runId = c.req.param("runId");

  const run = await workflowStore.getRun(runId);
  if (!run || !run.owner || run.owner.ownerType !== "user" || run.owner.ownerId !== user.id) {
    return c.json({ error: "run not found" }, 404);
  }

  const [checkpoints, signals] = await Promise.all([
    workflowStore.getCheckpoints(runId),
    workflowStore.listSignals(runId, { unconsumed: true }),
  ]);

  const resp: GetWorkflowRunResponse = {
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
  return c.json(resp);
});

workflowsRouter.post("/runs/:runId/approvals/:nodeId", async (c) => {
  const { workflowStore, workflowRunHost } = c.var.providers;
  const user = c.var.user;
  const runId = c.req.param("runId");
  const nodeId = c.req.param("nodeId");

  const run = await workflowStore.getRun(runId);
  if (!run || !run.owner || run.owner.ownerType !== "user" || run.owner.ownerId !== user.id) {
    return c.json({ error: "run not found" }, 404);
  }

  let body: ResolveWorkflowApprovalRequest;
  try {
    body = (await c.req.json()) as ResolveWorkflowApprovalRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.approved !== "boolean") {
    return c.json({ error: "approved is required" }, 400);
  }

  await workflowStore.insertSignal({
    runId,
    signalId: `approval:${nodeId}:resolution`,
    signalType: `approval:${nodeId}`,
    payload: { approved: body.approved, resolvedBy: user.id, note: body.note },
    createdAt: Date.now(),
  });
  await workflowRunHost.wake(runId);

  const resp: ResolveWorkflowApprovalResponse = { ok: true };
  return c.json(resp);
});

workflowsRouter.post("/runs/:runId/cancel", async (c) => {
  const { workflowStore, workflowRunHost } = c.var.providers;
  const user = c.var.user;
  const runId = c.req.param("runId");

  const run = await workflowStore.getRun(runId);
  if (!run || !run.owner || run.owner.ownerType !== "user" || run.owner.ownerId !== user.id) {
    return c.json({ error: "run not found" }, 404);
  }

  await workflowRunHost.terminate(runId);

  const resp: CancelWorkflowRunResponse = { ok: true };
  return c.json(resp);
});

export type WorkflowsRouter = typeof workflowsRouter;
