import { afterEach, describe, expect, it, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { parseCgroupMemory, readCgroupMemory, summarizeSamples, type ProcessSample } from "./process-health.js";

function sample(at: number, rssBytes: number, loopP99Ms: number, loopMaxMs = loopP99Ms): ProcessSample {
  return { at, rssBytes, heapUsedBytes: rssBytes / 2, heapTotalBytes: rssBytes, externalBytes: 0, arrayBuffersBytes: 0, loopP50Ms: 1, loopP99Ms, loopMaxMs };
}

afterEach(() => metrics.disable());

describe("cgroup memory", () => {
  it("reads v2 usage and limit, and treats max as no limit", () => {
    expect(parseCgroupMemory("4096\n", "8192\n")).toEqual({ usageBytes: 4096, limitBytes: 8192 });
    expect(parseCgroupMemory("4096\n", "max\n")).toEqual({ usageBytes: 4096 });
    expect(parseCgroupMemory(undefined, "8192")).toBeUndefined();
  });

  it("falls back to cgroup v1 and drops its no-limit sentinel", () => {
    const files: Record<string, string> = {
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": "100",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
    };
    expect(readCgroupMemory((path) => files[path])).toEqual({ usageBytes: 100 });
    expect(readCgroupMemory(() => undefined)).toBeUndefined();
  });
});

describe("summarizeSamples", () => {
  it("takes peaks over the samples inside the window", () => {
    const window = summarizeSamples([sample(1_000, 900, 400, 2_000), sample(2_000, 300, 20), sample(3_000, 500, 30, 45)], 2_000);
    expect(window).toEqual({ since: 2_000, samples: 2, peakRssBytes: 500, peakHeapUsedBytes: 250, eventLoopP99MaxMs: 30, eventLoopMaxMs: 45 });
    expect(summarizeSamples([], 0)).toEqual({ since: 0, samples: 0 });
  });
});

describe("process gauges", () => {
  it("exports memory by kind, the heap limit, event-loop delay, and the start time", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(provider);
    vi.resetModules();
    const health = await import("./process-health.js");
    const stop = health.startProcessHealthSampler(60_000);
    health.recordProcessSampleForTest(sample(Date.now(), 1_000, 12, 80));
    await provider.forceFlush();
    stop();
    const exported = exporter.getMetrics().flatMap((resource) => resource.scopeMetrics).flatMap((scope) => scope.metrics);
    const points = (name: string) => exported.find((metric) => metric.descriptor.name === name)?.dataPoints ?? [];
    expect(points("valet.process.memory").map((point) => point.attributes.kind)).toEqual(expect.arrayContaining(["rss", "heap_used", "heap_total"]));
    expect(points("valet.process.event_loop.delay").map((point) => [point.attributes.quantile, point.value])).toEqual([["p50", 1], ["p99", 12], ["max", 80]]);
    expect(points("valet.process.heap_limit")[0]?.value).toBeGreaterThan(0);
    expect(points("valet.process.start_time")[0]?.value).toBeLessThanOrEqual(Date.now() / 1_000);
    health.resetProcessSamples();
    await provider.shutdown();
  });
});
