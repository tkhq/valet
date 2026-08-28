/**
 * Valet Security counters (spec §The Loop, "Invariants: alert, don't
 * auto-repair"). The created/settled pair is the invariant signal: created
 * minus settled trends to zero for a healthy engagement population. Nothing
 * auto-repairs a gap — a widening one pages a human.
 *
 * Same lazy OTel-meter shape as `proxy/metrics.ts`.
 */
import { metrics } from "@opentelemetry/api";

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;

let createdCounter: Counter | null = null;
let settledCounter: Counter | null = null;

/** Cells materialized by startEngagement. */
export function recordSecurityCellsCreated(count: number): void {
  if (!createdCounter) {
    createdCounter = metrics.getMeter("@valet/api").createCounter("valet.security.cells.created", {
      description: "Security cells materialized at engagement start",
    });
  }
  if (count > 0) createdCounter.add(count);
}

/**
 * Cells that reached a terminal status. `yielded` is deliberately NOT
 * counted: a yielded cell re-dispatches onto the same row, so counting it
 * would let one cell settle more than once and break the created-minus-
 * settled invariant this pair exists to watch.
 */
export function recordSecurityCellSettled(status: "completed" | "failed"): void {
  if (!settledCounter) {
    settledCounter = metrics.getMeter("@valet/api").createCounter("valet.security.cells.settled", {
      description: "Security cells settled terminally, by status",
    });
  }
  settledCounter.add(1, { status });
}
