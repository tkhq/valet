/**
 * `/api/workflows/{triggers,schedules,event-triggers,trigger-catalog,runs}`
 * (spec 2026-08-15). Aggregated trigger read + kind-specific writes over
 * `schedule-service` / `trigger-service` / `WorkflowScheduler.fireNow`.
 *
 * MOUNT ORDER MATTERS: this router must be mounted on `/api/workflows`
 * BEFORE `workflowsRouter`, whose `GET /:id` would otherwise swallow
 * `/triggers` and `/runs` as workflow ids.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import {
  createWorkflowSchedule,
  deleteWorkflowSchedule,
  listWorkflowSchedules,
  updateWorkflowSchedule,
} from "../workflows/schedule-service.js";
import {
  createWorkflowTrigger,
  deleteWorkflowTrigger,
  listEventTypes,
  listWorkflowTriggers,
  updateWorkflowTrigger,
} from "../workflows/trigger-service.js";
import { listRecentWorkflowRuns } from "../workflows/service.js";
import type {
  CreateWorkflowEventTriggerRequest,
  CreateWorkflowScheduleRequest,
  GetWorkflowTriggerCatalogResponse,
  ListAllWorkflowRunsResponse,
  ListWorkflowTriggersResponse,
  UpdateWorkflowEventTriggerRequest,
  UpdateWorkflowScheduleRequest,
  WorkflowEventTriggerResponse,
  WorkflowScheduleResponse,
  WorkflowTriggerItem,
} from "../wire/types.js";

export const workflowTriggersRouter = new Hono<AppEnv>();

const CRON_HINT = ' Use 5 fields, for example "0 9 * * 1-5" (09:00 on weekdays).';

/** Cron/timezone service errors get the example appended once. */
function withCronHint(error: string): string {
  return error.includes("cron") ? error + CRON_HINT : error;
}

workflowTriggersRouter.get("/triggers", async (c) => {
  const { db } = c.var.providers;
  const orgId = c.var.user.orgId;
  const workflowId = c.req.query("workflowId") || undefined;

  const [schedules, events] = await Promise.all([
    listWorkflowSchedules(db, orgId, workflowId),
    listWorkflowTriggers(db, orgId, workflowId),
  ]);
  const triggers: WorkflowTriggerItem[] = [
    ...schedules.map((s): WorkflowTriggerItem => ({
      kind: "schedule",
      id: s.scheduleId,
      workflowId: s.workflowId,
      name: s.name,
      enabled: s.enabled,
      detail: {
        cron: s.cron,
        timezone: s.timezone,
        targetKind: s.targetKind,
        prompt: s.prompt,
        input: s.input,
        nextFireAt: s.nextFireAt,
        lastFiredAt: s.lastFiredAt,
      },
    })),
    ...events.map((t): WorkflowTriggerItem => ({
      kind: "event",
      id: t.triggerId,
      workflowId: t.workflowId,
      name: t.name,
      enabled: t.enabled,
      detail: { eventKeys: t.eventKeys, filters: t.filters },
    })),
  ];
  const resp: ListWorkflowTriggersResponse = { triggers };
  return c.json(resp);
});

workflowTriggersRouter.get("/trigger-catalog", (c) => {
  const resp: GetWorkflowTriggerCatalogResponse = {
    catalog: listEventTypes(c.var.providers.plugins),
  };
  return c.json(resp);
});

workflowTriggersRouter.get("/runs", async (c) => {
  const { db, workflowStore, workflowRunHost, actionPluginByService } = c.var.providers;
  const owner = { userId: c.var.user.id, orgId: c.var.user.orgId };
  const rawLimit = Number(c.req.query("limit") ?? 50);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 200 ? rawLimit : 50;
  const runs = await listRecentWorkflowRuns(
    { db, workflowStore, workflowRunHost, actionPluginByService },
    owner,
    limit,
  );
  const resp: ListAllWorkflowRunsResponse = { runs };
  return c.json(resp);
});

// ── Schedules ────────────────────────────────────────────────────────────

workflowTriggersRouter.post("/schedules", async (c) => {
  const { db } = c.var.providers;
  const user = { id: c.var.user.id, orgId: c.var.user.orgId };

  let body: CreateWorkflowScheduleRequest;
  try {
    body = (await c.req.json()) as CreateWorkflowScheduleRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object." }, 400);
  }
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  if (!body.target || (body.target.kind !== "workflow" && body.target.kind !== "orchestrator")) {
    return c.json(
      {
        error:
          'target.kind must be "workflow" (start a run) or "orchestrator" (send a prompt)',
      },
      400,
    );
  }

  const result = await createWorkflowSchedule(db, user, {
    name: body.name,
    cron: body.cron,
    timezone: body.timezone,
    workflowId: body.target.kind === "workflow" ? body.target.workflowId : undefined,
    prompt: body.target.kind === "orchestrator" ? body.target.prompt : undefined,
    input: body.target.kind === "workflow" ? body.target.input : undefined,
  });
  if (!result.ok) return c.json({ error: withCronHint(result.error) }, 400);
  const resp: WorkflowScheduleResponse = { schedule: result.schedule };
  return c.json(resp, 201);
});

workflowTriggersRouter.patch("/schedules/:id", async (c) => {
  const { db } = c.var.providers;
  let body: UpdateWorkflowScheduleRequest;
  try {
    body = (await c.req.json()) as UpdateWorkflowScheduleRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object." }, 400);
  }
  const result = await updateWorkflowSchedule(db, c.var.user.orgId, c.req.param("id"), body);
  if (!result.ok) {
    const msg =
      result.status === 404
        ? `${result.error} Confirm the id and that it belongs to this org.`
        : withCronHint(result.error);
    return c.json({ error: msg }, result.status);
  }
  const resp: WorkflowScheduleResponse = { schedule: result.schedule };
  return c.json(resp);
});

workflowTriggersRouter.delete("/schedules/:id", async (c) => {
  const { db } = c.var.providers;
  const result = await deleteWorkflowSchedule(db, c.var.user.orgId, c.req.param("id"));
  if (result === "not_found") return c.json({ error: "schedule not found. Confirm the id and that it belongs to this org." }, 404);
  return c.json({ ok: true });
});

workflowTriggersRouter.post("/schedules/:id/run", async (c) => {
  const result = await c.var.providers.workflowScheduler.fireNow(
    c.var.user.orgId,
    c.req.param("id"),
  );
  if (result === "not_found")
    return c.json({ error: "schedule not found. Confirm the id and that it belongs to this org." }, 404);
  if (result !== "ok") return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

// ── Event triggers ───────────────────────────────────────────────────────

workflowTriggersRouter.post("/event-triggers", async (c) => {
  const { db, plugins } = c.var.providers;
  const user = { id: c.var.user.id, orgId: c.var.user.orgId };
  let body: CreateWorkflowEventTriggerRequest;
  try {
    body = (await c.req.json()) as CreateWorkflowEventTriggerRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object." }, 400);
  }
  const result = await createWorkflowTrigger(db, plugins, user, {
    workflowId: body.workflowId,
    name: body.name,
    eventKeys: body.eventKeys,
    filters: body.filters,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);
  const resp: WorkflowEventTriggerResponse = { trigger: result.trigger };
  return c.json(resp, 201);
});

workflowTriggersRouter.patch("/event-triggers/:id", async (c) => {
  const { db, plugins } = c.var.providers;
  let body: UpdateWorkflowEventTriggerRequest;
  try {
    body = (await c.req.json()) as UpdateWorkflowEventTriggerRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object." }, 400);
  }
  const result = await updateWorkflowTrigger(db, plugins, c.var.user.orgId, c.req.param("id"), body);
  if (!result.ok) {
    const msg =
      result.status === 404
        ? `${result.error} Confirm the id and that it belongs to this org.`
        : result.error;
    return c.json({ error: msg }, result.status);
  }
  const resp: WorkflowEventTriggerResponse = { trigger: result.trigger };
  return c.json(resp);
});

workflowTriggersRouter.delete("/event-triggers/:id", async (c) => {
  const { db } = c.var.providers;
  const result = await deleteWorkflowTrigger(db, c.var.user.orgId, c.req.param("id"));
  if (result === "not_found")
    return c.json({ error: "trigger not found. Confirm the id and that it belongs to this org." }, 404);
  return c.json({ ok: true });
});

export type WorkflowTriggersRouter = typeof workflowTriggersRouter;
