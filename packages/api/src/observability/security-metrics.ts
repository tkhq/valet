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
type Histogram = ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]>;

let createdCounter: Counter | null = null;
let settledCounter: Counter | null = null;
let compactionStaleCounter: Counter | null = null;
let runnerStalledCounter: Counter | null = null;
let cellExhaustedCounter: Counter | null = null;
let bootRestoreTimeoutCounter: Counter | null = null;
let credentialCountHistogram: Histogram | null = null;
let credentialFragmentAlertCounter: Counter | null = null;

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

/**
 * A cell-claimed child thread compacted while the cell's latest state doc
 * was older than the checkpoint stride (M5, spec §Context Discipline).
 * That is the moment work silently evaporates — this counter pages
 * attention; nothing auto-repairs the cell.
 */
export function recordSecurityCompactionStale(): void {
  if (!compactionStaleCounter) {
    compactionStaleCounter = metrics.getMeter("@valet/api").createCounter("valet.security.compaction.stale", {
      description: "Cell-claimed thread compactions with a stale state doc",
    });
  }
  compactionStaleCounter.add(1);
}

/**
 * The autonomy nudge sweep re-drove an idle runner N times with no progress,
 * so it stopped nudging and asked the user to step in (`SecurityRunnerDriver`,
 * spec §Autonomy). This is the capped driver's alert: a runner that a nudge
 * cannot un-stick needs a human, and this counter pages that. Alert, don't
 * loop forever.
 */
export function recordSecurityRunnerStalled(): void {
  if (!runnerStalledCounter) {
    runnerStalledCounter = metrics.getMeter("@valet/api").createCounter("valet.security.runner.stalled", {
      description: "Idle security runners a capped nudge sweep could not un-stick",
    });
  }
  runnerStalledCounter.add(1);
}

/**
 * A cell was re-dispatched past its attempt cap without ever settling
 * (`dispatchCell`, fix 5). The cap turns a strand that would loop and orphan a
 * sandbox on every pass into ONE terminal failure the runner surfaces. This
 * counter pages the stuck cell so a human reviews it — alert, don't loop.
 */
export function recordSecurityCellExhausted(): void {
  if (!cellExhaustedCounter) {
    cellExhaustedCounter = metrics.getMeter("@valet/api").createCounter("valet.security.cells.exhausted", {
      description: "Security cells failed after exhausting the dispatch attempt cap",
    });
  }
  cellExhaustedCounter.add(1);
}

/**
 * A session's boot restore exceeded its per-session wait budget (fix 10a).
 * The restore pass counts and logs a timeout, but a timed-out session whose
 * work never comes back is invisible without a metric. This counter makes each
 * one visible so a persistent un-restorable session pages a human.
 */
export function recordBootRestoreTimeout(): void {
  if (!bootRestoreTimeoutCounter) {
    bootRestoreTimeoutCounter = metrics
      .getMeter("@valet/api")
      .createCounter("valet.boot.restore.timeout", {
        description: "Sessions whose boot restore exceeded the per-session wait budget",
      });
  }
  bootRestoreTimeoutCounter.add(1);
}

/**
 * Declared 1Password credential count at engagement start (Part 12, the
 * sec_start observability seam). The broker allowlist reads
 * `credentials_json` directly on every resolve, so this histogram is not a
 * runtime registry; it is the boot-time signal that an engagement's declared
 * credential count landed. No per-id attributes: the engagement id and the
 * declared labels go in the caller's log line, never on the metric.
 */
export function recordSecurityEngagementCredentialCount(count: number): void {
  if (!credentialCountHistogram) {
    credentialCountHistogram = metrics
      .getMeter("@valet/api")
      .createHistogram("valet.security.engagement.credentials_declared", {
        description: "Declared credential count per engagement at start",
        advice: { explicitBucketBoundaries: [0, 1, 2, 5, 10, 20] },
      });
  }
  credentialCountHistogram.record(count);
}

/**
 * Output from one session covered more than half of a registered
 * credential value, and nothing was blocked yet. Partial reconstruction is
 * the early signal that a persona is dripping a value out in fragments.
 * The tripwire fires this once per value, then keeps matching. Nothing
 * auto-repairs the session: a human reads the transcript and decides.
 *
 * The counter carries no attributes. The session and engagement ids are
 * unbounded, so they go in the log line and never on the metric.
 */
export function recordSecurityCredentialFragmentAlert(args: {
  sessionId: string;
  engagementId: string;
}): void {
  if (!credentialFragmentAlertCounter) {
    credentialFragmentAlertCounter = metrics
      .getMeter("@valet/api")
      .createCounter("valet.security.credential_fragment_alerts", {
        description: "Registered credential values half reconstructed in session output",
      });
  }
  credentialFragmentAlertCounter.add(1);
  console.warn(
    `security tripwire: output covered more than half of a registered credential value ` +
      `for session ${args.sessionId} in engagement ${args.engagementId}. ` +
      `Read the session transcript and stop the session if the persona is leaking the value.`,
  );
}
