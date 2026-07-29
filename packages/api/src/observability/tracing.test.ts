/**
 * HTTP middleware + traced-store coverage (distributed tracing). Registers a
 * real in-memory SDK per test so spans are recordable, and restores the
 * no-op globals after.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { activeTraceparent } from "@valet/engine";
import { traceRequests } from "./http-middleware.js";
import { tracedSessionStore } from "./traced-store.js";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const cm = new AsyncLocalStorageContextManager();
  cm.enable();
  otelContext.setGlobalContextManager(cm);
  otelTrace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  otelTrace.disable();
  otelContext.disable();
});

describe("traceRequests middleware", () => {
  it("wraps handlers in an active server span named for the matched route", async () => {
    const app = new Hono();
    app.use("*", traceRequests());
    let insideTraceparent: string | undefined;
    app.get("/api/sessions/:id", (c) => {
      insideTraceparent = activeTraceparent();
      return c.json({ ok: true });
    });
    const res = await app.request("/api/sessions/s_123");
    expect(res.status).toBe(200);
    // The handler ran INSIDE the request span — this is what lets engine
    // admission stamp the queue item's traceparent.
    expect(insideTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("GET /api/sessions/:id");
    expect(spans[0].attributes["http.response.status_code"]).toBe(200);
    expect(spans[0].attributes["url.path"]).toBe("/api/sessions/s_123");
  });

  it("marks 5xx responses as error spans and excludes /api/health", async () => {
    const app = new Hono();
    app.use("*", traceRequests());
    app.get("/api/health", (c) => c.json({ ok: true }));
    app.get("/boom", (c) => c.json({ err: true }, 500));
    await app.request("/api/health");
    await app.request("/boom");
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1); // health excluded
    expect(spans[0].name).toBe("GET /boom");
    expect(spans[0].status.code).toBe(2); // SpanStatusCode.ERROR
  });
});

describe("tracedSessionStore", () => {
  it("wraps store methods in store.* spans and passes results through", async () => {
    const calls: string[] = [];
    const fake = {
      getQueueItem: async (sessionId: string, itemId: string) => {
        calls.push(`${sessionId}/${itemId}`);
        return null;
      },
    };
    const traced = tracedSessionStore(fake);
    const result = await traced.getQueueItem("s1", "q1");
    expect(result).toBeNull();
    expect(calls).toEqual(["s1/q1"]);
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["store.getQueueItem"]);
  });

  it("records thrown store errors on the span and rethrows", async () => {
    const fake = {
      saveSession: async (): Promise<void> => {
        throw new Error("pg down");
      },
    };
    const traced = tracedSessionStore(fake);
    await expect(traced.saveSession()).rejects.toThrow("pg down");
    const spans = exporter.getFinishedSpans();
    expect(spans[0].name).toBe("store.saveSession");
    expect(spans[0].status.code).toBe(2);
  });
});
