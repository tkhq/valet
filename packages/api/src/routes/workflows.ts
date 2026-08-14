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
import { WorkflowCursorError, type ValidateEnvironment } from "@valet/workflow";
import {
  cancelWorkflowRun,
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflowDefinition,
  getWorkflowRunDetail,
  getWorkflowVersion,
  isRunOutcome,
  isRunStatus,
  listRunsForOwner,
  listWorkflowDefinitions,
  listWorkflowRuns,
  listWorkflowVersions,
  resolveWorkflowApproval,
  startWorkflowRun,
  updateWorkflowDefinition,
  validateDefinitionInput,
  RUN_OUTCOME_VALUES,
  RUN_PAGE_LIMIT_MAX,
  RUN_STATUS_VALUES,
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
  WorkflowRunOutcome,
  WorkflowRunStatus,
  WorkflowWebhookResponse,
} from "../wire/types.js";

export const workflowsRouter = new Hono<AppEnv>();

/** An empty query value means "not set": a client that always sends the
 * field must not get a 400 for leaving it blank. */
function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** Parses `?limit=` for the run lists. Both list handlers share the range. */
function parseRunLimit(raw: string | undefined): { limit?: number } | { error: string } {
  const value = blankToUndefined(raw);
  if (value === undefined) return {};
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > RUN_PAGE_LIMIT_MAX) {
    return { error: `limit must be an integer from 1 to ${RUN_PAGE_LIMIT_MAX}` };
  }
  return { limit };
}

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

// ── Cross-workflow run list ───────────────────────────────────────────────
//
// Registration order is load-bearing: `GET /:id` below also matches the
// single segment `/runs`, and the router picks the route registered first.
// Keep this handler above it. (`GET /runs/:runId` further down is safe at
// any position — two segments never collide with `/:id`.)

workflowsRouter.get("/runs", async (c) => {
  const { deps, owner } = serviceCtx(c);

  const limit = parseRunLimit(c.req.query("limit"));
  if ("error" in limit) return c.json({ error: limit.error }, 400);

  // A whole number, not merely finite: `created_at` is an integer column, and
  // a fractional or out-of-range value reaches the driver as a syntax error.
  const rawSince = blankToUndefined(c.req.query("since"));
  const since = rawSince === undefined ? undefined : Number(rawSince);
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
    return c.json({ error: "since must be a whole millisecond timestamp, 0 or greater" }, 400);
  }

  // `status`, `outcome` and `workflowId` are repeatable and match any-of.
  const rawStatus = c.req.queries("status");
  const status = rawStatus?.filter(isRunStatus);
  if (rawStatus && status && status.length !== rawStatus.length) {
    return c.json({ error: `status must be one of: ${RUN_STATUS_VALUES.join(", ")}` }, 400);
  }
  const rawOutcome = c.req.queries("outcome");
  const outcome = rawOutcome?.filter(isRunOutcome);
  if (rawOutcome && outcome && outcome.length !== rawOutcome.length) {
    return c.json({ error: `outcome must be one of: ${RUN_OUTCOME_VALUES.join(", ")}` }, 400);
  }

  let page;
  try {
    page = await listRunsForOwner(deps, owner, {
      workflowIds: c.req.queries("workflowId"),
      status,
      outcome,
      parentRunId: blankToUndefined(c.req.query("parentRunId")),
      since,
      limit: limit.limit,
      cursor: blankToUndefined(c.req.query("cursor")),
    });
  } catch (err) {
    if (err instanceof WorkflowCursorError) return c.json({ error: err.message }, 400);
    throw err;
  }
  // Same convention as every other handler here: a workflow the caller
  // cannot read is indistinguishable from one that does not exist.
  if (!page) return c.json({ error: "workflow not found" }, 404);

  const resp: ListWorkflowRunsResponse = page;
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

  const limit = parseRunLimit(c.req.query("limit"));
  if ("error" in limit) return c.json({ error: limit.error }, 400);

  let page;
  try {
    page = await listWorkflowRuns(deps, owner, c.req.param("id"), {
      limit: limit.limit,
      cursor: blankToUndefined(c.req.query("cursor")),
    });
  } catch (err) {
    if (err instanceof WorkflowCursorError) return c.json({ error: err.message }, 400);
    throw err;
  }
  if (!page) return c.json({ error: "workflow not found" }, 404);

  const resp: ListWorkflowRunsResponse = page;
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

  const result = await resolveWorkflowApproval(deps, owner, {
    runId,
    nodeId,
    approved: body.approved,
    note: body.note,
  });
  if (result === "not_found") return c.json({ error: "run not found" }, 404);

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
