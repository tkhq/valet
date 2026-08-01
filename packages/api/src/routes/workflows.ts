/**
 * `/api/workflows` (Phase 5 plan decision 18). Definitions + runs, owner-
 * scoped to the authenticated principal exactly like `routes/sessions.ts`
 * (cross-owner access 404s, never 403s — an owned row and a missing row are
 * indistinguishable to the caller).
 *
 * All definition/run logic lives in `../workflows/service.ts` (shared with
 * the agent-facing workflows action plugin); this file is HTTP plumbing.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { ValidateEnvironment } from "@valet/workflow";
import {
  createWorkflowDefinition,
  getWorkflowDefinition,
  getWorkflowRunDetail,
  listWorkflowDefinitions,
  listWorkflowRuns,
  startWorkflowRun,
  updateWorkflowDefinition,
  validateDefinitionInput,
  type WorkflowOwner,
  type WorkflowServiceDeps,
} from "../workflows/service.js";
import { buildValidateEnvironment } from "../workflows/validation-env.js";
import type {
  CancelWorkflowRunResponse,
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  GetWorkflowResponse,
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
  ResolveWorkflowApprovalRequest,
  ResolveWorkflowApprovalResponse,
  StartWorkflowRunRequest,
  StartWorkflowRunResponse,
  UpdateWorkflowRequest,
  UpdateWorkflowResponse,
} from "../wire/types.js";

export const workflowsRouter = new Hono<AppEnv>();

function serviceCtx(c: {
  var: { providers: WorkflowServiceDeps; user: { id: string; orgId: string } };
}): { deps: WorkflowServiceDeps; owner: WorkflowOwner; env: ValidateEnvironment } {
  const { db, workflowStore, workflowRunHost, actionPluginByService } = c.var.providers;
  return {
    deps: { db, workflowStore, workflowRunHost, actionPluginByService },
    owner: { userId: c.var.user.id, orgId: c.var.user.orgId },
    env: buildValidateEnvironment(actionPluginByService),
  };
}

// ── Definitions ───────────────────────────────────────────────────────────

workflowsRouter.post("/", async (c) => {
  const { deps, owner, env } = serviceCtx(c);

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

  const validation = validateDefinitionInput(body.definition, env);
  if (!validation.ok) {
    return c.json({ error: "invalid workflow definition", errors: validation.errors }, 400);
  }

  const created = await createWorkflowDefinition(deps, owner, {
    name: body.name,
    definition: body.definition,
  });
  const resp: CreateWorkflowResponse = created;
  return c.json(resp, 201);
});

workflowsRouter.get("/", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const resp: ListWorkflowsResponse = { workflows: await listWorkflowDefinitions(deps, owner) };
  return c.json(resp);
});

workflowsRouter.get("/:id", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const summary = await getWorkflowDefinition(deps, owner, c.req.param("id"));
  if (!summary) return c.json({ error: "workflow not found" }, 404);
  const resp: GetWorkflowResponse = summary;
  return c.json(resp);
});

workflowsRouter.put("/:id", async (c) => {
  const { deps, owner, env } = serviceCtx(c);
  const id = c.req.param("id");

  let body: UpdateWorkflowRequest;
  try {
    body = (await c.req.json()) as UpdateWorkflowRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (body.definition !== undefined) {
    const validation = validateDefinitionInput(body.definition, env);
    if (!validation.ok) {
      return c.json({ error: "invalid workflow definition", errors: validation.errors }, 400);
    }
  }

  const updated = await updateWorkflowDefinition(deps, owner, id, {
    name: body.name,
    definition: body.definition,
  });
  if (!updated) return c.json({ error: "workflow not found" }, 404);

  const resp: UpdateWorkflowResponse = updated;
  return c.json(resp);
});

// ── Runs ──────────────────────────────────────────────────────────────────

workflowsRouter.post("/:id/runs", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");

  let body: StartWorkflowRunRequest = {};
  try {
    const text = await c.req.text();
    if (text.length > 0) body = JSON.parse(text) as StartWorkflowRunRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const started = await startWorkflowRun(deps, owner, id, body.input);
  if (!started) return c.json({ error: "workflow not found" }, 404);

  const resp: StartWorkflowRunResponse = { runId: started.runId };
  return c.json(resp, 201);
});

workflowsRouter.get("/:id/runs", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const runs = await listWorkflowRuns(deps, owner, c.req.param("id"));
  if (!runs) return c.json({ error: "workflow not found" }, 404);
  const resp: ListWorkflowRunsResponse = { runs };
  return c.json(resp);
});

workflowsRouter.get("/runs/:runId", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const resp = await getWorkflowRunDetail(deps, owner, c.req.param("runId"));
  if (!resp) return c.json({ error: "run not found" }, 404);
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
