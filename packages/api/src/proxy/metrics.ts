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
 *
 * Labels are bounded on purpose: `kind` (2), `endpoint` (≤4), `reason` (2). The
 * model is DELIBERATELY not a label — it comes from the client's request/response
 * and is unbounded, so it would explode metric cardinality (one time series per
 * distinct string a caller invents). The exact model lives on the recorded row
 * for anyone who needs to drill in.
 */
export function recordProxyUnpriced(attrs: { kind: string; endpoint: string; reason: string }): void {
  if (!unpricedCounter) {
    unpricedCounter = metrics.getMeter("@valet/api").createCounter("valet.proxy.unpriced.count", {
      description: "Successful proxy calls recorded without a price, by kind/endpoint/reason",
    });
  }
  unpricedCounter.add(1, { kind: attrs.kind, endpoint: attrs.endpoint, reason: attrs.reason });
}
