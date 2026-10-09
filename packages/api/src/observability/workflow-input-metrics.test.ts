import { afterEach, describe, expect, it, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

afterEach(() => {
  metrics.disable();
});

describe("workflow input cleanup metrics", () => {
  it("records each supported outcome on the API meter", async () => {
    metrics.disable();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    metrics.setGlobalMeterProvider(provider);
    // Other files can call the recorder against the no-op global provider.
    // Load a fresh module after this test installs its recordable provider.
    vi.resetModules();
    const { recordWorkflowInputCleanupSkipped } = await import("./workflow-input-metrics.js");

    recordWorkflowInputCleanupSkipped("node", "suspended");
    recordWorkflowInputCleanupSkipped("run", "uncached");
    await provider.forceFlush();

    const metric = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === "valet.workflow.inputs.cleanup_skipped");
    expect(metric?.dataPointType).toBe(DataPointType.SUM);
    if (!metric || metric.dataPointType !== DataPointType.SUM) throw new Error("expected a counter metric");
    expect(metric.dataPoints.map(point => point.attributes)).toEqual([
      { scope: "node", reason: "suspended" }, { scope: "run", reason: "uncached" },
    ]);
    expect(metric.dataPoints.map(point => point.value)).toEqual([1, 1]);

    await provider.shutdown();
  });
});
