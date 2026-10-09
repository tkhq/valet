/**
 * Background work routes (spec 2026-10-08, fix wave 2 H8): a person sees and
 * stops the wakeups and leases of a session.
 *
 * - `GET /api/sessions/:id/wakeups` lists the open wakeups and active leases.
 * - `POST /api/sessions/:id/wakeups/:wakeupId/cancel` cancels one wakeup
 *   (`wk_`) or hold lease (`ls_`) as a human cancel: the agent receives the
 *   terminal signal with `cause=cancelled` (spec B6).
 *
 * Authorization: the list gates on `canViewSessionWakeups` (who may view the
 * session). The cancel gates on `canCancelSessionWakeup`, the same rule as
 * pause: stopping work that holds the sandbox is an administrative act on
 * the session, never inherited from view access. On a team session both
 * routes also hide work whose thread the caller cannot see.
 */
import { Hono, type Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { Lease, Wakeup } from "@valet/engine";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import type { RequestPrincipal } from "../lib/request-principal.js";
import { agentSessions } from "../schema/index.js";
import { canAdministerSession, canViewSession, type SessionOwnerLike } from "../services/session-access.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { cancelWorkAsHuman, listBackgroundWork } from "../engine/wakeups-admin.js";
import { keepVisibleThreads, spawnedFromVisibleThread } from "./_thread-access.js";
import type {
  CancelSessionWakeupResponse,
  LeaseSummary,
  ListSessionWakeupsResponse,
  WakeupSummary,
} from "../wire/types.js";

export const wakeupsRouter = new Hono<AppEnv>();

/** True when `caller` may list a session's background work: anyone who may view the session. */
export async function canViewSessionWakeups(db: AppDb, session: SessionOwnerLike, caller: RequestPrincipal): Promise<boolean> {
  return canViewSession(db, session, caller);
}

/**
 * True when `caller` may cancel a session's background work, from this route,
 * from a forced pause or replace, or from a thread archive. The rule matches
 * pause (`canAdministerSession`) on purpose: a cancel kills a process the
 * agent started and can free a sandbox someone else relies on. It is a
 * separate, named check so a future divergence is deliberate.
 */
export async function canCancelSessionWakeup(db: AppDb, session: SessionOwnerLike, caller: RequestPrincipal): Promise<boolean> {
  return canAdministerSession(db, session, caller);
}

function wakeupToSummary(w: Wakeup): WakeupSummary {
  return {
    id: w.id,
    threadId: w.threadId,
    kind: w.kind,
    // The listing reads only open rows.
    status: w.status === "pending" ? "pending" : "running",
    reason: w.reason,
    ...(w.deadlineAt !== undefined ? { deadlineAt: w.deadlineAt } : {}),
    ...(w.fireAt !== undefined ? { fireAt: w.fireAt } : {}),
    createdAt: w.createdAt,
  };
}

function leaseToSummary(l: Lease): LeaseSummary {
  return {
    id: l.id,
    ...(l.threadId !== undefined ? { threadId: l.threadId } : {}),
    ownerKind: l.ownerKind,
    ...(l.ownerId !== undefined ? { ownerId: l.ownerId } : {}),
    reason: l.reason,
    deadlineAt: l.deadlineAt,
    createdAt: l.createdAt,
  };
}

/** The session row when it is open (active or hibernated) and in the caller's org. */
async function loadOpenSession(c: Context<AppEnv>, id: string) {
  const rows = await c.var.providers.db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), inArray(agentSessions.status, ["active", "hibernated"])))
    .limit(1);
  const row = rows[0];
  return row && row.orgId === c.var.user.orgId ? row : undefined;
}

wakeupsRouter.get("/:id/wakeups", async (c) => {
  const { db, engineStore } = c.var.providers;
  const id = c.req.param("id");
  const row = await loadOpenSession(c, id);
  if (!row || !(await canViewSessionWakeups(db, row, c.var.principal)) || !(await spawnedFromVisibleThread(c, row))) {
    return c.json({ error: "session not found" }, 404);
  }
  const work = await listBackgroundWork(engineStore, id);
  const owner = { type: row.ownerType };
  const body: ListSessionWakeupsResponse = {
    wakeups: (await keepVisibleThreads(c, owner, work.wakeups)).map(wakeupToSummary),
    leases: (await keepVisibleThreads(c, owner, work.leases)).map(leaseToSummary),
  };
  return c.json(body);
});

wakeupsRouter.post("/:id/wakeups/:wakeupId/cancel", async (c) => {
  const { db, engineHost, engineStore } = c.var.providers;
  const id = c.req.param("id");
  const wakeupId = c.req.param("wakeupId");
  const row = await loadOpenSession(c, id);
  if (!row || !(await canCancelSessionWakeup(db, row, c.var.principal)) || !(await spawnedFromVisibleThread(c, row))) {
    return c.json({ error: "session not found" }, 404);
  }

  // The target must be open work of this session on a thread the caller can see.
  const work = await listBackgroundWork(engineStore, id);
  const owner = { type: row.ownerType };
  const target =
    (await keepVisibleThreads(c, owner, work.wakeups)).find((w) => w.id === wakeupId) ??
    (await keepVisibleThreads(c, owner, work.leases)).find((l) => l.id === wakeupId);
  if (!target) {
    return c.json({ error: "background work not found. It may have ended already. Reload the list." }, 404);
  }

  const session = await engineHost.sessionFor(id, await loadSessionMeta(db, row));
  const result = await cancelWorkAsHuman(engineStore, session, id, wakeupId, {
    actorUserId: c.var.user.id,
    signal: "deliver",
  });
  if (result.kind === "not_found") {
    return c.json({ error: "background work not found. It may have ended already. Reload the list." }, 404);
  }
  const body: CancelSessionWakeupResponse = { cancelled: { id: result.work.id, kind: result.work.kind } };
  return c.json(body);
});
