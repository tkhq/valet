import { mapBounded } from "../lib/bounded-map.js";
import type { AppDb } from "../lib/drizzle.js";
import { recordAttentionDeliveryFailure } from "../observability/delivery-metrics.js";
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

/** One bounded batch per transport. A slow tier cannot occupy another tier's slots. */
const inFlight = new WeakMap<AppDb, Map<string, Promise<void>>>();

/** Called by the event rail, or detached after an immediate durable insert. */
export async function drainAttentionDeliveries(deps: AttentionDeps, now = Date.now(), immediateIds?: string[]): Promise<void> {
  let running = inFlight.get(deps.db);
  if (!running) { running = new Map(); inFlight.set(deps.db, running); }
  await Promise.all((deps.channels ?? []).map(tier => {
    const existing = running.get(tier.id);
    if (existing) return existing;
    if (tier.enabled?.() !== false && tier.ready?.() === false) return;
    const batch = drainTier({ ...deps, channels: [tier] }, now, immediateIds)
      .finally(() => { running.delete(tier.id); });
    running.set(tier.id, batch);
    return batch;
  }));
}

async function drainTier(deps: AttentionDeps, now: number, immediateIds?: string[]): Promise<void> {
  const tier = deps.channels?.[0];
  if (!tier) return;
  // Keep dedupe tombstones, not gate digests. Scrub terminal rows from older
  // versions in bounded batches on the same rail, without a retention timer.
  await deps.db.execute(sql`UPDATE pending_channel_deliveries SET event = 'null'::jsonb, last_error = NULL
    WHERE id IN (SELECT id FROM pending_channel_deliveries
      WHERE status IN ('sent', 'dropped') AND event <> 'null'::jsonb LIMIT 20)`);
  const dueCondition = and(
    inArray(pendingChannelDeliveries.status, ["pending", "sending"]),
    lte(pendingChannelDeliveries.deliverAfter, now),
  );
  const due = await deps.db.select().from(pendingChannelDeliveries).where(and(
    dueCondition, eq(pendingChannelDeliveries.tierId, tier.id),
    immediateIds ? inArray(pendingChannelDeliveries.id, immediateIds) : undefined,
  )).orderBy(asc(pendingChannelDeliveries.attempts), asc(pendingChannelDeliveries.deliverAfter)).limit(20);
  await mapBounded(due, 4, async job => {
    if (!job.event) throw new Error("Active attention delivery has no event. Check the outbox row.");
    const event = job.event;
    const claimedAt = Math.max(now, Date.now());
    // Repeat the due predicate on the outer update to fence concurrent drains.
    // A process crash leaves sending recoverable after the durable deadline.
    const [claimed] = await deps.db.update(pendingChannelDeliveries).set({
      status: "sending", sendingAt: claimedAt, deliverAfter: claimedAt + ATTENTION_SENDING_TIMEOUT_MS,
      attempts: sql`${pendingChannelDeliveries.attempts} + 1`, lastError: null,
    }).where(and(eq(pendingChannelDeliveries.id, job.id), dueCondition)).returning();
    if (!claimed) return;
    const fence = and(eq(pendingChannelDeliveries.id, job.id), eq(pendingChannelDeliveries.attempts, claimed.attempts), eq(pendingChannelDeliveries.status, "sending"));
    try {
      let handled = tier.enabled?.() === false;
      if (job.notificationId) {
        const [row] = await deps.db.select({ readAt: notifications.readAt }).from(notifications)
          .where(and(eq(notifications.id, job.notificationId), eq(notifications.userId, job.userId))).limit(1);
        handled ||= !row || row.readAt !== null;
      }
      // Immediate producers can run before a workflow finishes parking.
      if (!immediateIds && !await attentionGatePending(deps, event)) handled = true;
      const [preference] = await deps.db.select().from(userNotificationPreferences).where(and(
        eq(userNotificationPreferences.userId, job.userId), eq(userNotificationPreferences.kind, event.kind),
      )).limit(1);
      if (event.owner.type === "team" && preference?.teamDm !== true) handled = true;
      if (!(await attentionAudience(deps, event, true)).audience.includes(job.userId)) handled = true;
      if (handled) {
        await deps.db.update(pendingChannelDeliveries).set({ status: "dropped", event: sql`'null'::jsonb`, lastError: null }).where(fence);
        return;
      }
      let refs;
      if (job.status === "sending" && tier.reconcile) {
        try {
          refs = await tier.reconcile(job.userId, event, { deliveryId: job.id, sendingAt: job.sendingAt ?? claimedAt });
        } catch (err) {
          // A lookup failure must not cost a blocking approval notification.
          console.error(`attention reconciliation ${job.id} failed; resending:`, err);
        }
      }
      // The deliverer checks the current per-link notifyAttention setting.
      refs ??= await tier.deliver(job.userId, event, { deliveryId: job.id, sendingAt: claimedAt });
      await deps.db.update(pendingChannelDeliveries).set({ status: "sent", messageRefs: refs ?? [], event: sql`'null'::jsonb`, lastError: null }).where(fence);
    } catch (err) {
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
