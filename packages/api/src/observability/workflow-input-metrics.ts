/** Cleanup skips leave residual inputs visible to operators, without waking sandboxes. */
import { metrics } from "@opentelemetry/api";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let skippedCounter: Counter | undefined;
let sweepSkippedCounter: Counter | undefined;

export function recordWorkflowInputCleanupSkipped(scope: "node" | "run", reason: string): void {
  skippedCounter ??= metrics.getMeter("@valet/api").createCounter("valet.workflow.inputs.cleanup_skipped", {
    description: "Workflow input cleanup skipped because the session is not cached and ready",
  });
  skippedCounter.add(1, { scope, reason });
}

/** Capped or failed sweeps leave data for a later write or sandbox destruction. */
export function recordWorkflowInputSweepSkipped(reason: "listing" | "budget" | "marker" | "removal"): void {
  sweepSkippedCounter ??= metrics.getMeter("@valet/api").createCounter("valet.workflow.inputs.sweep_skipped", {
    description: "Workflow input residual sweep skipped work because of limits or unreadable metadata",
  });
  sweepSkippedCounter.add(1, { reason });
}
