import { metrics } from "@opentelemetry/api";
type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let deadLetters: Counter | undefined;
export function recordTaggingDeadLetter(dimension: string): void {
  deadLetters ??= metrics.getMeter("@valet/api").createCounter("valet.tagging.dead_letters", {
    description: "Tagging jobs discarded after five failed attempts; alert on increases",
  });
  deadLetters.add(1, { dimension });
}
