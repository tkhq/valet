/**
 * `reportError`: one error path that does not throw must mark the active
 * span, write one trace-aware JSON log line, and land in the in-process
 * tally under bounded labels. The counter itself is covered in the api
 * package, which has the metrics SDK.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode, context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { MAX_ERROR_SERIES, recentErrorReports, reportError, resetErrorReports } from "../src/index.js";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

beforeEach(() => {
  resetErrorReports();
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);
  otelTrace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await provider.shutdown();
  otelTrace.disable();
  otelContext.disable();
});

describe("reportError", () => {
  it("marks the active span with the area and reason, never the error text", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    otelTrace.getTracer("test").startActiveSpan("request", (span) => {
      reportError({ area: "channels", reason: "outbound_delivery", provider: "slack" }, "[channels] outbound delivery failed",
        new TypeError("fetch https://hooks.example/T0/secret failed"));
      span.end();
    });
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "channels.outbound_delivery" });
    expect(span?.attributes).toMatchObject({
      "valet.error.area": "channels",
      "valet.error.reason": "outbound_delivery",
      "valet.error.provider": "slack",
    });
    expect(span?.events.map((event) => event.attributes)).toEqual([{ "exception.type": "TypeError" }]);
    expect(JSON.stringify(span?.attributes)).not.toContain("secret");
  });

  it("writes one JSON log line stamped with the trace and the error", () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: string) => { lines.push(line); });
    let traceId = "";
    otelTrace.getTracer("test").startActiveSpan("sweep", (span) => {
      traceId = span.spanContext().traceId;
      reportError({ area: "events", reason: "dispatch_poll", level: "warn", fields: { deliveryId: "d1" } },
        "event dispatcher poll failed", new Error("connection reset"));
      span.end();
    });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "warn",
      message: "event dispatcher poll failed",
      area: "events",
      reason: "dispatch_poll",
      deliveryId: "d1",
      error: "connection reset",
      error_class: "Error",
      trace_id: traceId,
    });
    expect(typeof entry.stack).toBe("string");
  });

  it("logs without trace ids when no span is active", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => { lines.push(line); });
    reportError({ area: "boot", reason: "model_registry_start" }, "modelRegistry.start failed", { code: 503 });
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.trace_id).toBeUndefined();
    expect(entry.error).toBe('{"code":503}');
  });

  it("keeps caller fields from replacing the level or the message", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => { lines.push(line); });
    reportError({ area: "api", reason: "route_error", fields: { level: "info", message: "spoofed" } }, "route error");
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "error", message: "route error" });
  });
});

describe("error labels and tally", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("counts reports per series inside the window, most frequent first", () => {
    const now = 10 * 60 * 60_000;
    reportError({ area: "workflows", reason: "schedule_fire" }, "fire failed", undefined, now - 2 * 60 * 60_000);
    reportError({ area: "workflows", reason: "schedule_fire" }, "fire failed", undefined, now - 5 * 60_000);
    reportError({ area: "channels", reason: "stream_append", provider: "slack" }, "append failed", undefined, now - 60_000);
    reportError({ area: "channels", reason: "stream_append", provider: "slack" }, "append failed", undefined, now);
    expect(recentErrorReports({ sinceMs: 0, limit: 10, now })).toEqual([
      { area: "channels", reason: "stream_append", provider: "slack", count: 2, lastAt: now },
      { area: "workflows", reason: "schedule_fire", count: 1, lastAt: now - 5 * 60_000 },
    ]);
    expect(recentErrorReports({ sinceMs: now - 2 * 60_000, limit: 10, now }).map((row) => row.reason)).toEqual(["stream_append"]);
  });

  it("replaces a label that is not a fixed name", () => {
    reportError({ area: "plugins", reason: "Refresh failed for org_123!", provider: "GitHub App" }, "refresh failed");
    expect(recentErrorReports({ sinceMs: 0, limit: 10 })).toMatchObject([{ reason: "invalid_reason", provider: "other" }]);
  });

  it("folds series past the cap into one overflow series per area", () => {
    for (let i = 0; i < MAX_ERROR_SERIES + 5; i += 1) reportError({ area: "engine", reason: `reason_${i}` }, "failed");
    const rows = recentErrorReports({ sinceMs: 0, limit: 1_000 });
    expect(rows).toHaveLength(MAX_ERROR_SERIES + 1);
    expect(rows.find((row) => row.reason === "series_overflow")?.count).toBe(5);
  });
});
