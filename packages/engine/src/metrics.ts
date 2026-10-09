/**
 * Engine metrics seam (observability spec, metrics extension). Same contract
 * as `tracing.ts`: the engine depends only on `@opentelemetry/api`, whose
 * meter is a no-op until a host registers a MeterProvider (the api does this
 * in `initTelemetry` when an OTLP endpoint is configured). Every recorder
 * here is a cheap no-op in dev-local and tests.
 *
 * Instruments are created lazily on first record — `metrics.getMeter()`
 * resolves the GLOBAL provider at call time (unlike tracers there is no
 * upgrading proxy), and the first turn always runs long after the host's
 * boot-time registration.
 *
 * Naming: dots in OTel, which Prometheus's OTLP ingestion renders as
 * underscores with unit/monotonic suffixes (e.g. `valet.turn.duration` (ms)
 * → `valet_turn_duration_milliseconds_bucket`, counter `valet.tokens` →
 * `valet_tokens_total`). The bundled Grafana dashboard queries those
 * rendered names.
 */
import { metrics, type Counter, type Histogram, type ObservableGauge } from "@opentelemetry/api";
import type { LeaseOwnerKind, WakeupCause, WakeupKind } from "./wakeups/types.js";

const METER_NAME = "@valet/engine";

/**
 * Last-set value for one observable gauge's one label set. The engine has no
 * push-gauge instrument (OTel only offers synchronous Counter/UpDownCounter/
 * Histogram plus async Observable*), so each gauge keeps its latest value
 * here, keyed by its serialized attributes, and an `addCallback` on the
 * matching `createObservableGauge` reports every entry at each collection.
 */
interface GaugeEntry {
  value: number;
  attributes: Record<string, string>;
}

function attributeKey(attributes: Record<string, string>): string {
  return Object.keys(attributes)
    .sort()
    .map((key) => `${key}=${attributes[key]}`)
    .join(",");
}

function setGauge(state: Map<string, GaugeEntry>, attributes: Record<string, string>, value: number): void {
  state.set(attributeKey(attributes), { value, attributes });
}

function observeGauge(gauge: ObservableGauge, state: Map<string, GaugeEntry>): void {
  gauge.addCallback((result) => {
    for (const entry of state.values()) result.observe(entry.value, entry.attributes);
  });
}

const wakeupsActiveState = new Map<string, GaugeEntry>();
const leasesActiveState = new Map<string, GaugeEntry>();
const leasesOverDeadlineState = new Map<string, GaugeEntry>();
const leasesUnannotatedState = new Map<string, GaugeEntry>();
const scratchRequestedState = new Map<string, GaugeEntry>();
const wakeupSweepOkState = new Map<string, GaugeEntry>();

interface Instruments {
  turns: Counter;
  turnDuration: Histogram;
  tokens: Counter;
  costUsd: Counter;
  settlements: Counter;
  queueWait: Histogram;
  toolDuration: Histogram;
  sandboxExecDuration: Histogram;
  provisionDuration: Histogram;
  credentialReads: Counter;
  gatesUnownedExpired: Counter;
  sandboxCreated: Counter;
  sandboxDestroyed: Counter;
  sandboxFlagged: Counter;
  sandboxCapacityWait: Histogram;
  sandboxWorkspaceGrow: Counter;
  cacheBreaks: Counter;
  compactionCoverageGaps: Counter;
  wakeupsTotal: Counter;
  wakeupSignalsLost: Counter;
  wakeupsActive: ObservableGauge;
  leasesActive: ObservableGauge;
  leaseNodeSeconds: Counter;
  leasesOverDeadline: ObservableGauge;
  leasesUnannotated: ObservableGauge;
  scratchRequestedBytes: ObservableGauge;
  scratchRefused: Counter;
  leasesOrphanReleased: Counter;
  wakeupBadRows: Counter;
  wakeupSweepOkAt: ObservableGauge;
  wakeupSweepFailed: Counter;
  leasesSettleOverDeadline: Counter;
}

let instruments: Instruments | null = null;

function inst(): Instruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter(METER_NAME);
  instruments = {
    turns: meter.createCounter("valet.turns", {
      description: "Completed agent turns, by model and stop reason",
    }),
    turnDuration: meter.createHistogram("valet.turn.duration", {
      unit: "ms",
      description: "Wall-clock duration of agent turns",
    }),
    tokens: meter.createCounter("valet.tokens", {
      description: "LLM tokens consumed, by model and kind (input/output/cache_read/cache_write)",
    }),
    costUsd: meter.createCounter("valet.cost.usd", {
      description: "LLM spend in USD (priced models only — unpriced turns record nothing)",
    }),
    settlements: meter.createCounter("valet.submissions.settled", {
      description: "Settled submissions, by outcome",
    }),
    queueWait: meter.createHistogram("valet.submission.queue_wait", {
      unit: "ms",
      description: "Admission→claim latency per submission",
    }),
    toolDuration: meter.createHistogram("valet.tool.duration", {
      unit: "ms",
      description: "Tool execution duration, by tool",
    }),
    sandboxExecDuration: meter.createHistogram("valet.sandbox.exec.duration", {
      unit: "ms",
      description: "Sandbox exec/exec_job dispatch duration",
    }),
    provisionDuration: meter.createHistogram("valet.sandbox.provision.duration", {
      unit: "ms",
      description: "Sandbox cold-boot duration (provider.create + prepareSandbox)",
    }),
    gatesUnownedExpired: meter.createCounter("valet.gates.unowned_expired", {
      description:
        "Lapsed pending decision-gate rows expired by the sweep with no owning waiter or checkpoint. A steady rate after the pre-stickiness backlog drains means something is producing orphan gate rows — investigate, do not ignore.",
    }),
    credentialReads: meter.createCounter("valet.credential.reads", {
      description: "Credential accesses, by service and hit/miss",
    }),
    sandboxCreated: meter.createCounter("valet.sandbox.created", {
      description: "Sandboxes provisioned (provision ended ready)",
    }),
    sandboxDestroyed: meter.createCounter("valet.sandbox.destroyed", {
      description: "Sandboxes destroyed, by reason (see SandboxDestroyReason)",
    }),
    sandboxFlagged: meter.createCounter("valet.sandbox.flagged", {
      description:
        "Sandboxes flagged by the reconcile sweep without a destroy, by kind (over_age, unowned). A sustained non-zero rate means a lifecycle owner failed to clean up — the alert signal for the alert-don't-auto-repair rule.",
    }),
    sandboxCapacityWait: meter.createHistogram("valet.sandbox.capacity_wait", {
      unit: "ms",
      description:
        "Time a sandbox create spent waiting at the per-org capacity gate, by outcome (admitted/timeout). Non-zero rates mean an org is contending for its sandbox ceiling.",
    }),
    sandboxWorkspaceGrow: meter.createCounter("valet.sandbox.workspace_grow", {
      description:
        "Workspace-volume growth handling, by outcome (grown/refused/pending/error). Every fill event records here even when the grow succeeds, so a systemic many-workspaces-filling problem stays visible instead of being papered over by resizes.",
    }),
    cacheBreaks: meter.createCounter("valet.cache.breaks", {
      description:
        "Prompt-cache breaks between consecutive turns, by cause (model_changed, system_prompt_changed, tools_changed, ttl_or_content). A sustained rate on one cause means something rewrites the request prefix every turn — investigate that source, do not ignore (TKAI-320).",
    }),
    compactionCoverageGaps: meter.createCounter("valet.compaction.coverage_gap", {
      description:
        "Compaction passes that refused to write a checkpoint because the summarizer input carried none of the history the checkpoint would replace. This is an invariant violation, not a workload property: any sustained rate means threads stop compacting (TKAI-461).",
    }),
    wakeupsTotal: meter.createCounter("valet.wakeups.total", {
      description: "Wakeups that ended, by kind (process/watch/timer) and cause. See WakeupCause.",
    }),
    wakeupSignalsLost: meter.createCounter("valet.wakeups.signal_lost", {
      description:
        "Wakeup signals the WakeWatcher could not deliver after the row moved, by kind (process/watch/timer/hold). The row does not retry, so each count is a turn the agent never got. Any sustained rate needs a human.",
    }),
    wakeupsActive: meter.createObservableGauge("valet.wakeups.active", {
      description:
        "Wakeups currently pending or running, by kind, from a store count each WakeWatcher pass. A count that only grows means wakeups are not reaching a terminal status.",
    }),
    leasesOrphanReleased: meter.createCounter("valet.leases.orphan_released", {
      description:
        "Process or watch leases the WakeWatcher released because their wakeup row was missing or terminal, or their deadline passed, by owner_kind. A crash between two writes can cause one; a sustained rate means a lease writer is broken.",
    }),
    wakeupBadRows: meter.createCounter("valet.wakeups.bad_rows", {
      description:
        "engine_wakeups or engine_leases rows a store read skipped because a field held an unknown value, by table. Any count needs a human: the row is never probed or released.",
    }),
    wakeupSweepOkAt: meter.createObservableGauge("valet.wakeups.sweep_ok_at", {
      unit: "s",
      description:
        "Unix time of the last WakeWatcher pass that finished. Alert when it falls behind now by more than a few intervals: the other wakeup and lease gauges then hold stale values.",
    }),
    wakeupSweepFailed: meter.createCounter("valet.wakeups.sweep_failed", {
      description: "WakeWatcher passes that threw before they finished. A sustained rate means no wakeup moves and no hold expires.",
    }),
    leasesSettleOverDeadline: meter.createCounter("valet.leases.settle_over_deadline", {
      description:
        "Child settles that stopped waiting because a lease stayed active past its deadline plus one poll. The child settled; the lease owner failed to release it.",
    }),
    leasesActive: meter.createObservableGauge("valet.leases.active", {
      description:
        "Sandbox leases currently held open, by owner kind (process/watch/hold). A lease keeps a sandbox alive independent of session activity. A persistently high count means that many node hours stay held by leases; check it against expected load.",
    }),
    leaseNodeSeconds: meter.createCounter("valet.leases.node_seconds", {
      description:
        "Sandbox node-seconds held open by a lease, by owner kind. The capacity cost of durable background work; a sustained rise on one owner kind means that kind is pinning sandboxes.",
    }),
    leasesOverDeadline: meter.createObservableGauge("valet.leases.over_deadline", {
      description:
        "A lease active past its deadline for two ticks means the WakeWatcher failed to release it. This is the alert signal for the alert-don't-auto-repair rule. The only repair is the crash-window release, which valet.leases.orphan_released counts.",
    }),
    leasesUnannotated: meter.createObservableGauge("valet.leases.unannotated", {
      description:
        "Leased sandboxes the last WakeWatcher reconcile found without eviction protection: a pod that lacked safe-to-evict=false past two ticks, a failed patch, or a lease with no resolvable sandbox id. Any non-zero value pages (INV-3).",
    }),
    scratchRequestedBytes: meter.createObservableGauge("valet.sandbox.scratch.requested_bytes", {
      description:
        "Most recently requested /scratch volume size, by session class. Tracks demand for scratch capacity, not allocated size.",
    }),
    scratchRefused: meter.createCounter("valet.sandbox.scratch.refused", {
      description:
        "Scratch volume requests the host refused, by source and reason. A sustained rate means sessions of that class cannot get the scratch space they ask for.",
    }),
  };
  observeGauge(instruments.wakeupsActive, wakeupsActiveState);
  observeGauge(instruments.leasesActive, leasesActiveState);
  observeGauge(instruments.leasesOverDeadline, leasesOverDeadlineState);
  observeGauge(instruments.leasesUnannotated, leasesUnannotatedState);
  observeGauge(instruments.scratchRequestedBytes, scratchRequestedState);
  observeGauge(instruments.wakeupSweepOkAt, wakeupSweepOkState);
  return instruments;
}

export function recordTurn(args: {
  model?: string;
  reason: string;
  durationMs?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd?: number;
}): void {
  const i = inst();
  const model = args.model ?? "unknown";
  i.turns.add(1, { model, reason: args.reason });
  if (args.durationMs !== undefined) i.turnDuration.record(args.durationMs, { model });
  if (args.usage) {
    const u = args.usage;
    if (u.input > 0) i.tokens.add(u.input, { model, kind: "input" });
    if (u.output > 0) i.tokens.add(u.output, { model, kind: "output" });
    if (u.cacheRead > 0) i.tokens.add(u.cacheRead, { model, kind: "cache_read" });
    if (u.cacheWrite > 0) i.tokens.add(u.cacheWrite, { model, kind: "cache_write" });
  }
  if (args.costUsd !== undefined && args.costUsd > 0) i.costUsd.add(args.costUsd, { model });
}

export function recordSettlement(outcome: string, queueWaitMs?: number): void {
  const i = inst();
  i.settlements.add(1, { outcome });
  if (queueWaitMs !== undefined) i.queueWait.record(queueWaitMs);
}

export function recordToolExecution(tool: string, durationMs: number, ok: boolean): void {
  inst().toolDuration.record(durationMs, { tool, ok });
}

export function recordCacheBreak(cause: string, model?: string): void {
  inst().cacheBreaks.add(1, { cause, ...(model ? { model } : {}) });
}

/** A compaction pass that could not cover its head. Alert on any rate: the
 * thread keeps its history, but it also stops compacting. */
export function recordCompactionCoverageGap(mode: string): void {
  inst().compactionCoverageGaps.add(1, { mode });
}

export function recordSandboxExec(durationMs: number, job: boolean): void {
  inst().sandboxExecDuration.record(durationMs, { job });
}

export function recordSandboxProvision(durationMs: number, ok: boolean): void {
  inst().provisionDuration.record(durationMs, { ok });
}

export function recordCredentialRead(service: string, hit: boolean): void {
  inst().credentialReads.add(1, { service, hit });
}

/** The destroying owner, for `valet.sandbox.destroyed`'s reason attribute.
 * A closed union so a typo'd reason cannot silently fragment the series —
 * add new owners here, not as ad-hoc strings at call sites. */
export type SandboxDestroyReason =
  | "session_destroy"
  | "run_settled"
  | "hibernation_retention"
  | "child_settled"
  | "child_retention"
  | "orphaned";

/** A reconcile-sweep flag class, for `valet.sandbox.flagged`. */
export type SandboxFlagKind = "over_age" | "unowned";

/** A provision that ended ready — one side of the created−destroyed gap
 * that IS the sandbox-leak alarm (sandbox-lifecycle spec, 2026-08-22). */
export function recordSandboxCreated(): void {
  inst().sandboxCreated.add(1);
}

/**
 * The other side of the leak-alarm gap. Record only a destroy that
 * actually succeeded — a swallowed provider failure or a cleanup of a
 * never-counted sandbox (a failed create) must NOT increment, or the gap
 * reads clean while sandboxes leak. Known imprecision: a derived-handle
 * destroy whose target never existed (tolerated 404) still counts, since
 * providers do not report found-vs-absent; it is rare (a run cancelled
 * before its session ever claimed a turn).
 */
export function recordSandboxDestroyed(reason: SandboxDestroyReason): void {
  inst().sandboxDestroyed.add(1, { reason });
}

/** A reconcile-sweep flag that deliberately did NOT destroy — the "alert,
 * don't auto-repair" signal. Re-emitted every sweep pass while the
 * condition persists, so `increase(...) > 0` alerts cleanly. */
export function recordSandboxFlagged(kind: SandboxFlagKind, count: number): void {
  if (count > 0) inst().sandboxFlagged.add(count, { kind });
}

/** Outcome of workspace-volume growth handling. This includes
 * Sandbox.growWorkspace and adopted-claim convergence. A closed union keeps
 * a typo'd outcome from fragmenting the series. */
export type WorkspaceGrowOutcome = "grown" | "refused" | "pending" | "error";

/** One workspace growth outcome. Reactive callers record every attempt,
 * including successes. Adoption records each attempted convergence or failed
 * pre-read. */
export function recordSandboxWorkspaceGrow(outcome: WorkspaceGrowOutcome): void {
  inst().sandboxWorkspaceGrow.add(1, { outcome });
}

/** A create's wait at the per-org capacity gate. Recorded only when the
 * create actually waited (or timed out) — an uncontended admit is silent. */
export function recordSandboxCapacityWait(waitedMs: number, outcome: "admitted" | "timeout"): void {
  inst().sandboxCapacityWait.record(waitedMs, { outcome });
}

export function recordGateUnownedExpired(gateType: string): void {
  inst().gatesUnownedExpired.add(1, { type: gateType });
}

/** A wakeup that reached a terminal status. Record once per wakeup, at the
 * transition into done/cancelled/expired/lost. */
export function recordWakeupEnded(kind: WakeupKind, cause: WakeupCause): void {
  inst().wakeupsTotal.add(1, { kind, cause });
}

/** A wakeup signal the WakeWatcher failed to deliver after its CAS. The
 * watcher does not retry it (spec Deviations, B5), so this counter is the
 * only record besides the log line. `kind` is the wakeup kind, or `hold`
 * for `lease.expired`. */
export function recordWakeupSignalLost(kind: WakeupKind | "hold"): void {
  inst().wakeupSignalsLost.add(1, { kind });
}

/** Wakeups currently pending or running, by kind. The caller (the host's
 * WakeWatcher sweep) owns re-setting this every pass from a store count. A
 * stale value means the sweep stopped; `valet.wakeups.sweep_ok_at` shows it. */
export function recordWakeupsActive(kind: WakeupKind, count: number): void {
  inst(); // ensure the gauge and its callback exist before the first set
  setGauge(wakeupsActiveState, { kind }, count);
}

/** Sandbox leases currently held open, by owner kind. Set by the WakeWatcher
 * sweep alongside `recordWakeupsActive`. */
export function recordLeasesActive(ownerKind: LeaseOwnerKind, count: number): void {
  inst();
  setGauge(leasesActiveState, { owner_kind: ownerKind }, count);
}

/** Node-seconds a lease held a sandbox open, by owner kind. The WakeWatcher
 * records the real time since its previous pass for each active lease. */
export function recordLeaseNodeSeconds(ownerKind: LeaseOwnerKind, seconds: number): void {
  inst().leaseNodeSeconds.add(seconds, { owner_kind: ownerKind });
}

/** A process or watch lease released by the WakeWatcher's crash-window
 * repair: its owner row was missing or terminal, or its deadline passed. */
export function recordLeaseOrphanReleased(ownerKind: LeaseOwnerKind): void {
  inst().leasesOrphanReleased.add(1, { owner_kind: ownerKind });
}

/** A wakeup or lease row a store read skipped because it did not narrow. */
export function recordWakeupBadRow(table: "engine_wakeups" | "engine_leases"): void {
  inst().wakeupBadRows.add(1, { table });
}

/** The WakeWatcher finished a pass at `unixSeconds`. */
export function recordWakeupSweepOk(unixSeconds: number): void {
  inst();
  setGauge(wakeupSweepOkState, {}, unixSeconds);
}

/** A WakeWatcher pass threw before it finished. */
export function recordWakeupSweepFailed(): void {
  inst().wakeupSweepFailed.add(1);
}

/** The ChildWatcher stopped waiting on a lease past its deadline and settled the child. */
export function recordChildSettleOverDeadline(): void {
  inst().leasesSettleOverDeadline.add(1);
}

/** Leases active past their deadline. The WakeWatcher is the only releaser;
 * this is the alert-don't-auto-repair signal for that invariant, re-set
 * every sweep pass while the condition persists. */
export function recordLeasesOverDeadline(count: number): void {
  inst();
  setGauge(leasesOverDeadlineState, {}, count);
}

/** Leased sandboxes the last reconcile found unprotected (spec INV-3). The
 * WakeWatcher re-sets it every tick. Should stay at zero. */
export function recordLeasesUnannotated(count: number): void {
  inst();
  setGauge(leasesUnannotatedState, {}, count);
}

/** Most recently requested `/scratch` volume size, by session class. */
export function recordScratchRequested(sessionClass: string, bytes: number): void {
  inst();
  setGauge(scratchRequestedState, { session_class: sessionClass }, bytes);
}

/** A scratch volume request the host refused, by source (the caller that
 * asked) and reason. */
export function recordScratchRefused(source: string, reason: string): void {
  inst().scratchRefused.add(1, { source, reason });
}
