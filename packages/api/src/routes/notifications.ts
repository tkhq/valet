/**
 * Notifications — web delivery surface for the attention router (Phase 4
 * decision 19).
 *
 *   GET  /api/notifications?unread=1     → caller's own rows, newest first, limit 50
 *   POST /api/notifications/:id/read     → mark one of the caller's own rows read
 *   POST /api/notifications/read-all     → mark every unread row of the caller's read
 *   GET  /api/notifications/preferences  → caller's web-delivery preference per kind
 *   PUT  /api/notifications/preferences  → upsert caller's preference for one kind
 *
 * Own-rows-only: every route scopes by `c.var.user.id`. A caller can never
 * see or mark another user's notification — an `:id` belonging to someone
 * else 404s, same existence-hiding treatment used elsewhere in this
 * package (teams.ts) for cross-tenant access.
 *
 * Preferences mirror `isWebEnabled`'s default in `orchestrator/attention.ts`:
 * a kind with no row reports `web: true` and `teamDm: false`.
 */
import { decryptSecret, deriveSecretKey, encryptSecret } from "../lib/secret-crypto.js";
import { Hono } from "hono";
import { and, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { NotFoundError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import { agentSessions, workflowRuns, workflowDefinitions, notifications, userNotificationPreferences, type NotificationRow } from "../schema/index.js";
import { canResolveSessionGate, gateApprover } from "../services/session-access.js";
import { engineGateToWire } from "../engine/bridge.js";
import type { WorkflowRunOrigin } from "@valet/workflow";
import { runVisible, threadsVisibleTo } from "./_thread-access.js";
import type {
  ListNotificationPreferencesResponse,
  ListNotificationsResponse,
  ListNotificationDecisionsResponse,
  NotificationKind,
  NotificationSummary,
  SetNotificationPreferenceRequest,
} from "../wire/types.js";

export const notificationsRouter = new Hono<AppEnv>();

/** Read durable gates without waking their sessions or relying on notification read state. */
notificationsRouter.get("/decisions", async (c) => {
  const { db, engineStore } = c.var.providers;
  const caller = c.var.principal;
  // The same reach canViewSession grants, as SQL, so each poll reads only the
  // caller's own and team sessions instead of every pending gate in the org.
  // canResolveSessionGate below stays the authority.
  const reachable = (ownerType: SQL, ownerId: SQL, userId: SQL) => caller.type === "team"
    ? sql`(${ownerType} = 'team' AND ${ownerId} = ${caller.id})`
    : sql`((${ownerType} = 'team' AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = ${ownerId} AND tm.user_id = ${caller.id}))
        OR (${ownerType} <> 'team' AND ${userId} = ${caller.id}))`;
  const encodedCursor = c.req.query("cursor");
  const cursorKey = deriveSecretKey(JSON.stringify(["approval-inbox", c.var.providers.encryptionKey, c.var.user.orgId, caller.type, caller.id]));
  let cursor: { createdAt: number; id: string } | undefined;
  try {
    if (encodedCursor && encodedCursor.length <= 65_536) {
      const decoded: unknown = JSON.parse(decryptSecret(Buffer.from(encodedCursor, "base64url").toString("utf8"), cursorKey));
      if (Array.isArray(decoded) && decoded.length === 2 && typeof decoded[0] === "number" && Number.isSafeInteger(decoded[0])
        && decoded[0] >= 0 && typeof decoded[1] === "string" && decoded[1].length > 0) {
        cursor = { createdAt: decoded[0], id: decoded[1] };
      }
    }
  } catch { /* Invalid or foreign cursors fail below. */ }
  if (encodedCursor && !cursor) {
    return c.json({ error: "Invalid approval cursor. Reload notifications and try again." }, 400);
  }
  const after = cursor ? sql`(g.created_at, g.id COLLATE "C") > (${cursor.createdAt}, ${cursor.id} COLLATE "C")` : sql`TRUE`;
  const pending = and(sql`g.status = 'pending'`, after);
  const gateFields = { id: sql<string>`g.id`, createdAt: sql<number>`g.created_at`.mapWith(Number) };
  const limit = 100;
  // Page gates, not sessions: a single parked session can contain many gates.
  const [appRows, workflowRows] = await Promise.all([
    db.select({ ...gateFields, session: agentSessions }).from(sql`engine_decision_gates g`)
      .innerJoin(agentSessions, sql`${agentSessions.id} = g.session_id`)
      .where(and(pending, eq(agentSessions.orgId, c.var.user.orgId), ne(agentSessions.status, "deleted"),
        reachable(sql`${agentSessions.ownerType}`, sql`${agentSessions.ownerId}`, sql`${agentSessions.userId}`)))
      .orderBy(sql`g.created_at`, sql`g.id COLLATE "C"`).limit(limit + 1),
    db.select({ ...gateFields,
      sessionId: sql<string>`g.session_id`, ownerType: workflowRuns.ownerType, ownerId: workflowRuns.ownerId,
      title: workflowDefinitions.name, origin: sql<WorkflowRunOrigin | null>`${workflowRuns.params}->'origin'`,
      actorUserId: workflowRuns.actorUserId, input: sql<unknown>`${workflowRuns.params}->'input'`,
    }).from(sql`engine_decision_gates g`)
      .innerJoin(workflowRuns, sql`${workflowRuns.id} = split_part(g.session_id, ':', 2)`)
      .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
      .where(and(pending, eq(workflowDefinitions.orgId, c.var.user.orgId), sql`g.session_id LIKE 'wf:%'`,
        sql`NOT EXISTS (SELECT 1 FROM agent_sessions a WHERE a.id = g.session_id)`,
        reachable(sql`${workflowRuns.ownerType}`, sql`${workflowRuns.ownerId}`, sql`${workflowRuns.ownerId}`)))
      .orderBy(sql`g.created_at`, sql`g.id COLLATE "C"`).limit(limit + 1),
  ]);
  const candidates = [
    ...appRows.map(row => ({ ...row, kind: "app" as const })),
    ...workflowRows.map(row => ({ ...row, kind: "workflow" as const })),
  ].sort((a, b) => a.createdAt - b.createdAt || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
  const page = candidates.slice(0, limit);
  const items: ListNotificationDecisionsResponse["items"] = [];
  const authority = new Map<string, Promise<boolean>>();
  const visibility = new Map<string, Promise<boolean>>();
  // Limit concurrent authorization/store work; never hydrate or wake an agent.
  for (let offset = 0; offset < page.length; offset += 10) {
    const batch = await Promise.all(page.slice(offset, offset + 10).map(async row => {
      const session = row.kind === "app" ? row.session : {
        ownerType: row.ownerType, ownerId: row.ownerId, userId: row.ownerType === "user" ? row.ownerId : "",
      };
      const sessionId = row.kind === "app" ? row.session.id : row.sessionId;
      if (!authority.has(sessionId)) authority.set(sessionId, canResolveSessionGate(db, session, caller));
      if (!await authority.get(sessionId)) return null;
      const gate = await engineStore.getDecisionGate(sessionId, row.id);
      if (!gate || gate.status !== "pending") return null;
      const approver = gateApprover(gate);
      if (approver && (caller.type !== "user" || approver.userId !== caller.id)) return null;
      const key = JSON.stringify([sessionId, gate.threadId]);
      if (!visibility.has(key)) visibility.set(key, row.kind === "app"
        ? engineStore.getThread(sessionId, gate.threadId).then(thread => thread ? threadsVisibleTo(c, session)(thread.key) : false)
        : runVisible(c, { ownerType: row.ownerType, origin: row.origin, actorUserId: row.actorUserId, params: { input: row.input } }));
      const canOpenThread = await visibility.get(key) ?? false;
      if (!approver && !canOpenThread) return null;
      return { canOpenThread, sessionId, title: row.kind === "app" ? row.session.title || "Thread approval" : row.title,
        gate: engineGateToWire(gate) };
    }));
    items.push(...batch.filter(item => item !== null));
  }
  const last = page.at(-1);
  // Advance past hidden candidates too, without exposing their identifiers.
  const nextCursor = candidates.length > limit && last ? Buffer.from(encryptSecret(JSON.stringify([last.createdAt, last.id]), cursorKey)).toString("base64url") : null;
  return c.json({ items, nextCursor } satisfies ListNotificationDecisionsResponse);
});

const NOTIFICATION_KINDS: NotificationKind[] = ["notification", "question", "escalation", "approval", "review"];

function rowToSummary(row: NotificationRow): NotificationSummary {
  return {
    id: row.id,
    kind: row.kind as NotificationSummary["kind"],
    urgency: row.urgency as NotificationSummary["urgency"],
    title: row.title,
    body: row.body ?? undefined,
    href: row.href ?? undefined,
    sessionId: row.sessionId ?? undefined,
    createdAt: row.createdAt,
    readAt: row.readAt ?? undefined,
  };
}

notificationsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;
  const unreadOnly = c.req.query("unread") === "1";

  const rows = await db
    .select()
    .from(notifications)
    .where(
      unreadOnly
        ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
        : eq(notifications.userId, userId),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(50);

  const body: ListNotificationsResponse = { notifications: rows.map(rowToSummary) };
  return c.json(body);
});

notificationsRouter.post("/:id/read", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;
  const id = c.req.param("id");

  const rows = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.userId !== userId) {
    const err = new NotFoundError("notification", id);
    return c.json({ error: err.message, code: err.code }, 404);
  }

  await db
    .update(notifications)
    .set({ readAt: row.readAt ?? Date.now() })
    .where(eq(notifications.id, id));

  return c.json({ ok: true });
});

notificationsRouter.post("/read-all", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;

  await db
    .update(notifications)
    .set({ readAt: Date.now() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

  return c.json({ ok: true });
});

notificationsRouter.get("/preferences", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;

  const rows = await db
    .select()
    .from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.userId, userId));
  const byKind = new Map(rows.map((r) => [r.kind, r]));

  const preferences = NOTIFICATION_KINDS.map((kind) => ({
    kind,
    web: byKind.get(kind)?.web ?? true,
    teamDm: byKind.get(kind)?.teamDm ?? false,
  }));

  const body: ListNotificationPreferencesResponse = { preferences };
  return c.json(body);
});

notificationsRouter.put("/preferences", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;

  let body: SetNotificationPreferenceRequest;
  try {
    body = (await c.req.json()) as SetNotificationPreferenceRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body === null || typeof body !== "object") return c.json({ error: "body must be an object" }, 400);
  if (!NOTIFICATION_KINDS.includes(body.kind)) {
    return c.json({ error: `kind must be one of ${NOTIFICATION_KINDS.join(", ")}` }, 400);
  }
  if (typeof body.web !== "boolean") {
    return c.json({ error: "web must be a boolean" }, 400);
  }

  if (body.teamDm !== undefined && typeof body.teamDm !== "boolean") {
    return c.json({ error: "teamDm must be a boolean. Choose whether to receive team direct messages." }, 400);
  }

  await db
    .insert(userNotificationPreferences)
    .values({ userId, kind: body.kind, web: body.web, teamDm: body.teamDm ?? false })
    .onConflictDoUpdate({
      target: [userNotificationPreferences.userId, userNotificationPreferences.kind],
      set: { web: body.web, ...(body.teamDm === undefined ? {} : { teamDm: body.teamDm }) },
    });

  return c.json({ ok: true });
});
