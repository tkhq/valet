import { afterEach, describe, expect, it, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, DataPointType, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

afterEach(() => {
  vi.restoreAllMocks();
  metrics.disable();
});

describe("valet.errors", () => {
  it("counts each reported error path under its area, reason, and provider", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(provider);
    // The engine creates its instruments once: load a fresh copy after this
    // test installs a recordable provider.
    vi.resetModules();
    const { reportError } = await import("@valet/engine");
    vi.spyOn(console, "error").mockImplementation(() => {});
    reportError({ area: "channels", reason: "outbound_delivery", provider: "slack" }, "send failed", new Error("x"));
    reportError({ area: "channels", reason: "outbound_delivery", provider: "slack" }, "send failed", new Error("y"));
    reportError({ area: "api", reason: "unhandled_rejection" }, "unhandledRejection", "z");
    await provider.forceFlush();
    const metric = exporter.getMetrics().flatMap((resource) => resource.scopeMetrics).flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === "valet.errors");
    if (!metric || metric.dataPointType !== DataPointType.SUM) throw new Error("expected the valet.errors counter");
    expect(metric.dataPoints.map((point) => [point.attributes, point.value])).toEqual(expect.arrayContaining([
      [{ area: "channels", reason: "outbound_delivery", provider: "slack" }, 2],
      [{ area: "api", reason: "unhandled_rejection" }, 1],
    ]));
    await provider.shutdown();
  });
});
