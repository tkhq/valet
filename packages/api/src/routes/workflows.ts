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
  workflowWebhookUrl,
} from "../workflows/webhook-service.js";
import {
  createWorkflowSchedule,
  deleteWorkflowSchedule,
  listWorkflowSchedules,
  type WorkflowScheduleSummary,
} from "../workflows/schedule-service.js";
import { buildValidateEnvironment } from "../workflows/validation-env.js";
import type {
  CancelWorkflowRunResponse,
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  CreateWorkflowScheduleRequest,
  CreateWorkflowScheduleResponse,
  DeleteWorkflowScheduleResponse,
  DeleteWorkflowWebhookResponse,
  ListWorkflowSchedulesResponse,
  WorkflowScheduleWire,
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
  const resp: WorkflowWebhookResponse = {
    ...result.webhook,
    url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId, new URL(c.req.url).origin),
  };
  return c.json(resp);
});

workflowsRouter.get("/:id/webhook", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await getWorkflowWebhook(deps.db, owner, c.req.param("id"));
  if (!result.ok) return c.json({ error: "workflow not found" }, 404);
  if (!result.webhook) return c.json({ error: "no webhook configured for this workflow" }, 404);
  const resp: WorkflowWebhookResponse = {
    ...result.webhook,
    url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId, new URL(c.req.url).origin),
  };
  return c.json(resp);
});

workflowsRouter.delete("/:id/webhook", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await deleteWorkflowWebhook(deps.db, owner, c.req.param("id"));
  if (result === "not_found") return c.json({ error: "workflow not found" }, 404);
  const resp: DeleteWorkflowWebhookResponse = { deleted: result === "deleted" };
  return c.json(resp);
});

// ── Schedules (cron triggers) ─────────────────────────────────────────────
// Owner-scoped like the webhook routes above: every route resolves the
// workflow through `getWorkflowDefinition` first, so an unowned workflow
// 404s identically to a missing one. The schedule service also carries
// orchestrator-prompt schedules; this surface manages only the
// workflow-scoped kind, so every row it returns has a `workflowId`.

function toScheduleWire(s: WorkflowScheduleSummary, workflowId: string): WorkflowScheduleWire {
  return {
    scheduleId: s.scheduleId,
    workflowId: s.workflowId ?? workflowId,
    name: s.name,
    cron: s.cron,
    timezone: s.timezone,
    enabled: s.enabled,
    lastFiredAt: s.lastFiredAt,
    nextFireAt: s.nextFireAt,
  };
}

workflowsRouter.get("/:id/schedules", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");
  const summary = await getWorkflowDefinition(deps, owner, id);
  if (!summary) return c.json({ error: "workflow not found" }, 404);
  const schedules = await listWorkflowSchedules(deps.db, owner.orgId, id);
  const resp: ListWorkflowSchedulesResponse = {
    schedules: schedules.map((s) => toScheduleWire(s, id)),
  };
  return c.json(resp);
});

workflowsRouter.post("/:id/schedules", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");
  const summary = await getWorkflowDefinition(deps, owner, id);
  if (!summary) return c.json({ error: "workflow not found" }, 404);

  let body: CreateWorkflowScheduleRequest;
  try {
    body = (await c.req.json()) as CreateWorkflowScheduleRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json({ error: "name must be a non-empty string" }, 400);
  }
  if (!body.cron || typeof body.cron !== "string") {
    return c.json({ error: "cron must be a 5-field cron expression string" }, 400);
  }
  if (body.timezone !== undefined && typeof body.timezone !== "string") {
    return c.json({ error: "timezone must be an IANA timezone string" }, 400);
  }
  if (
    body.input !== undefined &&
    (typeof body.input !== "object" || body.input === null || Array.isArray(body.input))
  ) {
    return c.json({ error: "input must be a JSON object" }, 400);
  }

  const result = await createWorkflowSchedule(
    deps.db,
    { id: owner.userId, orgId: owner.orgId },
    { workflowId: id, name, cron: body.cron, timezone: body.timezone, input: body.input },
  );
  if (!result.ok) return c.json({ error: result.error }, 400);
  const resp: CreateWorkflowScheduleResponse = toScheduleWire(result.schedule, id);
  return c.json(resp, 201);
});

workflowsRouter.delete("/:id/schedules/:scheduleId", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");
  const scheduleId = c.req.param("scheduleId");
  const summary = await getWorkflowDefinition(deps, owner, id);
  if (!summary) return c.json({ error: "workflow not found" }, 404);
  const result = await deleteWorkflowSchedule(deps.db, owner.orgId, scheduleId, id);
  if (result === "not_found") return c.json({ error: "schedule not found" }, 404);
  const resp: DeleteWorkflowScheduleResponse = { deleted: true };
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
