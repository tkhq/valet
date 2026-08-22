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
import { metrics, type Counter, type Histogram } from "@opentelemetry/api";

const METER_NAME = "@valet/engine";

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
  sandboxCreated: Counter;
  sandboxDestroyed: Counter;
  sandboxFlagged: Counter;
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
    credentialReads: meter.createCounter("valet.credential.reads", {
      description: "Credential accesses, by service and hit/miss",
    }),
    sandboxCreated: meter.createCounter("valet.sandbox.created", {
      description: "Sandboxes provisioned (provider.create succeeded)",
    }),
    sandboxDestroyed: meter.createCounter("valet.sandbox.destroyed", {
      description: "Sandboxes destroyed, by reason (session_destroy, run_settled, hibernation_retention, child_retention, orphaned, failed_create, ...)",
    }),
    sandboxFlagged: meter.createCounter("valet.sandbox.flagged", {
      description:
        "Sandboxes flagged by the reconcile sweep without a destroy, by kind (over_age, unowned). A sustained non-zero rate means a lifecycle owner failed to clean up — the alert signal for the alert-don't-auto-repair rule.",
    }),
  };
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

export function recordSandboxExec(durationMs: number, job: boolean): void {
  inst().sandboxExecDuration.record(durationMs, { job });
}

export function recordSandboxProvision(durationMs: number, ok: boolean): void {
  inst().provisionDuration.record(durationMs, { ok });
}

export function recordCredentialRead(service: string, hit: boolean): void {
  inst().credentialReads.add(1, { service, hit });
}

/** A successful `provider.create` — one side of the created−destroyed gap
 * that IS the sandbox-leak alarm (sandbox-lifecycle spec, 2026-08-22). */
export function recordSandboxCreated(): void {
  inst().sandboxCreated.add(1);
}

/** The other side of the leak-alarm gap. `reason` names the destroying
 * owner: session_destroy, run_settled, hibernation_retention,
 * child_retention, orphaned, failed_create. */
export function recordSandboxDestroyed(reason: string): void {
  inst().sandboxDestroyed.add(1, { reason });
}

/** A reconcile-sweep flag that deliberately did NOT destroy (over_age,
 * unowned) — the "alert, don't auto-repair" signal. Re-emitted every sweep
 * pass while the condition persists, so `increase(...) > 0` alerts cleanly. */
export function recordSandboxFlagged(kind: string, count: number): void {
  if (count > 0) inst().sandboxFlagged.add(count, { kind });
}
