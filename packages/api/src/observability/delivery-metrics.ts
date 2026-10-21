/**
 * Where assistant deliveries land (spec 2026-10-16: delivery threads, Part E
 * step 3). Exported as `valet_event_delivery_destination_total{reason}`. A
 * rising `pin_unavailable` means rules point at threads that cannot receive
 * deliveries. Alert on it; no code repairs it.
 */
import { asc, inArray } from "drizzle-orm";
import { pendingChannelDeliveries } from "../schema/index.js";
import { metrics } from "@opentelemetry/api";
import type { Destination, DestinationReason } from "../events/destination.js";

/**
 * The counter's reason label: a resolver reason, a claim skip, a dead pin,
 * `claim_recovered`: a claimed waiter got its digest back because the
 * dispatcher skipped the claim delivery for a reason decided after ingest,
 * or `claim_fallback`: a stamped thread could no longer take the delivery
 * at dispatch, so it landed by the binding or the rule's policy,
 * `follow_routed`: the follow router delivers the reply, so the rule skips
 * it, or `mention_covered`: the post's `app_mention` half delivers it, so
 * the rule skips the `slack.message` half.
 */
export type DeliveryDestinationMetricReason =
  | DestinationReason | "claim_skip" | "pin_unavailable" | "claim_recovered" | "claim_fallback"
  | "follow_routed" | "mention_covered";

/** A sink for one delivery's destination reason: the counter, or a test's recorder. */
export type DestinationRecorder = (reason: DeliveryDestinationMetricReason) => void;

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let destinationCounter: Counter | undefined;

export function recordDeliveryDestination(reason: DeliveryDestinationMetricReason): void {
  destinationCounter ??= metrics.getMeter("@valet/api").createCounter("valet_event_delivery_destination", {
    description: "Assistant deliveries by the reason their destination resolved",
  });
  destinationCounter.add(1, { reason });
}

/** The counter label for a resolved destination. */
export function destinationMetricReason(destination: Destination): DeliveryDestinationMetricReason {
  return destination.kind === "skip" ? "claim_skip" : destination.reason;
}


let attentionFailureCounter: Counter | undefined;

/** Alert on failed recovery attempts. Do not discard an unanswered approval. */
export function recordAttentionDeliveryFailure(retry: boolean): void {
  attentionFailureCounter ??= metrics.getMeter("@valet/api").createCounter("valet_attention_delivery_failures", {
    description: "Failed personal attention delivery attempts; retry=true when recovery also fails",
  });
  attentionFailureCounter.add(1, { retry: String(retry) });
}

const attentionQueues = new WeakSet<import("../lib/drizzle.js").AppDb>();

/** Sample durable enqueue age at collection time, including unready transports and future retries. */
export function registerAttentionQueueMetrics(db: import("../lib/drizzle.js").AppDb): void {
  if (attentionQueues.has(db)) return;
  attentionQueues.add(db);
  const gauge = metrics.getMeter("@valet/api").createObservableGauge("valet_attention_oldest_job_age", {
    unit: "s", description: "Age of the oldest pending or sending personal attention job",
  });
  gauge.addCallback(async result => {
    const [oldest] = await db.select({ createdAt: pendingChannelDeliveries.createdAt }).from(pendingChannelDeliveries)
      .where(inArray(pendingChannelDeliveries.status, ["pending", "sending"]))
      .orderBy(asc(pendingChannelDeliveries.createdAt)).limit(1);
    result.observe(oldest ? Math.max(0, (Date.now() - oldest.createdAt) / 1_000) : 0);
  });
}
