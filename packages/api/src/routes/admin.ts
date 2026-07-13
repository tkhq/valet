/**
 * Operator surface — admin-only submission inspection + force-settle.
 *
 * Lifecycle-only: `AdminSubmission` never carries `content` (prompt bodies
 * may hold user data; the operator list is for diagnosing wedged/zombie
 * submissions, not reading transcripts).
 *
 *   GET  /api/admin/submissions                              → list unsettled submissions (optionally scoped to ?sessionId=)
 *   POST /api/admin/submissions/:sessionId/:itemId/force-settle → CAS force-settle a wedged submission
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { ConflictError, NotFoundError, type QueueItem } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions } from "../schema/index.js";
import type {
  AdminSubmission,
  ForceSettleRequest,
  ForceSettleResponse,
  ListAdminSubmissionsResponse,
} from "../wire/types.js";

export const adminRouter = new Hono<AppEnv>();

adminRouter.use("*", async (c, next) => {
  if (c.var.user.role !== "admin") return c.json({ error: "admin only", code: "forbidden" }, 403);
  await next();
});

function toAdminSubmission(item: QueueItem, sessionId: string, now: number): AdminSubmission {
  return {
    id: item.id,
    sessionId,
    threadId: item.threadId,
    status: item.status,
    outcome: item.outcome?.outcome,
    error: item.outcome?.error,
    attemptId: item.attemptId,
    attemptCount: item.attemptCount,
    maxAttempts: item.maxAttempts,
    ownerId: item.ownerId,
    leaseExpiresAt: item.leaseExpiresAt,
    leaseExpired: item.leaseExpiresAt != null && item.leaseExpiresAt < now,
    timeoutAt: item.timeoutAt,
    abortRequestedAt: item.abortRequestedAt,
    supersededByItemId: item.supersededByItemId,
    mergedIntoItemId: item.mergedIntoItemId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// ── List ──────────────────────────────────────────────────────────────────

adminRouter.get("/submissions", async (c) => {
  const { engineStore } = c.var.providers;
  const sessionId = c.req.query("sessionId") || undefined;
  const now = Date.now();

  const submissions = sessionId
    ? (await engineStore.listUnsettledSubmissions(sessionId)).map((item) =>
        toAdminSubmission(item, sessionId, now),
      )
    : (await engineStore.listAllUnsettledSubmissions()).map((item) =>
        toAdminSubmission(item, item.sessionId, now),
      );

  const body: ListAdminSubmissionsResponse = { submissions };
  return c.json(body);
});

// ── Force-settle ─────────────────────────────────────────────────────────

adminRouter.post("/submissions/:sessionId/:itemId/force-settle", async (c) => {
  const { db, engineStore, eventStream, engineHost } = c.var.providers;
  const sessionId = c.req.param("sessionId");
  const itemId = c.req.param("itemId");

  let body: ForceSettleRequest;
  try {
    body = (await c.req.json()) as ForceSettleRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.outcome !== "failed" && body.outcome !== "aborted") {
    return c.json({ error: "outcome must be 'failed' or 'aborted'" }, 400);
  }

  let settled: QueueItem;
  try {
    settled = await engineStore.forceSettle(sessionId, itemId, body.outcome, body.error);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message, code: "not_found" }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message, code: "conflict" }, 409);
    throw err;
  }

  await eventStream.append(
    {
      sessionId,
      threadId: settled.threadId,
      queueItemId: itemId,
      timestamp: Date.now(),
      event: {
        type: "submission_settled",
        sessionId,
        threadId: settled.threadId,
        queueItemId: itemId,
        outcome: { outcome: body.outcome, error: body.error },
      },
    },
    `settled:${itemId}`,
  );

  // Nudge a live in-memory session so any wedged claim loop / awaiter
  // reconciles against the now-settled store state.
  if (engineHost.isLive(sessionId)) {
    const row = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
    if (row) {
      await engineHost.sessionFor(sessionId, {
        userId: row.userId,
        orgId: row.orgId,
        workspace: row.workspace,
      });
    }
  }

  const resp: ForceSettleResponse = {
    submission: toAdminSubmission(settled, sessionId, Date.now()),
  };
  return c.json(resp, 200);
});

export type AdminRouter = typeof adminRouter;
