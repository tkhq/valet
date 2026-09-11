/** Bounded OpenTelemetry signals for the image source and bake lifecycle. */
import { metrics, trace, type Attributes, type Counter, type Histogram, type ObservableGauge, type Span } from "@opentelemetry/api";

interface Instruments {
  requests: Counter;
  builds: Counter;
  decisions: Counter;
  queueWait: Histogram;
  buildDuration: Histogram;
  imageSize: Histogram;
  registryOperations: Counter;
  registryLatency: Histogram;
  registryBytes: Counter;
  reconciliations: Counter;
  cleanup: Counter;
  queueDepth: ObservableGauge;
  queueOldest: ObservableGauge;
  activeBuilds: ObservableGauge;
  latestStatus: ObservableGauge;
}

let instruments: Instruments | undefined;

function getInstruments(): Instruments {
  if (instruments) return instruments;
  // Lazy creation is required because this module loads before initTelemetry
  // registers the global provider during normal API boot.
  const meter = metrics.getMeter("@valet/api-prebuilds");
  const created: Instruments = {
    requests: meter.createCounter("valet.prebuild.requests", { description: "Bake requests by bounded source shape and outcome" }),
    builds: meter.createCounter("valet.prebuild.builds", { description: "Bake lifecycle transitions by outcome" }),
    decisions: meter.createCounter("valet.prebuild.cache.decisions", { description: "Bake cache, coalescing, and rebuild decisions" }),
    queueWait: meter.createHistogram("valet.prebuild.queue_wait", { unit: "ms", description: "Time from bake request to observed builder start" }),
    buildDuration: meter.createHistogram("valet.prebuild.build.duration", { unit: "ms", description: "Time from observed builder start to terminal state" }),
    imageSize: meter.createHistogram("valet.prebuild.image.size", { unit: "By", description: "Compressed size of a successful bake image" }),
    registryOperations: meter.createCounter("valet.prebuild.registry.operations", { description: "Registry operations by bounded operation and outcome" }),
    registryLatency: meter.createHistogram("valet.prebuild.registry.duration", { unit: "ms", description: "Registry operation latency" }),
    registryBytes: meter.createCounter("valet.prebuild.registry.bytes", { unit: "By", description: "Bytes observed during registry operations" }),
    reconciliations: meter.createCounter("valet.prebuild.registry.reconciliations", { description: "Session preflight comparisons of database bake state and registry state" }),
    cleanup: meter.createCounter("valet.prebuild.cleanup", { description: "Image cleanup operations by outcome" }),
    queueDepth: meter.createObservableGauge("valet.prebuild.queue.depth", { description: "Current queued bake count" }),
    queueOldest: meter.createObservableGauge("valet.prebuild.queue.oldest_age", { unit: "s", description: "Age of the oldest queued bake" }),
    activeBuilds: meter.createObservableGauge("valet.prebuild.builds.active", { description: "Current active bake count" }),
    latestStatus: meter.createObservableGauge("valet.prebuild.bakes.latest", { description: "Current latest bake count by status" }),
  };
  created.queueDepth.addCallback((result) => {
    for (const snapshot of snapshots) result.observe(snapshot.queued, boundedPrebuildAttributes(snapshot));
  });
  created.queueOldest.addCallback((result) => {
    for (const snapshot of snapshots) result.observe(snapshot.oldestQueuedAgeSeconds, boundedPrebuildAttributes(snapshot));
  });
  created.activeBuilds.addCallback((result) => {
    for (const snapshot of snapshots) result.observe(snapshot.active, boundedPrebuildAttributes(snapshot));
  });
  created.latestStatus.addCallback((result) => {
    for (const snapshot of snapshots) {
      for (const [status, count] of Object.entries(snapshot.latest ?? {})) {
        result.observe(count, { ...boundedPrebuildAttributes(snapshot), status });
      }
    }
  });
  instruments = created;
  return created;
}

export type PrebuildSourceKind = "base" | "repo" | "external" | "other";
export type PrebuildProfile = "full" | "headless" | "shared" | "other";
export type PrebuildProvider = "docker" | "kubernetes" | "none" | "other";

export interface PrebuildDimensions {
  sourceKind: string | null | undefined;
  profile: string | null | undefined;
  provider: string | null | undefined;
}

interface QueueSnapshot extends PrebuildDimensions {
  queued: number;
  active: number;
  oldestQueuedAgeSeconds: number;
  latest?: Partial<Record<"queued" | "building" | "pushed" | "failed", number>>;
}

let snapshots: QueueSnapshot[] = [];

function oneOf<T extends string>(value: string | null | undefined, values: readonly T[], fallback: T): T {
  return value !== null && value !== undefined && values.includes(value as T) ? value as T : fallback;
}

/** This is the only label funnel. Unknown external values collapse to `other`. */
export function boundedPrebuildAttributes(dimensions: PrebuildDimensions): Attributes {
  const sourceKind = oneOf(dimensions.sourceKind, ["base", "repo", "external"] as const, "other");
  return {
    source_kind: sourceKind,
    profile: oneOf(dimensions.profile ?? (sourceKind === "repo" ? "shared" : undefined), ["full", "headless", "shared"] as const, "other"),
    provider: oneOf(dimensions.provider ?? "none", ["docker", "kubernetes", "none"] as const, "other"),
  };
}

export function updatePrebuildQueueSnapshot(next: QueueSnapshot[]): void {
  const aggregated = new Map<string, QueueSnapshot>();
  for (const snapshot of next) {
    const attrs = boundedPrebuildAttributes(snapshot);
    const sourceKind = String(attrs.source_kind);
    const profile = String(attrs.profile);
    const provider = String(attrs.provider);
    const key = `${sourceKind}|${profile}|${provider}`;
    const current = aggregated.get(key) ?? { sourceKind, profile, provider, queued: 0, active: 0, oldestQueuedAgeSeconds: 0, latest: {} };
    current.queued += snapshot.queued;
    current.active += snapshot.active;
    current.oldestQueuedAgeSeconds = Math.max(current.oldestQueuedAgeSeconds, snapshot.oldestQueuedAgeSeconds);
    for (const status of ["queued", "building", "pushed", "failed"] as const) {
      const count = snapshot.latest?.[status];
      if (count !== undefined) current.latest![status] = (current.latest![status] ?? 0) + count;
    }
    aggregated.set(key, current);
  }
  snapshots = [...aggregated.values()];
  getInstruments();
}

export function recordPrebuildRequest(dimensions: PrebuildDimensions, outcome: "accepted" | "rejected", trigger: "manual" | "scheduler" | "cascade" | "binding" | "seed" | "other"): void {
  getInstruments().requests.add(1, { ...boundedPrebuildAttributes(dimensions), outcome, trigger });
}

export function recordPrebuildTransition(dimensions: PrebuildDimensions, outcome: "started" | "succeeded" | "failed" | "canceled" | "retried"): void {
  getInstruments().builds.add(1, { ...boundedPrebuildAttributes(dimensions), outcome });
}

export function recordPrebuildDecision(dimensions: PrebuildDimensions, decision: "hit" | "miss" | "duplicate" | "coalesced" | "commit_changed" | "recipe_changed" | "parent_changed" | "expired" | "other"): void {
  getInstruments().decisions.add(1, { ...boundedPrebuildAttributes(dimensions), decision });
}

export function recordPrebuildQueueWait(dimensions: PrebuildDimensions, milliseconds: number): void {
  getInstruments().queueWait.record(Math.max(0, milliseconds), boundedPrebuildAttributes(dimensions));
}

export function recordPrebuildCompletion(dimensions: PrebuildDimensions, milliseconds: number | undefined, sizeBytes?: number): void {
  const current = getInstruments();
  const attributes = boundedPrebuildAttributes(dimensions);
  if (milliseconds !== undefined) current.buildDuration.record(Math.max(0, milliseconds), attributes);
  if (sizeBytes !== undefined) current.imageSize.record(sizeBytes, attributes);
}

export function recordRegistryOperation(operation: "lookup" | "delete" | "size", outcome: "success" | "missing" | "auth" | "timeout" | "error", milliseconds: number, bytes?: number): void {
  const current = getInstruments();
  const attrs = { operation, outcome };
  current.registryOperations.add(1, attrs);
  current.registryLatency.record(Math.max(0, milliseconds), attrs);
  if (bytes !== undefined && bytes >= 0) current.registryBytes.add(bytes, { operation });
}

export function recordRegistryReconciliation(outcome: "present" | "missing" | "auth_unknown" | "unavailable"): void {
  getInstruments().reconciliations.add(1, { outcome });
}

export function recordPrebuildCleanup(provider: string | null | undefined, outcome: "deleted" | "missing" | "failed" | "skipped" | "orphaned"): void {
  getInstruments().cleanup.add(1, { provider: oneOf(provider ?? "none", ["docker", "kubernetes", "none"] as const, "other"), outcome });
}

export function startBakeSpan(buildId: string, dimensions: PrebuildDimensions): Span {
  return trace.getTracer("@valet/api-prebuilds").startSpan("prebuild.bake", {
    attributes: { ...boundedPrebuildAttributes(dimensions), "valet.prebuild.build_id": buildId },
  });
}

export function logPrebuildEvent(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ component: "prebuild", event, ...details }));
}
