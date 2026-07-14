/**
 * Notifications — web delivery surface for the attention router (Phase 4
 * decision 19).
 *
 *   GET  /api/notifications?unread=1  → caller's own rows, newest first, limit 50
 *   POST /api/notifications/:id/read  → mark one of the caller's own rows read
 *   POST /api/notifications/read-all  → mark every unread row of the caller's read
 *
 * Own-rows-only: every route scopes by `c.var.user.id`. A caller can never
 * see or mark another user's notification — an `:id` belonging to someone
 * else 404s, same existence-hiding treatment used elsewhere in this
 * package (teams.ts) for cross-tenant access.
 */
import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { NotFoundError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import { notifications, type NotificationRow } from "../schema/index.js";
import type { ListNotificationsResponse, NotificationSummary } from "../wire/types.js";

export const notificationsRouter = new Hono<AppEnv>();

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
    .limit(50)
    .all();

  const body: ListNotificationsResponse = { notifications: rows.map(rowToSummary) };
  return c.json(body);
});

notificationsRouter.post("/:id/read", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;
  const id = c.req.param("id");

  const row = await db.select().from(notifications).where(eq(notifications.id, id)).get();
  if (!row || row.userId !== userId) {
    const err = new NotFoundError("notification", id);
    return c.json({ error: err.message, code: err.code }, 404);
  }

  await db
    .update(notifications)
    .set({ readAt: row.readAt ?? Date.now() })
    .where(eq(notifications.id, id))
    .run();

  return c.json({ ok: true });
});

notificationsRouter.post("/read-all", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;

  await db
    .update(notifications)
    .set({ readAt: Date.now() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .run();

  return c.json({ ok: true });
});
