import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { pendingChannelDeliveries } from "../schema/index.js";
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

it("samples oldest outstanding enqueue age even when retries are scheduled in the future", async () => {
  metrics.disable();
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
  metrics.setGlobalMeterProvider(provider);
  vi.resetModules();
  const { registerAttentionQueueMetrics } = await import("./delivery-metrics.js");
  const { appDb: db } = await freshTestPgDb();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    await db.insert(pendingChannelDeliveries).values([
      { id: "pending", userId: "u", tierId: "dm", event: { kind: "notification", owner: { type: "user", id: "u" }, title: "Update" }, status: "pending", createdAt: now - 1_900_000, deliverAfter: now + 100_000 },
      { id: "sending", userId: "u", tierId: "dm", event: { kind: "notification", owner: { type: "user", id: "u" }, title: "Update" }, status: "sending", createdAt: now - 2_000_000, deliverAfter: now + 200_000 },
      { id: "sent", userId: "u", tierId: "dm", event: { kind: "notification", owner: { type: "user", id: "u" }, title: "Update" }, status: "sent", createdAt: 1, deliverAfter: 1 },
    ]);
    registerAttentionQueueMetrics(db);
    registerAttentionQueueMetrics(db);
    await provider.forceFlush();
    const values = () => exporter.getMetrics().flatMap(resource => resource.scopeMetrics).flatMap(scope => scope.metrics)
      .filter(metric => metric.descriptor.name === "valet_attention_oldest_job_age")
      .flatMap(metric => metric.dataPoints.map(point => point.value));
    expect(values()).toEqual([2_000]);
    await db.delete(pendingChannelDeliveries);
    exporter.reset();
    await provider.forceFlush();
    expect(values()).toEqual([0]);
    const alerts = readFileSync(fileURLToPath(new URL("../../../../deploy/chart/valet/alerts/events.yaml", import.meta.url)), "utf8");
    expect(alerts).toContain("max(valet_attention_oldest_job_age_seconds) > 1800");
    expect(alerts).toContain('valet_attention_delivery_failures_total{retry="true"}');
  } finally { clock.mockRestore(); await provider.shutdown(); }
});
