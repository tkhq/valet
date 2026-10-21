import { ChannelDeliveryRejectedError } from "@valet/engine";
import { mapBounded } from "../lib/bounded-map.js";
import type { AppDb } from "../lib/drizzle.js";
import { recordAttentionDeliveryFailure, recordAttentionDeliveryRejected, registerAttentionQueueMetrics } from "../observability/delivery-metrics.js";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { matchesGateOccurrence } from "@valet/workflow";
import { attentionAudience, type AttentionDeps, type AttentionEvent } from "../orchestrator/attention.js";
import { notifications, pendingChannelDeliveries, userNotificationPreferences, workflowCheckpoints, workflowRuns, workflowSignals } from "../schema/index.js";

/** Gates can end before their read marker arrives. Read durable state independently. */
export async function attentionGatePending(deps: AttentionDeps, event: AttentionEvent): Promise<boolean> {
  if (event.gate) {
    if (!event.sessionId) return false;
    const rows = await deps.db.select({ status: sql<string>`status` }).from(sql`engine_decision_gates`)
      .where(sql`id = ${event.gate.id} AND session_id = ${event.sessionId}`).limit(1);
    if (rows[0]?.status !== "pending") return false;
  }
  if (event.workflowGate) {
    const gate = event.workflowGate;
    const [run] = await deps.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, gate.runId)).limit(1);
    if (!run || run.status === "settled" || run.status === "terminalizing") return false;
    const [checkpoint] = await deps.db.select().from(workflowCheckpoints).where(and(
      eq(workflowCheckpoints.runId, gate.runId), eq(workflowCheckpoints.nodeId, gate.nodeId), eq(workflowCheckpoints.iteration, gate.iteration),
    )).limit(1);
    if (checkpoint?.status !== "intent") return false;
    const effects = checkpoint.effects && typeof checkpoint.effects === "object" && !Array.isArray(checkpoint.effects)
      ? Object.fromEntries(Object.entries(checkpoint.effects)) : undefined;
    if (gate.gateId && (effects?.gateId !== gate.gateId)) return false;
    const signalType = `approval:${gate.nodeId}${gate.iteration > 0 ? `:${gate.iteration}` : ""}`;
    const signals = await deps.db.select().from(workflowSignals).where(and(eq(workflowSignals.runId, gate.runId), eq(workflowSignals.signalType, signalType)));
    if (signals.some(signal => matchesGateOccurrence({ runId: signal.runId, signalId: signal.signalId, signalType: signal.signalType, payload: signal.payload, createdAt: signal.createdAt }, effects))) return false;
  }
  return true;
}

/** A stale provider request is ambiguous. Recovery reconciles it before resending. */
export const ATTENTION_SENDING_TIMEOUT_MS = 120_000;

/** Startup may defer claims briefly, but a failed startup must become visible. */
export const ATTENTION_STARTUP_GRACE_MS = 30_000;
const startedAt = new WeakMap<AppDb, number>();
interface DrainRequest {
  deps: AttentionDeps;
  now: number;
  immediateIds?: string[];
  selectAll: boolean;
}
interface DrainState {
  promise: Promise<void>;
  requested?: DrainRequest;
}
/** One bounded batch per transport. Requests during a batch schedule another selection. */
const inFlight = new WeakMap<AppDb, Map<string, DrainState>>();

/** Called by the event rail, or detached after an immediate durable insert. */
export async function drainAttentionDeliveries(deps: AttentionDeps, now = Date.now(), immediateIds?: string[]): Promise<void> {
  registerAttentionQueueMetrics(deps.db);
  if (!startedAt.has(deps.db)) startedAt.set(deps.db, now);
  let running = inFlight.get(deps.db);
  if (!running) { running = new Map(); inFlight.set(deps.db, running); }
  await Promise.all((deps.channels ?? []).map(tier => {
    const request: DrainRequest = { deps: { ...deps, channels: [tier] }, now, immediateIds, selectAll: immediateIds === undefined };
    const existing = running.get(tier.id);
    if (existing) {
      const previous = existing.requested;
      existing.requested = { ...request, now: Math.max(now, previous?.now ?? now),
        selectAll: request.selectAll || previous?.selectAll === true,
        immediateIds: [...new Set([...(previous?.immediateIds ?? []), ...(immediateIds ?? [])])],
      };
      return existing.promise;
    }
    if (tier.enabled?.() !== false && tier.ready?.() === false && now - startedAt.get(deps.db)! < ATTENTION_STARTUP_GRACE_MS) return;
    const state: DrainState = { promise: Promise.resolve() };
    state.promise = (async () => {
      let next: typeof request | undefined = request;
      while (next) {
        state.requested = undefined;
        await drainTier(next);
        next = state.requested;
      }
    })().finally(() => { running.delete(tier.id); });
    running.set(tier.id, state);
    return state.promise;
  }));
}

async function drainTier({ deps, now, immediateIds, selectAll }: DrainRequest): Promise<void> {
  const tier = deps.channels?.[0];
  if (!tier) return;
  const dueCondition = and(
    inArray(pendingChannelDeliveries.status, ["pending", "sending"]),
    lte(pendingChannelDeliveries.deliverAfter, now),
  );
  const due = await deps.db.select().from(pendingChannelDeliveries).where(and(
    dueCondition, eq(pendingChannelDeliveries.tierId, tier.id),
    !selectAll && immediateIds ? inArray(pendingChannelDeliveries.id, immediateIds) : undefined,
  )).orderBy(asc(pendingChannelDeliveries.attempts), asc(pendingChannelDeliveries.deliverAfter)).limit(20);
  await mapBounded(due, 4, async job => {
    const event = job.event;
    const claimedAt = Math.max(now, Date.now());
    // Repeat the due predicate on the outer update to fence concurrent drains.
    // A process crash leaves sending recoverable after the durable deadline.
    const [claimed] = await deps.db.update(pendingChannelDeliveries).set({
      status: "sending", sendingAt: claimedAt,
      firstSendingAt: sql`coalesce(${pendingChannelDeliveries.firstSendingAt}, ${pendingChannelDeliveries.sendingAt}, ${claimedAt})`,
      deliverAfter: claimedAt + ATTENTION_SENDING_TIMEOUT_MS,
      attempts: sql`${pendingChannelDeliveries.attempts} + 1`, lastError: null,
    }).where(and(eq(pendingChannelDeliveries.id, job.id), dueCondition)).returning();
    if (!claimed) return;
    const fence = and(eq(pendingChannelDeliveries.id, job.id), eq(pendingChannelDeliveries.attempts, claimed.attempts), eq(pendingChannelDeliveries.status, "sending"));
    try {
      if (!event) {
        await deps.db.update(pendingChannelDeliveries).set({ status: "dropped", lastError: null }).where(fence);
        console.error(`[attention] dropped job ${job.id}: its event is JSON null`);
        return;
      }
      let handled = tier.enabled?.() === false;
      if (job.notificationId) {
        const [row] = await deps.db.select({ readAt: notifications.readAt }).from(notifications)
          .where(and(eq(notifications.id, job.notificationId), eq(notifications.userId, job.userId))).limit(1);
        handled ||= !row || row.readAt !== null;
      }
      // Immediate producers can run before a workflow finishes parking.
      if (!handled && !immediateIds?.includes(job.id) && !await attentionGatePending(deps, event)) handled = true;
      const [preference] = await deps.db.select().from(userNotificationPreferences).where(and(
        eq(userNotificationPreferences.userId, job.userId), eq(userNotificationPreferences.kind, event.kind),
      )).limit(1);
      if (event.owner.type === "team" && preference?.teamDm !== true) handled = true;
      if (!handled && tier.recipientEnabled && !await tier.recipientEnabled(job.userId)) handled = true;
      // Local terminal state wins even while Slack audience checks are unavailable.
      if (!handled && !(await attentionAudience(deps, event, true)).audience.includes(job.userId)) handled = true;
      if (handled) {
        await deps.db.update(pendingChannelDeliveries).set({ status: "dropped", event: sql`'null'::jsonb`, lastError: null }).where(fence);
        return;
      }
      if (tier.ready?.() === false) throw new Error("Attention transport is not ready. Check channel startup and credentials.");
      let refs;
      if (job.status === "sending" && tier.reconcile) {
        try {
          refs = await tier.reconcile(job.userId, event, { deliveryId: claimed.deliveryToken, sendingAt: claimed.firstSendingAt ?? claimedAt });
        } catch (err) {
          // A lookup failure must not cost a blocking approval notification.
          console.error(`attention reconciliation ${job.id} failed; resending:`, err);
        }
      }
      // The deliverer checks the current per-link notifyAttention setting.
      if (!refs) {
        try {
          refs = await tier.deliver(job.userId, event, { deliveryId: claimed.deliveryToken, sendingAt: claimed.firstSendingAt ?? claimedAt });
        } catch (err) {
          // A timed-out post may have landed. Restore its gate controls now when possible.
          if (!isAttentionTimeout(err) || !tier.reconcile) throw err;
          refs = await tier.reconcile(job.userId, event, { deliveryId: claimed.deliveryToken, sendingAt: claimed.firstSendingAt ?? claimedAt });
          if (!refs) throw err;
        }
      }
      await deps.db.update(pendingChannelDeliveries).set({ status: "sent", messageRefs: refs ?? [], event: sql`'null'::jsonb`, lastError: null }).where(fence);
    } catch (err) {
      const rejections = attentionRejections(err);
      if (rejections) {
        const dropped = await deps.db.update(pendingChannelDeliveries).set({ status: "dropped", event: sql`'null'::jsonb`, lastError: null }).where(fence).returning({ id: pendingChannelDeliveries.id });
        if (dropped.length > 0) for (const rejection of rejections) recordAttentionDeliveryRejected(rejection.channel, rejection.reason);
        return;
      }
      const lastError = (err instanceof Error ? err.message : String(err)).slice(0, 2_000);
      // Expected provider outages remain recoverable. Backoff prevents old
      // failures from filling every batch, without discarding a blocking gate.
      const retryDelay = Math.min(30 * 60_000, ATTENTION_SENDING_TIMEOUT_MS * 2 ** Math.min(claimed.attempts - 1, 4));
      await deps.db.update(pendingChannelDeliveries).set({ lastError, deliverAfter: Math.max(claimedAt, Date.now()) + retryDelay }).where(fence);
      recordAttentionDeliveryFailure(claimed.attempts > 1);
      console.error(`attention delivery ${job.id} failed; retrying after its sending deadline:`, err);
    }
  });
}

/** Channel hosts aggregate provider errors without discarding their original types. */
function isAttentionTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || (err instanceof AggregateError && err.errors.some(isAttentionTimeout)));
}

/** Mixed or unknown failures must retry; one rejected recipient cannot hide a transport outage. */
function attentionRejections(err: unknown): ChannelDeliveryRejectedError[] | undefined {
  if (err instanceof ChannelDeliveryRejectedError) return [err];
  if (!(err instanceof AggregateError) || err.errors.length === 0) return undefined;
  const nested = err.errors.map(attentionRejections);
  return nested.every(rejections => rejections !== undefined) ? nested.flat() : undefined;
}
