import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { childEventOutbox, childReplyDeliveries, childWatches, eventDropLog } from "../schema/index.js";

const owners = new WeakMap<AppDb, Map<string, Promise<unknown>>>();

/** The host owns publication, cancellation, and idle close through this per-child critical section. */
export async function withChildDelivery<T>(db: AppDb, child: string, work: () => Promise<T>): Promise<T> {
  let chains = owners.get(db);
  if (!chains) { chains = new Map(); owners.set(db, chains); }
  const previous = chains.get(child) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  chains.set(child, next);
  try { return await next; }
  finally { if (chains.get(child) === next) chains.delete(child); }
}

/** Records abandoned delivery before removing its durable retry state. Caller holds the delivery lock. */
export async function discardChildDelivery(db: AppDb, store: Pick<SessionStore, "getWakeup" | "transitionWakeup">, child: string, reason: string): Promise<void> {
  const waiter = await store.getWakeup(`wk_child_events:${child}`);
  await store.transitionWakeup(`wk_child_events:${child}`, ["running", "done"], "cancelled",
    { endedAt: Date.now(), eventBuffer: [] }, Date.now());
  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE engine_queue_items SET child_result_delivery = 'denied'
      WHERE session_id = ${child} AND child_result_delivery = 'pending'`);
    const [watch] = await tx.select().from(childWatches).where(eq(childWatches.childSessionId, child));
    const pending = await tx.delete(childEventOutbox).where(eq(childEventOutbox.childSessionId, child)).returning({ id: childEventOutbox.id });
    const replies = await tx.update(childReplyDeliveries).set({ failedAt: Date.now(), lastError: reason })
      .where(and(eq(childReplyDeliveries.childSessionId, child), isNull(childReplyDeliveries.queueItemId),
        isNull(childReplyDeliveries.completedAt), isNull(childReplyDeliveries.failedAt))).returning({ id: childReplyDeliveries.id });
    if (watch && (!watch.settled || pending.length || waiter?.eventBuffer?.length || replies.length)) {
      await tx.insert(eventDropLog).values({ id: randomUUID(), orgId: watch.orgId, reason: "child_delivery_cancelled",
        conversationKey: child, detail: `${reason} Removed ${pending.length} outbox events and ${replies.length} unadmitted replies.`, createdAt: Date.now() });
    }
    await tx.update(childWatches).set({ deliveryActive: false, pendingCapIncident: null, eventsStartedAt: Date.now() })
      .where(eq(childWatches.childSessionId, child));
  });
}

export async function cancelChildDelivery(db: AppDb, store: Pick<SessionStore, "getWakeup" | "transitionWakeup">, child: string, reason: string): Promise<void> {
  await withChildDelivery(db, child, () => discardChildDelivery(db, store, child, reason));
}
