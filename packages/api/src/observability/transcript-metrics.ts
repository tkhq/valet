/** Agent transcripts the idle sweep released from memory (see `Thread.releaseIdleTranscript`). */
import { metrics } from "@opentelemetry/api";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let counter: Counter | undefined;
let counterProvider: ReturnType<typeof metrics.getMeterProvider> | undefined;

/** Lazy, and recreated when the global provider changes (same pattern as
 * image-fallback-metrics.ts). */
function getCounter(): Counter {
  const provider = metrics.getMeterProvider();
  if (counter && counterProvider === provider) return counter;
  counter = metrics.getMeter("@valet/api").createCounter("valet.thread.transcripts_released", {
    description: "Idle thread transcripts released from API memory by the idle sweep",
  });
  counterProvider = provider;
  return counter;
}

export function recordTranscriptsReleased(count: number): void {
  if (count > 0) getCounter().add(count);
}
