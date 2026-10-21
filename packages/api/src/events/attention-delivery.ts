import { ChannelDeliveryRejectedError } from "@valet/engine";
import { mapBounded } from "../lib/bounded-map.js";
import type { AppDb } from "../lib/drizzle.js";
import { recordAttentionDeliveryFailure, recordAttentionDeliveryRejected, registerAttentionQueueMetrics } from "../observability/delivery-metrics.js";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { matchesGateOccurrence } from "@valet/workflow";
import { attentionRecipientAllowed, type AttentionChannelDeliverer, type AttentionDeps, type AttentionEvent } from "../orchestrator/attention.js";
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
/** A stuck provider or storage promise must release the in-memory tier lock before its lease expires. */
export const ATTENTION_BATCH_TIMEOUT_MS = 90_000;
/** Trust producer-before-parking state only during this short enqueue window. */
export const ATTENTION_IMMEDIATE_GATE_GRACE_MS = 5_000;
const startedAt = new WeakMap<AppDb, number>();
interface DrainState {
  promise: Promise<void>;
  now: number;
  immediateIds: Set<string>;
  requested: boolean;
}
/** One bounded batch per transport. Requests during a batch schedule another selection. */
const inFlight = new WeakMap<AppDb, Map<string, DrainState>>();
/** Outbox-owned providers, not cached authorization results. Access-less producers cannot remove them. */
const authorizationProviders = new WeakMap<AppDb, NonNullable<AttentionDeps["access"]>>();

/** Called by the event rail, or detached after an immediate durable insert. */
export async function drainAttentionDeliveries(deps: AttentionDeps, now = Date.now(), immediateIds?: string[]): Promise<void> {
  registerAttentionQueueMetrics(deps.db);
  if (deps.access) {
    authorizationProviders.set(deps.db, { ...deps.access, onePassword: deps.access.onePassword ?? authorizationProviders.get(deps.db)?.onePassword });
  }
  if (!startedAt.has(deps.db)) startedAt.set(deps.db, now);
  let running = inFlight.get(deps.db);
  if (!running) { running = new Map(); inFlight.set(deps.db, running); }
  await Promise.all((deps.channels ?? []).map(tier => {
    const existing = running.get(tier.id);
    if (existing) {
      existing.now = Math.max(now, existing.now);
      for (const id of immediateIds ?? []) existing.immediateIds.add(id);
      existing.requested = true;
      return existing.promise;
    }
    if (tier.enabled?.() !== false && tier.ready?.() === false && now - startedAt.get(deps.db)! < ATTENTION_STARTUP_GRACE_MS) return;
    const state: DrainState = { promise: Promise.resolve(), now, immediateIds: new Set(immediateIds), requested: true };
    state.promise = (async () => {
      while (state.requested) {
        state.requested = false;
        const ids = state.immediateIds;
        state.immediateIds = new Set();
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            drainTier(deps, tier, state.now, ids, controller.signal),
            new Promise<void>(resolve => {
              timer = setTimeout(() => {
                controller.abort();
                recordAttentionDeliveryFailure(true);
                console.error(`[attention] batch ${tier.id} timed out; check provider and database health. Claimed jobs remain recoverable.`);
                resolve();
              }, ATTENTION_BATCH_TIMEOUT_MS);
            }),
          ]);
        } catch (err) {
          recordAttentionDeliveryFailure(false);
          console.error(`[attention] ${tier.id} selection failed; retry the drain:`, err);
        } finally { clearTimeout(timer); }
      }
    })().finally(() => { running.delete(tier.id); });
    running.set(tier.id, state);
    return state.promise;
  }));
}

async function drainTier(deps: AttentionDeps, tier: AttentionChannelDeliverer, now: number, immediateIds: Set<string>, signal: AbortSignal): Promise<void> {
  const dueCondition = and(
    inArray(pendingChannelDeliveries.status, ["pending", "sending"]),
    lte(pendingChannelDeliveries.deliverAfter, now),
  );
  const due = await deps.db.select().from(pendingChannelDeliveries).where(and(
    dueCondition, eq(pendingChannelDeliveries.tierId, tier.id),
  )).orderBy(asc(pendingChannelDeliveries.attempts), asc(pendingChannelDeliveries.deliverAfter)).limit(20);
  await mapBounded(due, 4, async job => {
    if (signal.aborted) return;
    const event = job.event;
    let claimed: typeof pendingChannelDeliveries.$inferSelect | undefined;
    const claimedAt = Math.max(now, Date.now());
    try {
      // Repeat the due predicate on the outer update to fence concurrent drains.
      // A process crash leaves sending recoverable after the durable deadline.
      [claimed] = await deps.db.update(pendingChannelDeliveries).set({
        status: "sending", sendingAt: claimedAt,
        firstSendingAt: sql`coalesce(${pendingChannelDeliveries.firstSendingAt}, ${pendingChannelDeliveries.sendingAt}, ${claimedAt})`,
        deliverAfter: claimedAt + ATTENTION_SENDING_TIMEOUT_MS,
        attempts: sql`${pendingChannelDeliveries.attempts} + 1`, lastError: null,
      }).where(and(eq(pendingChannelDeliveries.id, job.id), dueCondition)).returning();
      if (!claimed || signal.aborted) return;
      const fence = and(eq(pendingChannelDeliveries.id, job.id), eq(pendingChannelDeliveries.attempts, claimed.attempts), eq(pendingChannelDeliveries.status, "sending"));
      if (!event) {
        await deps.db.update(pendingChannelDeliveries).set({ status: "dropped", lastError: null }).where(fence);
        console.error(`[attention] dropped job ${job.id}: its event is JSON null`);
        return;
      }
      let handled = tier.enabled?.() === false;
      if (job.notificationId) {
        const [row] = await deps.db.select({ readAt: notifications.readAt }).from(notifications)
          .where(and(eq(notifications.id, job.notificationId), eq(notifications.userId, job.userId))).limit(1);
        signal.throwIfAborted();
        handled ||= !row || row.readAt !== null;
      }
      // The exemption ends while a producer waits behind an active batch, not when that batch selected it.
      const age = Math.max(claimedAt, Date.now()) - job.createdAt;
      const freshImmediate = immediateIds.has(job.id) && age >= 0 && age < ATTENTION_IMMEDIATE_GATE_GRACE_MS;
      if (!handled && !freshImmediate && !await attentionGatePending(deps, event)) handled = true;
      signal.throwIfAborted();
      const [preference] = await deps.db.select().from(userNotificationPreferences).where(and(
        eq(userNotificationPreferences.userId, job.userId), eq(userNotificationPreferences.kind, event.kind),
      )).limit(1);
      signal.throwIfAborted();
      if (event.owner.type === "team" && preference?.teamDm !== true) handled = true;
      if (!handled && tier.recipientEnabled && !await tier.recipientEnabled(job.userId, signal)) handled = true;
      signal.throwIfAborted();
      // Local terminal state wins even while Slack audience checks are unavailable.
      if (!handled && !await attentionRecipientAllowed({ ...deps, access: authorizationProviders.get(deps.db) }, event, job.userId, signal)) handled = true;
      signal.throwIfAborted();
      if (handled) {
        await deps.db.update(pendingChannelDeliveries).set({ status: "dropped", event: sql`'null'::jsonb`, lastError: null }).where(fence);
        return;
      }
      if (tier.ready?.() === false) throw new Error("Attention transport is not ready. Check channel startup and credentials.");
      const attempt = { deliveryId: claimed.deliveryToken, sendingAt: claimed.firstSendingAt ?? claimedAt, signal };
      let refs;
      if (job.status === "sending" && tier.reconcile) {
        try { refs = await tier.reconcile(job.userId, event, attempt); }
        catch (err) { signal.throwIfAborted(); console.error(`attention reconciliation ${job.id} failed; resending:`, err); }
      }
      signal.throwIfAborted();
      if (!refs) {
        try { refs = await tier.deliver(job.userId, event, attempt); }
        catch (err) {
          // A timed-out post may have landed. Restore its controls when this batch still owns the send.
          if (signal.aborted || !isAttentionTimeout(err) || !tier.reconcile) throw err;
          refs = await tier.reconcile(job.userId, event, attempt);
          if (!refs) throw err;
        }
      }
      signal.throwIfAborted();
      await deps.db.update(pendingChannelDeliveries).set({ status: "sent", messageRefs: refs ?? [], event: sql`'null'::jsonb`, lastError: null }).where(fence);
    } catch (err) {
      if (signal.aborted) return;
      const rejections = claimed && attentionRejections(err);
      if (!rejections) recordAttentionDeliveryFailure((claimed?.attempts ?? 0) > 1);
      console.error(`attention job ${job.id} failed; retry or check recipient rejection:`, err);
      if (!claimed) return;
      const fence = and(eq(pendingChannelDeliveries.id, job.id), eq(pendingChannelDeliveries.attempts, claimed.attempts), eq(pendingChannelDeliveries.status, "sending"));
      try {
        if (rejections) {
          const dropped = await deps.db.update(pendingChannelDeliveries).set({ status: "dropped", event: sql`'null'::jsonb`, lastError: null }).where(fence).returning({ id: pendingChannelDeliveries.id });
          if (dropped.length > 0) for (const rejection of rejections) recordAttentionDeliveryRejected(rejection.channel, rejection.reason);
        } else {
          const lastError = (err instanceof Error ? err.message : String(err)).slice(0, 2_000);
          const retryDelay = Math.min(30 * 60_000, ATTENTION_SENDING_TIMEOUT_MS * 2 ** Math.min(claimed.attempts - 1, 4));
          await deps.db.update(pendingChannelDeliveries).set({ lastError, deliverAfter: Math.max(claimedAt, Date.now()) + retryDelay }).where(fence);
        }
      } catch (failure) {
        console.error(`attention retry bookkeeping ${job.id} failed; its durable claim remains recoverable:`, failure);
      }
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
