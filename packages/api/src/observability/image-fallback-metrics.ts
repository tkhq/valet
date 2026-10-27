/** Spec 9: sessions that fell back from their repo image, by reason. */
import { metrics } from "@opentelemetry/api";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let counter: Counter | null = null;

export function recordImageFallback(reason: "contract"): void {
  counter ??= metrics.getMeter("@valet/api").createCounter("valet.sandbox.image_fallback", {
    description: "Session starts that fell back from the repo image, by reason",
  });
  counter.add(1, { reason });
}
