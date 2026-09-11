import { afterEach, describe, expect, it, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

afterEach(() => metrics.disable());

async function testMetrics() {
  metrics.disable();
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
  });
  metrics.setGlobalMeterProvider(provider);
  vi.resetModules();
  const lifecycle = await import("./prebuild-lifecycle.js");
  return { exporter, provider, lifecycle };
}

function metricNamed(exporter: InMemoryMetricExporter, name: string) {
  return exporter.getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((metric) => metric.descriptor.name === name);
}

describe("prebuild lifecycle metrics", () => {
  it("emits request, transition, latency, size, registry, and queue signals", async () => {
    const { exporter, provider, lifecycle } = await testMetrics();
    const dimensions = { sourceKind: "repo", profile: "full", provider: "kubernetes" };
    lifecycle.recordPrebuildRequest(dimensions, "accepted", "scheduler");
    lifecycle.recordPrebuildTransition(dimensions, "started");
    lifecycle.recordPrebuildTransition(dimensions, "succeeded");
    lifecycle.recordPrebuildQueueWait(dimensions, 250);
    lifecycle.recordPrebuildCompletion(dimensions, 2_000, 4096);
    lifecycle.recordRegistryOperation("lookup", "success", 12, 4096);
    lifecycle.recordRegistryReconciliation("present");
    lifecycle.updatePrebuildQueueSnapshot([{
      ...dimensions,
      queued: 2,
      active: 1,
      oldestQueuedAgeSeconds: 45,
      latest: { queued: 2, pushed: 3 },
    }]);
    await provider.forceFlush();

    for (const name of [
      "valet.prebuild.requests",
      "valet.prebuild.builds",
      "valet.prebuild.queue_wait",
      "valet.prebuild.build.duration",
      "valet.prebuild.image.size",
      "valet.prebuild.registry.operations",
      "valet.prebuild.registry.duration",
      "valet.prebuild.registry.bytes",
      "valet.prebuild.registry.reconciliations",
      "valet.prebuild.queue.depth",
      "valet.prebuild.queue.oldest_age",
      "valet.prebuild.builds.active",
      "valet.prebuild.bakes.latest",
    ]) {
      expect(metricNamed(exporter, name), name).toBeDefined();
    }
    const queue = metricNamed(exporter, "valet.prebuild.queue.depth");
    expect(queue?.dataPointType).toBe(DataPointType.GAUGE);
    if (!queue || queue.dataPointType !== DataPointType.GAUGE) throw new Error("expected queue gauge");
    expect(queue.dataPoints[0]?.value).toBe(2);
    await provider.shutdown();
  });

  it("collapses unbounded source values before they become labels", async () => {
    const { exporter, provider, lifecycle } = await testMetrics();
    const hostile = {
      sourceKind: "https://github.com/private/repository",
      profile: "digest:sha256:secret",
      provider: "user-123",
    };
    lifecycle.recordPrebuildRequest(hostile, "accepted", "manual");
    lifecycle.updatePrebuildQueueSnapshot([{ ...hostile, queued: 1, active: 0, oldestQueuedAgeSeconds: 1 }]);
    await provider.forceFlush();

    for (const name of ["valet.prebuild.requests", "valet.prebuild.queue.depth"]) {
      const metric = metricNamed(exporter, name);
      expect(metric).toBeDefined();
      const attributes = metric?.dataPointType === DataPointType.SUM || metric?.dataPointType === DataPointType.GAUGE
        ? metric.dataPoints[0]?.attributes
        : undefined;
      expect(attributes).toMatchObject({ source_kind: "other", profile: "other", provider: "other" });
      expect(JSON.stringify(attributes)).not.toContain("github.com");
      expect(JSON.stringify(attributes)).not.toContain("sha256");
      expect(JSON.stringify(attributes)).not.toContain("user-123");
    }
    await provider.shutdown();
  });
});
