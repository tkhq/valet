/**
 * An assistant delivery is "delivered" once its prompt is queued. The turn
 * that prompt starts can still fail (an output limit, a provider error), and
 * nothing then reaches the person who expected it. This module marks such a
 * delivery dead with the turn's reason, so the event reads as failed and
 * shows under the events Log's Problems filter.
 *
 * The turn is found through the dispatch id the delivery was admitted under
 * (`event:{deliveryId}`), so a delivery admitted before `queue_item_id`
 * existed is still found. The statement records the queue item as it marks.
 *
 * Three callers run the same idempotent statement:
 * - the settle watcher, when a turn fails;
 * - the dispatcher, right after it writes "delivered", because the turn can
 *   fail before that write and the watcher then finds a row still pending;
 * - the dispatcher's sweep, because the watcher's write can fail or the API
 *   can exit between a settlement and the write. Those windows are expected
 *   in normal operation, so the sweep catches up instead of alerting.
 * Dead is terminal: the dispatcher never retries it, because a retry only
 * recovers the same admission.
 */
import { sql, type SQL } from "drizzle-orm";
import type { EventStream, Unsubscribe } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";

const MAX_ERROR_CHARS = 2_000;
const PREFIX = "The assistant turn failed: ";
const NO_REASON = "the engine recorded no reason. Open the event's thread to inspect the turn.";
const DISPATCH_PREFIX = "event:";

/** How far back the sweep looks for delivered rows whose turn failed. */
export const FAILED_TURN_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;

export type FailedTurnMatch = { deliveryId: string } | { queueItemId: string } | { deliveredSince: number };

/** Marks matching delivered rows dead when their turn settled failed. Returns how many it marked. */
export async function markFailedDeliveryTurns(db: AppDb, match: FailedTurnMatch): Promise<number> {
  // Each form keeps its lookup on an index: the delivery's primary key, the
  // queue item's primary key, or the queue items' dispatch-id index.
  let where: SQL;
  if ("deliveryId" in match) {
    where = sql`d.id = ${match.deliveryId} AND q.dispatch_id = ${DISPATCH_PREFIX + match.deliveryId}`;
  } else if ("queueItemId" in match) {
    where = sql`q.id = ${match.queueItemId} AND q.dispatch_id LIKE 'event:%' AND d.id = substr(q.dispatch_id, ${DISPATCH_PREFIX.length + 1})`;
  } else {
    where = sql`d.delivered_at >= ${match.deliveredSince} AND q.dispatch_id = ${DISPATCH_PREFIX} || d.id`;
  }
  const result = await db.execute(sql`
    UPDATE event_deliveries d
    SET status = 'dead', queue_item_id = q.id,
      last_error = left(${PREFIX} || COALESCE(q.error, ${NO_REASON}), ${MAX_ERROR_CHARS})
    FROM engine_queue_items q
    WHERE ${where}
      AND d.status = 'delivered' AND q.status = 'settled' AND q.outcome = 'failed'
    RETURNING d.id`) as { rows: unknown[] };
  return result.rows.length;
}

/** Marks a delivery when its turn fails. Start it before boot restore: restored work can settle there. */
export function wireDeliveryTurnFailures(eventStream: EventStream, db: AppDb): Unsubscribe {
  return eventStream.subscribe({ eventTypes: ["submission_settled"] }, ({ event }) => {
    if (event.type !== "submission_settled" || event.outcome.outcome !== "failed") return;
    // A failed write here is caught up by the dispatcher's sweep.
    void markFailedDeliveryTurns(db, { queueItemId: event.queueItemId })
      .catch((err) => console.error("[events] could not mark a delivery whose turn failed", err));
  });
}
