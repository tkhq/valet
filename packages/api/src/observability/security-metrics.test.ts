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

/**
 * Runs `record` against a fresh module import bound to an isolated
 * in-memory OTel provider, flushes it, and returns the one metric collected
 * under `name`. Each call resets modules so a test never sees an instrument
 * cached against a previous test's provider.
 */
async function collect(
  name: string,
  record: (mod: typeof import("./security-metrics.js")) => void,
) {
  metrics.disable();
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
  });
  metrics.setGlobalMeterProvider(provider);
  vi.resetModules();
  const mod = await import("./security-metrics.js");

  record(mod);
  await provider.forceFlush();

  const metric = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((candidate) => candidate.descriptor.name === name);

  await provider.shutdown();
  return metric;
}

describe("recordSecurityEngagementCredentialCount", () => {
  it("records the declared credential count with no per-id attributes", async () => {
    const declared = [
      { label: "admin", kind: "password", env: "ADMIN_PASSWORD", reference: "op://vault/admin/password" },
      { label: "gh-token", kind: "headerToken", env: "GH_TOKEN", reference: "op://vault/gh/token" },
    ];

    const metric = await collect("valet.security.engagement.credentials_declared", (mod) =>
      mod.recordSecurityEngagementCredentialCount(declared.length),
    );

    expect(metric?.dataPointType).toBe(DataPointType.HISTOGRAM);
    if (!metric || metric.dataPointType !== DataPointType.HISTOGRAM) {
      throw new Error("expected a histogram metric");
    }
    expect(metric.dataPoints).toHaveLength(1);
    expect(metric.dataPoints[0].value.count).toBe(1);
    expect(metric.dataPoints[0].value.sum).toBe(2);
    expect(metric.dataPoints[0].attributes).toEqual({});
  });

  it("records a count of 0 when nothing is declared", async () => {
    const metric = await collect("valet.security.engagement.credentials_declared", (mod) =>
      mod.recordSecurityEngagementCredentialCount(0),
    );

    expect(metric?.dataPointType).toBe(DataPointType.HISTOGRAM);
    if (!metric || metric.dataPointType !== DataPointType.HISTOGRAM) {
      throw new Error("expected a histogram metric");
    }
    expect(metric.dataPoints).toHaveLength(1);
    expect(metric.dataPoints[0].value.sum).toBe(0);
    expect(metric.dataPoints[0].attributes).toEqual({});
  });
});

describe("recordSecurityCredentialFragmentAlert", () => {
  it("counts each alert with no per-id attributes", async () => {
    metrics.disable();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    metrics.setGlobalMeterProvider(provider);
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { recordSecurityCredentialFragmentAlert } = await import("./security-metrics.js");

    recordSecurityCredentialFragmentAlert({ sessionId: "sess_1", engagementId: "eng_1" });
    recordSecurityCredentialFragmentAlert({ sessionId: "sess_2", engagementId: "eng_2" });
    await provider.forceFlush();

    const metric = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === "valet.security.credential_fragment_alerts");
    expect(metric?.dataPointType).toBe(DataPointType.SUM);
    if (!metric || metric.dataPointType !== DataPointType.SUM) throw new Error("expected a counter metric");
    // Session and engagement ids are unbounded: they belong in the log line,
    // never on the metric.
    expect(metric.dataPoints).toHaveLength(1);
    expect(metric.dataPoints[0].attributes).toEqual({});
    expect(metric.dataPoints[0].value).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain("sess_1");

    warn.mockRestore();
    await provider.shutdown();
  });
});
