/**
 * `/api/workflows/{triggers,schedules,event-triggers,trigger-catalog}`
 * (spec 2026-08-15). Aggregated trigger read + kind-specific writes over
 * `schedule-service` / `trigger-service` / `WorkflowScheduler.fireNow`.
 *
 * MOUNT ORDER MATTERS: this router must be mounted on `/api/workflows`
 * BEFORE `workflowsRouter`, whose `GET /:id` would otherwise swallow
 * `/triggers` as a workflow id.
 */
import { type Appearance, validateAppearance } from "@valet/shared";
import { getLinearIngressStatus } from "../services/linear-ingress.js";
import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import {
  isAuthorizedForOwner,
  parseWorkflowOwnerFilter,
  triggerAccessSets,
  type WorkflowOwner,
} from "../workflows/service.js";
import { resolveCreateOwner } from "../lib/request-principal.js";
import { workflowSchedules } from "../schema/index.js";
import { readableThreads, type ThreadAccessRow } from "./_thread-access.js";
import { isTeamMember } from "../services/teams.js";
import type { TeamServiceReadinessDeps } from "../workflows/team-service-readiness.js";
import {
  createWorkflowSchedule,
  deleteWorkflowSchedule,
  listWorkflowSchedules,
  updateWorkflowSchedule,
  type WorkflowScheduleSummary,
} from "../workflows/schedule-service.js";
import {
  createWorkflowTrigger,
  deleteWorkflowTrigger,
  listEventTypes,
  listWorkflowTriggers,
  updateWorkflowTrigger,
} from "../workflows/trigger-service.js";
import type {
  CreateWorkflowEventTriggerRequest,
  CreateWorkflowScheduleRequest,
  GetWorkflowTriggerCatalogResponse,
  ListWorkflowTriggersResponse,
  UpdateWorkflowEventTriggerRequest,
  UpdateWorkflowScheduleRequest,
  WorkflowEventTriggerResponse,
  WorkflowScheduleResponse,
  WorkflowScheduleThreadRef,
  WorkflowTriggerItem,
} from "../wire/types.js";
import { acceptAppearanceWrite, isAssistantKind } from "../events/target-names.js";

export const workflowTriggersRouter = new Hono<AppEnv>();

/** The caller as a `WorkflowOwner` — one construction for every handler,
 * so a change to the user context or the owner shape lands in one place.
 * The principal rides along: a team key reaches its team's rows only, and
 * keeps reaching them after the creating admin leaves. */
function ownerFrom(c: Context<AppEnv>): WorkflowOwner {
  return { userId: c.var.user.id, orgId: c.var.user.orgId, principal: c.var.principal };
}

/** The credential reads the team arm gate makes before a schedule or a
 * trigger arms (`workflows/team-service-readiness.ts#teamArmBlock`). */
function armDeps(c: Context<AppEnv>): TeamServiceReadinessDeps {
  const { db, engineCredentials, plugins, onePassword } = c.var.providers;
  return { db, credentials: engineCredentials, plugins, onePassword };
}

const CRON_HINT = ' Use 5 fields, for example "0 9 * * 1-5" (09:00 on weekdays).';

/** Cron/timezone service errors get the example appended once. */
function withCronHint(error: string): string {
  return error.includes("cron") ? error + CRON_HINT : error;
}

/** A routine id that is missing, or that the caller may not reach. */
const ROUTINE_NOT_FOUND = "This routine was not found. Refresh Presence and try again.";

/**
 * The thread each assistant routine's firings land on, by schedule id (spec
 * 2026-10-16: presence hub, Part E step 2): the thread the latest firing
 * recorded, or, for the `own` policy with no recorded firing, the thread
 * keyed `schedule:<id>` in the owner's assistant. A thread stays only when
 * this request may open it (`readableThreads`), so a hidden thread reads as
 * null, the same as no thread.
 */
async function routineThreads(
  c: Context<AppEnv>,
  schedules: readonly WorkflowScheduleSummary[],
): Promise<Map<string, WorkflowScheduleThreadRef>> {
  const found = new Map<string, WorkflowScheduleThreadRef>();
  const routines = schedules.filter((s) => s.targetKind === "assistant");
  if (routines.length === 0) return found;
  const { db } = c.var.providers;
  const orgId = c.var.user.orgId;
  const recorded = await db.select({
    id: workflowSchedules.id, sessionId: workflowSchedules.lastFiredSessionId, threadId: workflowSchedules.lastFiredThreadId,
  }).from(workflowSchedules).where(and(eq(workflowSchedules.orgId, orgId), inArray(workflowSchedules.id, routines.map((s) => s.scheduleId))));
  const pairs = new Map<string, { sessionId: string; threadId: string }>();
  for (const row of recorded) {
    if (row.sessionId !== null && row.threadId !== null) pairs.set(row.id, { sessionId: row.sessionId, threadId: row.threadId });
  }
  // An own routine that has not fired since the columns arrived still has its thread.
  const byKey = new Map<string, WorkflowScheduleSummary>();
  for (const s of routines) {
    const mode = s.thread?.mode ?? "own";
    if (!pairs.has(s.scheduleId) && (mode === "own" || mode === "subject")) byKey.set(`schedule:${s.scheduleId}`, s);
  }
  if (pairs.size === 0 && byKey.size === 0) return found;
  const conditions = [
    ...[...pairs.values()].map((p) => sql`(t.session_id = ${p.sessionId} AND t.id = ${p.threadId})`),
    ...(byKey.size > 0 ? [sql`t.key IN (${sql.join([...byKey.keys()].map((key) => sql`${key}`), sql`, `)})`] : []),
  ];
  // A team routine's own thread lives in its execution session, and its
  // governing thread in the root assistant session carries the same key.
  // The execution thread comes first: it holds the firings.
  const result = await db.execute(sql`
    SELECT t.id AS thread_id, t.session_id, t.key, s.org_id, s.status, s.user_id, s.owner_type, s.owner_id,
      st.title, (st.archived_at IS NOT NULL) AS archived, (x.session_id IS NOT NULL OR a.id IS NOT NULL) AS assistant
    FROM engine_threads t
    JOIN agent_sessions s ON s.id = t.session_id
    LEFT JOIN session_threads st ON st.session_id = t.session_id AND st.id = t.id
    LEFT JOIN assistant_executions x ON x.session_id = s.id
    LEFT JOIN assistants a ON a.session_id = s.id
    WHERE (${sql.join(conditions, sql` OR `)}) AND s.org_id = ${orgId} AND s.status <> 'deleted'
    ORDER BY (x.session_id IS NOT NULL) DESC, t.created_at DESC`) as {
    rows: Array<ThreadAccessRow & { assistant: boolean }>;
  };
  const check = readableThreads(c);
  const toWire = async (row: ThreadAccessRow): Promise<WorkflowScheduleThreadRef | null> => {
    const ref = await check(row);
    return ref && { sessionId: ref.sessionId, threadId: ref.threadId, title: ref.title ?? null, archived: ref.archived === true };
  };
  for (const [scheduleId, pair] of pairs) {
    const row = result.rows.find((r) => r.session_id === pair.sessionId && r.thread_id === pair.threadId);
    const ref = row ? await toWire(row) : null;
    if (ref) found.set(scheduleId, ref);
  }
  for (const [key, s] of byKey) {
    // Only the owner's assistant holds the routine's own thread.
    const row = result.rows.find((r) => r.key === key && r.assistant && r.owner_type === s.ownerType && r.owner_id === s.ownerId);
    const ref = row ? await toWire(row) : null;
    if (ref) found.set(s.scheduleId, ref);
  }
  return found;
}

workflowTriggersRouter.get("/triggers", async (c) => {
  const { db } = c.var.providers;
  const owner = ownerFrom(c);
  const workflowId = c.req.query("workflowId") || undefined;

  // Optional `?ownerType=&ownerId=` scope: the hub's flat Triggers tab pins
  // one workspace, the same shape `GET /workflows` and `GET /workflows/runs`
  // take. A filter the caller may not use 404s like one that matches nothing.
  const filter = parseWorkflowOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error) return c.json({ error: filter.error }, 400);
  if (filter.scope && !(await isAuthorizedForOwner(db, owner, filter.scope))) {
    return c.json({ error: "owner not found" }, 404);
  }

  // One access-set build serves both lists (unused when a scope narrows them).
  const sets = filter.scope ? undefined : await triggerAccessSets(db, owner);
  const [schedules, events] = await Promise.all([
    listWorkflowSchedules(db, owner, workflowId, sets, filter.scope),
    listWorkflowTriggers(db, owner, workflowId, sets, filter.scope),
  ]);
  const threads = await routineThreads(c, schedules);
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
        ...(s.thread !== undefined ? { thread: s.thread } : {}),
        input: s.input,
        nextFireAt: s.nextFireAt,
        lastFiredAt: s.lastFiredAt,
        lastFiredThread: s.targetKind === "assistant" ? threads.get(s.scheduleId) ?? null : null,
        ...(s.disabledReason !== undefined ? { disabledReason: s.disabledReason } : {}),
        ownerType: s.ownerType,
        ownerId: s.ownerId,
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

workflowTriggersRouter.get("/trigger-catalog", async (c) => {
  const { db, engineCredentials, plugins } = c.var.providers;
  // The trigger editor reads this catalog. Triggers are subscriptions, which
  // do not accept derived keys (event wakeups spec, Part G).
  const catalog = listEventTypes(plugins).map(item => ({ ...item, entries: item.entries.filter(e => !e.derived) }));
  const linear = catalog.some(item => item.service === "linear")
    ? await getLinearIngressStatus(db,engineCredentials,c.var.user.orgId) : undefined;
  const resp: GetWorkflowTriggerCatalogResponse = {
    catalog: catalog.map(item => item.service === "linear" && linear ? { ...item, readiness: { ready: linear.ready, ...(linear.reason ? { reason: linear.reason } : {}) } } : item),
  };
  return c.json(resp);
});

// `GET /api/workflows/runs` is not here. One cross-workflow run list serves
// the hub's Runs tab and every filtered read, in `routes/workflows.ts`:
// two handlers on one path meant the first mount silently won, and the
// filters, the 404 on an unreadable workflow id, and the cursor checks all
// stopped working.

// ── Schedules ────────────────────────────────────────────────────────────

workflowTriggersRouter.post("/schedules", async (c) => {
  const { db } = c.var.providers;
  const owner = ownerFrom(c);

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
  if (body.target && typeof body.target === "object" && "assistantId" in body.target) return c.json({ error: "Choose a workspace instead of an assistant." }, 400);
  // `orchestrator` is the old value for `assistant`, accepted for one release
  // (spec 2026-10-16: presence hub, Part H).
  if (!body.target || (body.target.kind !== "workflow" && !isAssistantKind(body.target.kind))) {
    return c.json(
      {
        error:
          'target.kind must be "workflow" (start a run) or "assistant" (send a prompt). Set target.kind to one of them.',
      },
      400,
    );
  }
  // An assistant-prompt schedule created in a team workspace fires the
  // TEAM's assistant, so it is team-owned. `resolveCreateOwner` settles the
  // owner before anything is written: a cookie caller's team id needs live
  // membership (a non-member's id 404s like an unknown one), a personal key
  // cannot name a team, and a team key always schedules as its own team. A
  // workflow-target schedule ignores teamId (its owner follows the workflow).
  let teamId: string | undefined;
  if (body.target.kind !== "workflow") {
    const created = await resolveCreateOwner({
      principal: c.var.principal,
      authVia: c.var.authVia,
      bodyTeamId: body.teamId,
      userId: owner.userId,
      isTeamMember: (id) => isTeamMember(db, id, owner.userId),
    });
    if (!created.ok) return c.json({ error: created.error }, created.status);
    teamId = created.owner.type === "team" ? created.owner.id : undefined;
  }

  const result = await createWorkflowSchedule(armDeps(c), owner, {
    name: body.name,
    cron: body.cron,
    timezone: body.timezone,
    workflowId: body.target.kind === "workflow" ? body.target.workflowId : undefined,
    prompt: body.target.kind !== "workflow" ? body.target.prompt : undefined,
    input: body.target.kind === "workflow" ? body.target.input : undefined,
    teamId,
    thread: body.thread,
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
  const owner = ownerFrom(c);
  const result = await updateWorkflowSchedule(armDeps(c), owner, c.req.param("id"), body);
  if (!result.ok) {
    const msg =
      result.status === 404
        ? ROUTINE_NOT_FOUND
        : withCronHint(result.error);
    return c.json({ error: msg }, result.status);
  }
  const resp: WorkflowScheduleResponse = { schedule: result.schedule };
  return c.json(resp);
});

workflowTriggersRouter.delete("/schedules/:id", async (c) => {
  const { db } = c.var.providers;
  const owner = ownerFrom(c);
  const result = await deleteWorkflowSchedule(db, owner, c.req.param("id"));
  if (result === "not_found") return c.json({ error: ROUTINE_NOT_FOUND }, 404);
  return c.json({ ok: true });
});

workflowTriggersRouter.post("/schedules/:id/run", async (c) => {
  const result = await c.var.providers.workflowScheduler.fireNow(ownerFrom(c), c.req.param("id"));
  if (result === "not_found")
    return c.json({ error: ROUTINE_NOT_FOUND }, 404);
  if (result !== "ok") return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

// ── Event triggers ───────────────────────────────────────────────────────

workflowTriggersRouter.post("/event-triggers", async (c) => {
  const owner = ownerFrom(c);
  let body: CreateWorkflowEventTriggerRequest;
  try {
    body = (await c.req.json()) as CreateWorkflowEventTriggerRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object." }, 400);
  }
  // `presence` is the old name, accepted for one release (spec 2026-10-16:
  // presence hub, Part H).
  const appearanceWrite = acceptAppearanceWrite(body);
  if (!appearanceWrite.ok) return c.json({ error: appearanceWrite.error }, 400);
  if (appearanceWrite.appearance !== undefined) {
    const error = validateAppearance(appearanceWrite.appearance);
    if (error) return c.json({ error }, 400);
  }
  const result = await createWorkflowTrigger(armDeps(c), owner, {
    // `validateAppearance` accepted the value above.
    appearance: appearanceWrite.appearance as Appearance | undefined,
    workflowId: body.workflowId,
    name: body.name,
    eventKeys: body.eventKeys,
    filters: body.filters,
    anyChannel: body.anyChannel,
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
  const owner = ownerFrom(c);
  const result = await updateWorkflowTrigger(armDeps(c), owner, c.req.param("id"), body);
  if (!result.ok) {
    const msg =
      result.status === 404 ? ROUTINE_NOT_FOUND : result.error;
    return c.json({ error: msg }, result.status);
  }
  const resp: WorkflowEventTriggerResponse = { trigger: result.trigger };
  return c.json(resp);
});

workflowTriggersRouter.delete("/event-triggers/:id", async (c) => {
  const { db } = c.var.providers;
  const owner = ownerFrom(c);
  const result = await deleteWorkflowTrigger(db, owner, c.req.param("id"));
  if (result === "not_found")
    return c.json({ error: ROUTINE_NOT_FOUND }, 404);
  return c.json({ ok: true });
});
