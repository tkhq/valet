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

describe("delivery destination metrics", () => {
  it("counts each destination reason, a claim skip, and a dead pin", async () => {
    metrics.disable();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    metrics.setGlobalMeterProvider(provider);
    // Load a fresh module after this test installs its recordable provider.
    vi.resetModules();
    const { recordDeliveryDestination, destinationMetricReason, recordAttentionDeliveryFailure } = await import("./delivery-metrics.js");

    recordDeliveryDestination(destinationMetricReason({ kind: "key", key: "sub:r1", title: "R1", reason: "policy_own" }));
    recordDeliveryDestination(destinationMetricReason({ kind: "key", key: "sub:r1", title: "R1", reason: "policy_own" }));
    recordDeliveryDestination(destinationMetricReason({ kind: "skip", reason: "claimed by thread thr-1" }));
    recordDeliveryDestination("pin_unavailable");
    recordAttentionDeliveryFailure(false);
    recordAttentionDeliveryFailure(true);
    await provider.forceFlush();

    const metric = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === "valet_event_delivery_destination");
    if (!metric || metric.dataPointType !== DataPointType.SUM) throw new Error("expected a counter metric");
    const byReason = Object.fromEntries(metric.dataPoints.map((point) => [String(point.attributes.reason), point.value]));
    expect(byReason).toEqual({ policy_own: 2, claim_skip: 1, pin_unavailable: 1 });

    const attention = exporter.getMetrics().flatMap(resource => resource.scopeMetrics).flatMap(scope => scope.metrics)
      .find(candidate => candidate.descriptor.name === "valet_attention_delivery_failures");
    if (!attention || attention.dataPointType !== DataPointType.SUM) throw new Error("expected an attention failure counter");
    expect(Object.fromEntries(attention.dataPoints.map(point => [String(point.attributes.retry), point.value]))).toEqual({ false: 1, true: 1 });

    await provider.shutdown();
  });
});
