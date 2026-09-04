/** API-owned observability for repository prebuild flag resolution. */
import { metrics } from "@opentelemetry/api";
import type { RepoPrebuildFlags } from "../bakes/source-service.js";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;

let prebuildFlagsCounter: Counter | null = null;

/** Records each flags read that the API attempts during a session build. */
export function recordPrebuildFlagsResolved(outcome: RepoPrebuildFlags["outcome"] | "timeout"): void {
  prebuildFlagsCounter ??= metrics.getMeter("@valet/api").createCounter("valet.sandbox.prebuild_flags", {
    description: "Repository prebuild flag reads by outcome: declared, absent, error, or timeout",
  });
  prebuildFlagsCounter.add(1, { outcome });
}
