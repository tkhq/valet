// packages/api/src/proxy/metrics.ts
import { metrics } from "@opentelemetry/api";

let counter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null;
let unpricedCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null;

export function recordProxySpend(
  costUsd: number,
  attrs: { model: string; userId: string; keyId: string; kind: string },
): void {
  if (!counter) {
    counter = metrics.getMeter("@valet/api").createCounter("valet.proxy.cost.usd", {
      description: "External-harness proxy spend in USD, by user/key/model (priced calls only)",
    });
  }
  if (costUsd > 0) counter.add(costUsd, attrs);
}

/**
 * Counts successful proxy calls that were recorded but could NOT be priced —
 * unbilled traffic. `reason` is `no_usage` (response carried no usage event) or
 * `unpriced_model` (usage parsed, model not in the pricing registry). A rising
 * count is the alert that spend is escaping capture.
 */
export function recordProxyUnpriced(attrs: { model: string | null; kind: string; endpoint: string; reason: string }): void {
  if (!unpricedCounter) {
    unpricedCounter = metrics.getMeter("@valet/api").createCounter("valet.proxy.unpriced.count", {
      description: "Successful proxy calls recorded without a price, by kind/endpoint/reason",
    });
  }
  // A null model is reported as the literal "unknown" — metric attributes must
  // be non-null, and the reason label carries the diagnostic either way.
  unpricedCounter.add(1, { model: attrs.model ?? "unknown", kind: attrs.kind, endpoint: attrs.endpoint, reason: attrs.reason });
}
