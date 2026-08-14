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
import { NotFoundError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import type { ValidateEnvironment } from "@valet/workflow";
import {
  cancelWorkflowRun,
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflowDefinition,
  getWorkflowRunDetail,
  getWorkflowVersion,
  listWorkflowDefinitions,
  listWorkflowRuns,
  listWorkflowVersions,
  resolveWorkflowApproval,
  startWorkflowRun,
  updateWorkflowDefinition,
  validateDefinitionInput,
  type WorkflowOwner,
  type WorkflowServiceDeps,
} from "../workflows/service.js";
import {
  deleteWorkflowWebhook,
  getWorkflowWebhook,
  mintOrRotateWorkflowWebhook,
} from "../workflows/webhook-service.js";
import { buildValidateEnvironment } from "../workflows/validation-env.js";
import type {
  CancelWorkflowRunResponse,
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  DeleteWorkflowWebhookResponse,
  GetWorkflowResponse,
  GetWorkflowVersionResponse,
  ListWorkflowRunsResponse,
  ListWorkflowVersionsResponse,
  ListWorkflowsResponse,
  ResolveWorkflowApprovalRequest,
  ResolveWorkflowApprovalResponse,
  StartWorkflowRunRequest,
  StartWorkflowRunResponse,
  UpdateWorkflowRequest,
  UpdateWorkflowResponse,
  WorkflowWebhookResponse,
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

  let created;
  try {
    created = await createWorkflowDefinition(deps, owner, {
      name: body.name,
      definition: body.definition,
      teamId: body.teamId,
    });
  } catch (err) {
    // Same "cross-owner 404, never 403" convention as the rest of this
    // file — a non-member's teamId looks identical to an unknown one.
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
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

workflowsRouter.delete("/:id", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await deleteWorkflowDefinition(deps, owner, c.req.param("id"));
  if (result === "not_found") return c.json({ error: "workflow not found" }, 404);
  if (result === "has_active_runs") {
    return c.json(
      { error: "workflow has runs that are not settled. Cancel them first, then delete." },
      409,
    );
  }
  return c.json({ ok: true });
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

workflowsRouter.get("/:id/versions", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const versions = await listWorkflowVersions(deps, owner, c.req.param("id"));
  if (!versions) return c.json({ error: "workflow not found" }, 404);
  const resp: ListWorkflowVersionsResponse = { versions };
  return c.json(resp);
});

workflowsRouter.get("/:id/versions/:version", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const version = Number(c.req.param("version"));
  if (!Number.isInteger(version) || version < 1) {
    return c.json({ error: "version must be a positive integer" }, 400);
  }
  const detail = await getWorkflowVersion(deps, owner, c.req.param("id"), version);
  if (!detail) return c.json({ error: "version not found" }, 404);
  const resp: GetWorkflowVersionResponse = detail;
  return c.json(resp);
});

// ── Webhook trigger (overhaul design decision 5) ────────────────────────────
// The bearer secret itself is minted/rotated/revoked here, owner-scoped like
// every other route in this file. The secret is CONSUMED at
// `POST /api/hooks/workflows/:workflowId/:hookId` (`routes/workflow-hooks.ts`),
// an intentionally unauthenticated route mounted before `buildAuthMiddleware`.

workflowsRouter.post("/:id/webhook", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await mintOrRotateWorkflowWebhook(deps.db, owner, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, 404);
  const resp: WorkflowWebhookResponse = result.webhook;
  return c.json(resp);
});

workflowsRouter.get("/:id/webhook", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await getWorkflowWebhook(deps.db, owner, c.req.param("id"));
  if (!result.ok) return c.json({ error: "workflow not found" }, 404);
  if (!result.webhook) return c.json({ error: "no webhook configured for this workflow" }, 404);
  const resp: WorkflowWebhookResponse = result.webhook;
  return c.json(resp);
});

workflowsRouter.delete("/:id/webhook", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await deleteWorkflowWebhook(deps.db, owner, c.req.param("id"));
  if (result === "not_found") return c.json({ error: "workflow not found" }, 404);
  const resp: DeleteWorkflowWebhookResponse = { deleted: result === "deleted" };
  return c.json(resp);
});

workflowsRouter.get("/runs/:runId", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const resp = await getWorkflowRunDetail(deps, owner, c.req.param("runId"));
  if (!resp) return c.json({ error: "run not found" }, 404);
  return c.json(resp);
});

workflowsRouter.post("/runs/:runId/approvals/:nodeId", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const runId = c.req.param("runId");
  const nodeId = c.req.param("nodeId");

  let body: ResolveWorkflowApprovalRequest;
  try {
    body = (await c.req.json()) as ResolveWorkflowApprovalRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.approved !== "boolean") {
    return c.json({ error: "approved is required" }, 400);
  }
  // Reject legacy grantActions field — scope replaces it.
  if ("grantActions" in body) {
    return c.json({ error: "grantActions is no longer supported; use scope instead" }, 400);
  }
  if (body.scope !== undefined && !["once", "run", "always"].includes(body.scope)) {
    return c.json({ error: "scope must be one of: once, run, always" }, 400);
  }

  const result = await resolveWorkflowApproval(deps, owner, {
    runId,
    nodeId,
    approved: body.approved,
    note: body.note,
    scope: body.scope,
    iteration: body.iteration,
    via: "web",
  });

  if (result === "not_found") return c.json({ error: "run not found" }, 404);
  if (result === "not_parked") return c.json({ error: "run is not parked on this approval gate" }, 409);
  if (result === "already_resolved") return c.json({ error: "this approval gate has already been resolved" }, 409);
  if (result === "timed_out") return c.json({ error: "this approval gate has timed out" }, 409);
  if (result === "forbidden_always") return c.json({ error: "scope=always requires an org admin" }, 403);
  if (result === "org_mismatch") return c.json({ error: "not a member of this workflow's org" }, 403);
  if (result === "human_only") return c.json({ error: "policy gates must be resolved by a human from the run page" }, 403);

  const resp: ResolveWorkflowApprovalResponse = { ok: true };
  return c.json(resp);
});

workflowsRouter.post("/runs/:runId/cancel", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const runId = c.req.param("runId");

  const result = await cancelWorkflowRun(deps, owner, runId);
  if (result === "not_found") return c.json({ error: "run not found" }, 404);

  const resp: CancelWorkflowRunResponse = { ok: true };
  return c.json(resp);
});

export type WorkflowsRouter = typeof workflowsRouter;
