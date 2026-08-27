// packages/api/src/proxy/metrics.ts
import { metrics } from "@opentelemetry/api";

let counter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null;

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
