/** Bounded OpenTelemetry signals for the image source and bake lifecycle. */
import { metrics, trace, type Attributes, type Span } from "@opentelemetry/api";

const meter = metrics.getMeter("@valet/api-prebuilds");
const requests = meter.createCounter("valet.prebuild.requests", { description: "Bake requests by bounded source shape and outcome" });
const builds = meter.createCounter("valet.prebuild.builds", { description: "Bake lifecycle transitions by outcome" });
const decisions = meter.createCounter("valet.prebuild.cache.decisions", { description: "Bake cache, coalescing, and rebuild decisions" });
const queueWait = meter.createHistogram("valet.prebuild.queue_wait", { unit: "ms", description: "Time from bake request to builder start" });
const buildDuration = meter.createHistogram("valet.prebuild.build.duration", { unit: "ms", description: "Time from builder start to terminal state" });
const imageSize = meter.createHistogram("valet.prebuild.image.size", { unit: "By", description: "Compressed size of a successful bake image" });
const registryOperations = meter.createCounter("valet.prebuild.registry.operations", { description: "Registry operations by bounded operation and outcome" });
const registryLatency = meter.createHistogram("valet.prebuild.registry.duration", { unit: "ms", description: "Registry operation latency" });
const registryBytes = meter.createCounter("valet.prebuild.registry.bytes", { unit: "By", description: "Bytes observed during registry operations" });
const reconciliations = meter.createCounter("valet.prebuild.registry.reconciliations", { description: "Database and registry reconciliation outcomes" });
const cleanup = meter.createCounter("valet.prebuild.cleanup", { description: "Image cleanup operations by outcome" });
const capacityBlocked = meter.createCounter("valet.prebuild.capacity_blocked", { description: "Builds that waited more than one second before builder start" });

const queueDepth = meter.createObservableGauge("valet.prebuild.queue.depth", { description: "Current queued bake count" });
const queueOldest = meter.createObservableGauge("valet.prebuild.queue.oldest_age", { unit: "s", description: "Age of the oldest queued bake" });
const activeBuilds = meter.createObservableGauge("valet.prebuild.builds.active", { description: "Current active bake count" });
const latestStatus = meter.createObservableGauge("valet.prebuild.bakes.latest", { description: "Current latest bake count by status" });

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
  return {
    source_kind: oneOf(dimensions.sourceKind, ["base", "repo", "external"] as const, "other"),
    profile: oneOf(dimensions.profile, ["full", "headless", "shared"] as const, "other"),
    provider: oneOf(dimensions.provider, ["docker", "kubernetes", "none"] as const, "other"),
  };
}

queueDepth.addCallback((result) => {
  for (const snapshot of snapshots) result.observe(snapshot.queued, boundedPrebuildAttributes(snapshot));
});
queueOldest.addCallback((result) => {
  for (const snapshot of snapshots) result.observe(snapshot.oldestQueuedAgeSeconds, boundedPrebuildAttributes(snapshot));
});
activeBuilds.addCallback((result) => {
  for (const snapshot of snapshots) result.observe(snapshot.active, boundedPrebuildAttributes(snapshot));
});
latestStatus.addCallback((result) => {
  for (const snapshot of snapshots) {
    for (const [status, count] of Object.entries(snapshot.latest ?? {})) {
      result.observe(count, { ...boundedPrebuildAttributes(snapshot), status });
    }
  }
});

export function updatePrebuildQueueSnapshot(next: QueueSnapshot[]): void {
  snapshots = next.map((snapshot) => ({ ...snapshot, latest: snapshot.latest ? { ...snapshot.latest } : undefined }));
}

export function recordPrebuildRequest(dimensions: PrebuildDimensions, outcome: "accepted" | "rejected", trigger: "manual" | "scheduler" | "cascade" | "binding" | "seed" | "other"): void {
  requests.add(1, { ...boundedPrebuildAttributes(dimensions), outcome, trigger });
}

export function recordPrebuildTransition(dimensions: PrebuildDimensions, outcome: "started" | "succeeded" | "failed" | "canceled" | "retried"): void {
  builds.add(1, { ...boundedPrebuildAttributes(dimensions), outcome });
}

export function recordPrebuildDecision(dimensions: PrebuildDimensions, decision: "hit" | "miss" | "duplicate" | "coalesced" | "commit_changed" | "recipe_changed" | "parent_changed" | "expired" | "other"): void {
  decisions.add(1, { ...boundedPrebuildAttributes(dimensions), decision });
}

export function recordPrebuildQueueWait(dimensions: PrebuildDimensions, milliseconds: number): void {
  queueWait.record(Math.max(0, milliseconds), boundedPrebuildAttributes(dimensions));
  if (milliseconds > 1_000) capacityBlocked.add(1, boundedPrebuildAttributes(dimensions));
}

export function recordPrebuildCompletion(dimensions: PrebuildDimensions, milliseconds: number, sizeBytes?: number): void {
  buildDuration.record(Math.max(0, milliseconds), boundedPrebuildAttributes(dimensions));
  if (sizeBytes !== undefined) imageSize.record(sizeBytes, boundedPrebuildAttributes(dimensions));
}

export function recordRegistryOperation(operation: "lookup" | "push" | "pull" | "delete" | "size" | "gc" | "other", outcome: "success" | "missing" | "stale" | "auth" | "timeout" | "error" | "skipped", milliseconds: number, bytes?: number): void {
  const attrs = { operation, outcome };
  registryOperations.add(1, attrs);
  registryLatency.record(Math.max(0, milliseconds), attrs);
  if (bytes !== undefined && bytes >= 0) registryBytes.add(bytes, { operation });
}

export function recordRegistryReconciliation(outcome: "present" | "missing" | "auth_unknown" | "unavailable" | "digest_mismatch"): void {
  reconciliations.add(1, { outcome });
}

export function recordPrebuildCleanup(provider: string | null | undefined, outcome: "deleted" | "missing" | "failed" | "skipped" | "orphaned"): void {
  cleanup.add(1, { provider: oneOf(provider, ["docker", "kubernetes", "none"] as const, "other"), outcome });
}

export function startBakeSpan(buildId: string, dimensions: PrebuildDimensions): Span {
  return trace.getTracer("@valet/api-prebuilds").startSpan("prebuild.bake", {
    attributes: { ...boundedPrebuildAttributes(dimensions), "valet.prebuild.build_id": buildId },
  });
}

export function logPrebuildEvent(event: string, details: Record<string, unknown>): void {
  console.log(JSON.stringify({ component: "prebuild", event, ...details }));
}
