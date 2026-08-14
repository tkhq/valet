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
import { ConflictError, NotFoundError, type DecisionGate, type QueueItem } from "@valet/engine";
import type { AppEnv } from "../env.js";
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
  const { engineStore, eventStream, engineHost } = c.var.providers;
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
  if (body.error !== undefined && typeof body.error !== "string") {
    return c.json({ error: "error must be a string when present" }, 400);
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

  // Unwedge a live gate-blocked session: withdraw every PENDING decision gate
  // that references the now force-settled submission. `sessionFor` alone is a
  // no-op on a cache hit — a live session keeps its in-memory GateManager
  // waiter (the blocked tool) and a dangling PENDING gate row until the
  // 24-72h expiry sweep. Withdrawing here rejects the waiter (turn ends), and
  // the superseded attempt's next fenced write self-fences, so it can't
  // resurrect the gate. We match on the persisted gate's `queueItemId` field
  // rather than parsing gate ids.
  const live = engineHost.liveSession(sessionId);
  if (live) {
    const gates = await engineStore.listDecisionGates(sessionId);
    for (const gate of gates) {
      if (gate.queueItemId !== itemId || gate.status !== "pending") continue;
      // Reject the in-memory tool waiter if this process holds it (no-op
      // otherwise). Session/Thread.withdrawDecision only emits when a live
      // waiter exists, so we durably terminalize + notify below regardless.
      await live.withdrawDecision(gate.id, "cancel");
      const withdrawn: DecisionGate = { ...gate, status: "withdrawn", updatedAt: Date.now() };
      await engineStore.saveDecisionGate(sessionId, gate.threadId, withdrawn);
      // Mirror the engine's own terminal-gate-transition sites (e.g.
      // Thread.terminalizeReconciledGate / steer-supersession cleanup): the
      // `decision_gate` DAG entry must be re-stamped whenever the gate row
      // transitions, or the entry stays stuck on its pre-withdrawal status.
      await engineStore.updateDecisionGateEntry(sessionId, gate.threadId, gate.id, {
        gate: withdrawn,
        withdrawnReason: "cancel",
      });
      // Deterministic eventKey dedupes against Thread.withdrawDecision's own
      // emit in the live-waiter case, so clients see a single frame.
      await eventStream.append(
        {
          sessionId,
          threadId: gate.threadId,
          queueItemId: itemId,
          timestamp: Date.now(),
          event: {
            type: "decision_gate_withdrawn",
            threadId: gate.threadId,
            gateId: gate.id,
            reason: "cancel",
          },
        },
        `gate:${gate.id}:withdrawn`,
      );
    }
  }

  const resp: ForceSettleResponse = {
    submission: toAdminSubmission(settled, sessionId, Date.now()),
  };
  return c.json(resp, 200);
});
