import { afterEach, expect, it, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, DataPointType, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
afterEach(() => metrics.disable());
it("exports a dead-letter counter that can alert on permanent job failure", async () => {
  metrics.disable();
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 })] });
  metrics.setGlobalMeterProvider(provider); vi.resetModules();
  const { recordTaggingDeadLetter } = await import("./tagging-metrics.js");
  recordTaggingDeadLetter("tool_intent"); await provider.forceFlush();
  const metric = exporter.getMetrics().flatMap(resource => resource.scopeMetrics).flatMap(scope => scope.metrics)
    .find(metric => metric.descriptor.name === "valet.tagging.dead_letters");
  if (!metric || metric.dataPointType !== DataPointType.SUM) throw new Error("Expected a dead-letter counter.");
  expect(metric.dataPoints).toEqual([expect.objectContaining({ value: 1, attributes: { dimension: "tool_intent" } })]);
  await provider.shutdown();
});
