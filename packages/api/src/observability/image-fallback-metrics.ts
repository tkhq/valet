/** Spec 9: sessions that fell back from their repo image, by reason. */
import { metrics } from "@opentelemetry/api";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let counter: Counter | undefined;
let counterProvider: ReturnType<typeof metrics.getMeterProvider> | undefined;

/** Lazy, and recreated when the global provider changes: this module loads
 * before initTelemetry registers the provider (same pattern as
 * prebuild-lifecycle.ts). */
function getCounter(): Counter {
  const provider = metrics.getMeterProvider();
  if (counter && counterProvider === provider) return counter;
  counter = metrics.getMeter("@valet/api").createCounter("valet.sandbox.image_fallback", {
    description: "Session starts that fell back from the repo image, by reason",
  });
  counterProvider = provider;
  // Zero-initialize so increase() sees the first fallback after a start.
  counter.add(0, { reason: "contract" });
  return counter;
}

/** Creates the counter (and its 0 point) without counting a fallback. Call
 * at boot so the series exists before the first event. */
export function initImageFallbackMetrics(): void {
  getCounter();
}

export function recordImageFallback(reason: "contract"): void {
  getCounter().add(1, { reason });
}
