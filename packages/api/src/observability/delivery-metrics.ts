/**
 * Where assistant deliveries land (spec 2026-10-16: delivery threads, Part E
 * step 3). Exported as `valet_event_delivery_destination_total{reason}`. A
 * rising `pin_unavailable` means rules point at threads that cannot receive
 * deliveries. Alert on it; no code repairs it.
 */
import { metrics } from "@opentelemetry/api";
import type { Destination, DestinationReason } from "../events/destination.js";

/** The counter's reason label: a resolver reason, a claim skip, or a dead pin. */
export type DeliveryDestinationMetricReason = DestinationReason | "claim_skip" | "pin_unavailable";

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
