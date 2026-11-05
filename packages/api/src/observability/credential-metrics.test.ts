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

describe("credential metrics", () => {
  it("records each fallback reason with its service on the API meter", async () => {
    metrics.disable();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    metrics.setGlobalMeterProvider(provider);
    // Other files can call the recorder against the no-op global provider.
    // Load a fresh module after this test installs its recordable provider.
    vi.resetModules();
    const { recordAppCredentialFallback } = await import("./credential-metrics.js");

    for (const reason of ["no_personal", "no_delegated", "dead_delegated", "org_owner"] as const) {
      recordAppCredentialFallback("linear", reason);
    }
    await provider.forceFlush();

    const metric = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === "valet.credentials.app_fallback");
    expect(metric?.dataPointType).toBe(DataPointType.SUM);
    if (!metric || metric.dataPointType !== DataPointType.SUM) throw new Error("expected a counter metric");
    expect(metric.dataPoints.map((point) => point.attributes.reason).sort()).toEqual([
      "dead_delegated",
      "no_delegated",
      "no_personal",
      "org_owner",
    ]);
    expect(metric.dataPoints.every((point) => point.attributes.service === "linear")).toBe(true);
    expect(metric.dataPoints.map((point) => point.value)).toEqual([1, 1, 1, 1]);

    await provider.shutdown();
  });
});
