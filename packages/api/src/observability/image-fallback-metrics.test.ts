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

describe("valet.sandbox.image_fallback", () => {
  it("emits a 0 point for reason=contract before any fallback", async () => {
    metrics.disable();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    metrics.setGlobalMeterProvider(provider);
    vi.resetModules();
    const { initImageFallbackMetrics } = await import("./image-fallback-metrics.js");

    initImageFallbackMetrics();
    await provider.forceFlush();

    const metric = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === "valet.sandbox.image_fallback");
    if (!metric || metric.dataPointType !== DataPointType.SUM) throw new Error("expected a counter metric");
    expect(metric.dataPoints.map((point) => ({ attributes: point.attributes, value: point.value }))).toEqual([
      { attributes: { reason: "contract" }, value: 0 },
    ]);

    await provider.shutdown();
  });

  it("counts by reason only", async () => {
    metrics.disable();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    metrics.setGlobalMeterProvider(provider);
    // Load a fresh module so the counter binds to this test's provider.
    vi.resetModules();
    const { recordImageFallback } = await import("./image-fallback-metrics.js");

    recordImageFallback("contract");
    recordImageFallback("contract");
    await provider.forceFlush();

    const metric = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === "valet.sandbox.image_fallback");
    if (!metric || metric.dataPointType !== DataPointType.SUM) throw new Error("expected a counter metric");
    expect(metric.dataPoints.map((point) => ({ attributes: point.attributes, value: point.value }))).toEqual([
      { attributes: { reason: "contract" }, value: 2 },
    ]);

    await provider.shutdown();
  });
});
