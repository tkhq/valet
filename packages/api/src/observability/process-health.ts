/**
 * API process health: memory, V8 heap, event-loop delay, and uptime
 * (`docs/specs/2026-10-30-error-instrumentation-design.md`). The 2026-10-28
 * dev outage was an OOM, and Prometheus had container RSS only, with no
 * heap and no event-loop numbers. A sampler records one point every 10
 * seconds. The OTel gauges export the newest point, and the
 * `diagnostics.process_health` tool reads the last hour.
 *
 * Exported names (Prometheus renders dots as underscores):
 *  - `valet.process.memory{kind}` bytes: rss, heap_used, heap_total,
 *    external, array_buffers, plus cgroup_usage and cgroup_limit when the
 *    container exposes them;
 *  - `valet.process.heap_limit` bytes: V8's heap ceiling;
 *  - `valet.process.event_loop.delay{quantile}` ms: p50, p99, max over the
 *    last interval, when the runtime has `monitorEventLoopDelay` (Bun
 *    1.2, which builds the single-file `valet` binary, does not);
 *  - `valet.process.start_time` unix seconds: `changes()` over it counts
 *    restarts of this container.
 */
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { metrics } from "@opentelemetry/api";
import { detachedFromTrace } from "@valet/engine";

export const PROCESS_SAMPLE_INTERVAL_MS = 10_000;
/** Samples kept: one hour at the default interval. */
const MAX_SAMPLES = 360;
const NS_PER_MS = 1e6;

export interface ProcessSample {
  at: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  /** Absent when the runtime cannot measure event-loop delay. */
  loopP50Ms?: number;
  loopP99Ms?: number;
  loopMaxMs?: number;
}

export interface CgroupMemory {
  usageBytes: number;
  /** Undefined when the container has no memory limit. */
  limitBytes?: number;
}

/** Newest samples, oldest first. Capped at `MAX_SAMPLES`; every push drops
 * the oldest past the cap. */
const samples: ProcessSample[] = [];
const startedAt = Date.now() - Math.round(process.uptime() * 1_000);
let gaugesProvider: ReturnType<typeof metrics.getMeterProvider> | undefined;

function pushSample(sample: ProcessSample): void {
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Parses a cgroup usage file and its limit file. A non-numeric limit
 * (`max`) means no limit. Undefined when the usage is missing. */
export function parseCgroupMemory(currentText: string | undefined, maxText: string | undefined): CgroupMemory | undefined {
  const usage = Number(currentText?.trim());
  if (currentText === undefined || currentText.trim() === "" || !Number.isFinite(usage)) return undefined;
  const limit = Number(maxText?.trim());
  return { usageBytes: usage, ...(maxText !== undefined && maxText.trim() !== "" && Number.isFinite(limit) ? { limitBytes: limit } : {}) };
}

/** The container's memory as the OOM killer counts it: cgroup v2 first,
 * then v1. A v1 limit near 2^63 means no limit. */
export function readCgroupMemory(read: (path: string) => string | undefined = readText): CgroupMemory | undefined {
  const v2 = parseCgroupMemory(read("/sys/fs/cgroup/memory.current"), read("/sys/fs/cgroup/memory.max"));
  if (v2) return v2;
  const v1 = parseCgroupMemory(read("/sys/fs/cgroup/memory/memory.usage_in_bytes"), read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  if (v1?.limitBytes !== undefined && v1.limitBytes >= 2 ** 62) return { usageBytes: v1.usageBytes };
  return v1;
}

/** The event-loop delay histogram, or undefined when the runtime throws
 * "Not implemented" for it (Bun 1.2). Memory samples still run. */
function startLoopMonitor(): IntervalHistogram | undefined {
  try {
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    return loop;
  } catch {
    return undefined;
  }
}

function takeSample(loop: IntervalHistogram | undefined, now: number): ProcessSample {
  const memory = process.memoryUsage();
  const sample: ProcessSample = {
    at: now,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    ...(loop ? {
      loopP50Ms: loop.percentile(50) / NS_PER_MS,
      loopP99Ms: loop.percentile(99) / NS_PER_MS,
      loopMaxMs: loop.max / NS_PER_MS,
    } : {}),
  };
  loop?.reset();
  return sample;
}

/** Registers the gauges once per global MeterProvider. Call after
 * `initTelemetry`; with no provider registered they are no-ops. */
function registerGauges(): void {
  const provider = metrics.getMeterProvider();
  if (gaugesProvider === provider) return;
  gaugesProvider = provider;
  const meter = metrics.getMeter("@valet/api");
  meter.createObservableGauge("valet.process.memory", {
    unit: "By",
    description: "API process memory by kind. cgroup_usage is what the container OOM killer compares to cgroup_limit.",
  }).addCallback((result) => {
    const latest = samples[samples.length - 1];
    if (!latest) return;
    result.observe(latest.rssBytes, { kind: "rss" });
    result.observe(latest.heapUsedBytes, { kind: "heap_used" });
    result.observe(latest.heapTotalBytes, { kind: "heap_total" });
    result.observe(latest.externalBytes, { kind: "external" });
    result.observe(latest.arrayBuffersBytes, { kind: "array_buffers" });
    const cgroup = readCgroupMemory();
    if (cgroup) result.observe(cgroup.usageBytes, { kind: "cgroup_usage" });
    if (cgroup?.limitBytes !== undefined) result.observe(cgroup.limitBytes, { kind: "cgroup_limit" });
  });
  meter.createObservableGauge("valet.process.heap_limit", { unit: "By", description: "V8 heap size limit of the API process" })
    .addCallback((result) => result.observe(getHeapStatistics().heap_size_limit));
  meter.createObservableGauge("valet.process.event_loop.delay", {
    unit: "ms", description: "API event-loop delay over the last sample interval, by quantile (p50, p99, max)",
  }).addCallback((result) => {
    const latest = samples[samples.length - 1];
    if (latest?.loopP50Ms !== undefined) result.observe(latest.loopP50Ms, { quantile: "p50" });
    if (latest?.loopP99Ms !== undefined) result.observe(latest.loopP99Ms, { quantile: "p99" });
    if (latest?.loopMaxMs !== undefined) result.observe(latest.loopMaxMs, { quantile: "max" });
  });
  meter.createObservableGauge("valet.process.start_time", {
    unit: "s", description: "Unix time the API process started. changes() over it counts container restarts.",
  }).addCallback((result) => result.observe(startedAt / 1_000));
}

/** Starts the sampler and registers the gauges. Returns the stop function
 * for shutdown. The timer is unref'd and runs outside any trace. */
export function startProcessHealthSampler(intervalMs = PROCESS_SAMPLE_INTERVAL_MS): () => void {
  registerGauges();
  const loop = startLoopMonitor();
  const timer = detachedFromTrace(() => setInterval(() => pushSample(takeSample(loop, Date.now())), intervalMs));
  timer.unref();
  return () => {
    clearInterval(timer);
    loop?.disable();
  };
}

export interface ProcessHealthWindow {
  since: number;
  samples: number;
  peakRssBytes?: number;
  peakHeapUsedBytes?: number;
  eventLoopP99MaxMs?: number;
  eventLoopMaxMs?: number;
}

export interface ProcessHealthSummary {
  pid: number;
  /** The pod name on kubernetes (its hostname). */
  pod?: string;
  nodeVersion: string;
  startedAt: number;
  uptimeSeconds: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    heapLimitBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    cgroupUsageBytes?: number;
    cgroupLimitBytes?: number;
  };
  window: ProcessHealthWindow;
}

/** Peaks over the samples taken at or after `since`. */
export function summarizeSamples(all: readonly ProcessSample[], since: number): ProcessHealthWindow {
  const kept = all.filter((sample) => sample.at >= since);
  if (kept.length === 0) return { since, samples: 0 };
  const p99s = kept.flatMap((sample) => sample.loopP99Ms === undefined ? [] : [sample.loopP99Ms]);
  const maxes = kept.flatMap((sample) => sample.loopMaxMs === undefined ? [] : [sample.loopMaxMs]);
  return {
    since,
    samples: kept.length,
    peakRssBytes: Math.max(...kept.map((sample) => sample.rssBytes)),
    peakHeapUsedBytes: Math.max(...kept.map((sample) => sample.heapUsedBytes)),
    ...(p99s.length > 0 ? { eventLoopP99MaxMs: Math.max(...p99s) } : {}),
    ...(maxes.length > 0 ? { eventLoopMaxMs: Math.max(...maxes) } : {}),
  };
}

export function processHealthSummary(opts: { sinceMs: number; now?: number }): ProcessHealthSummary {
  const now = opts.now ?? Date.now();
  const memory = process.memoryUsage();
  const cgroup = readCgroupMemory();
  return {
    pid: process.pid,
    ...(process.env.KUBERNETES_SERVICE_HOST && process.env.HOSTNAME ? { pod: process.env.HOSTNAME } : {}),
    nodeVersion: process.version,
    startedAt,
    uptimeSeconds: Math.round((now - startedAt) / 1_000),
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      ...(cgroup ? { cgroupUsageBytes: cgroup.usageBytes } : {}),
      ...(cgroup?.limitBytes !== undefined ? { cgroupLimitBytes: cgroup.limitBytes } : {}),
    },
    window: summarizeSamples(samples, Math.max(opts.sinceMs, startedAt)),
  };
}

/** Test seam: add a sample without the timer. */
export function recordProcessSampleForTest(sample: ProcessSample): void {
  pushSample(sample);
}

/** Test seam: drop every sample. */
export function resetProcessSamples(): void {
  samples.length = 0;
}
