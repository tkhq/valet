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
import {
  backgroundWorkRefusal,
  cancelWorkAsHuman,
  listBackgroundWork,
  selectWork,
  type BackgroundWorkAction,
  type BackgroundWorkFilter,
  type BlockingWork,
} from "../engine/wakeups-admin.js";
import { keepVisibleThreads, spawnedFromVisibleThread } from "./_thread-access.js";
import type {
  BackgroundWorkConflict,
  BackgroundWorkItem,
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

/** The outcome of `gateBackgroundWork`. */
export type BackgroundWorkGate =
  /** No work blocks the action. */
  | { kind: "clear" }
  /** The route returns `response` (409 or 403) and changes nothing. */
  | { kind: "refused"; response: Response }
  /** The caller forced the action. Cancel exactly `ids`, then act. */
  | { kind: "force"; ids: ReadonlySet<string> };

function toWorkItem(w: BlockingWork): BackgroundWorkItem {
  return {
    id: w.id,
    kind: w.kind,
    reason: w.reason,
    ...(w.threadId !== undefined ? { threadId: w.threadId } : {}),
    ...(w.deadlineAt !== undefined ? { deadlineAt: w.deadlineAt } : {}),
    ...(w.fireAt !== undefined ? { fireAt: w.fireAt } : {}),
    createdAt: w.createdAt,
  };
}

/**
 * The one rule for an action that would stop background work (fix wave 3,
 * group C): pause, replace, a profile change, an owner move, and a thread
 * archive. Work that `filter` selects blocks the action with a 409
 * `BackgroundWorkConflict`. `force` lets the caller stop the work first,
 * when the caller passes `canCancelSessionWakeup` (else 403) and can see
 * every item (else 409). On a team session the text and the work list name
 * only work on threads the caller can see, and count the rest: a forced
 * stop of work the caller cannot see would act on a private thread.
 */
export async function gateBackgroundWork(
  c: Context<AppEnv>,
  row: SessionOwnerLike & { id: string; ownerType: string },
  action: BackgroundWorkAction,
  filter: BackgroundWorkFilter,
  force: boolean,
): Promise<BackgroundWorkGate> {
  const { db, engineStore } = c.var.providers;
  const items = selectWork(await listBackgroundWork(engineStore, row.id), filter);
  if (items.length === 0) return { kind: "clear" };
  const visible = await keepVisibleThreads(
    c,
    { type: row.ownerType },
    items.map((w) => ({ ...w, sessionId: row.id })),
  );
  const hiddenCount = items.length - visible.length;
  const mayCancel = await canCancelSessionWakeup(db, row, c.var.principal);
  const forceAllowed = mayCancel && hiddenCount === 0;
  if (force && forceAllowed) return { kind: "force", ids: new Set(visible.map((w) => w.id)) };
  const body: BackgroundWorkConflict = {
    error: backgroundWorkRefusal(action, visible, hiddenCount, forceAllowed),
    code: "background_work",
    work: visible.map(toWorkItem),
    hiddenCount,
    forceAllowed,
  };
  return { kind: "refused", response: c.json(body, force && !mayCancel ? 403 : 409) };
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
