import { Hono } from "hono";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../env.js";
import {
  Lifecycle,
  RETRY_AFTER_SECONDS,
  isGatedPath,
  lifecycleGate,
  startBootListener,
  type UnavailableBody,
} from "./lifecycle.js";

/** Server env for a request from another host (the ingress, a sandbox pod). */
const external = { incoming: { socket: { remoteAddress: "10.0.0.5" } } };
/** Server env for a request the process sent itself over loopback. */
const loopback = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

function gatedApp(lifecycle: Lifecycle, handler?: () => Promise<void>) {
  const app = new Hono<AppEnv>();
  app.use("*", lifecycleGate(lifecycle));
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/ready", (c) => c.json({ ready: lifecycle.isReady() }, lifecycle.isReady() ? 200 : 503));
  app.get("/api/things", async (c) => {
    await handler?.();
    return c.json({ things: [] });
  });
  app.post("/mcp", (c) => c.json({ ok: true }));
  app.get("/", (c) => c.text("spa"));
  return app;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Lifecycle state machine", () => {
  it("moves booting → ready → draining and never back to ready", () => {
    const lc = new Lifecycle();
    expect(lc.phase).toBe("booting");
    expect(lc.isReady()).toBe(false);
    lc.markReady();
    expect(lc.phase).toBe("ready");
    expect(lc.isReady()).toBe(true);
    lc.beginDrain();
    expect(lc.phase).toBe("draining");
    lc.markReady();
    expect(lc.phase).toBe("draining");
    expect(lc.isReady()).toBe(false);
  });

  it("a drain during boot stays draining when the boot chain finishes", () => {
    const lc = new Lifecycle();
    lc.beginDrain();
    lc.markReady();
    expect(lc.phase).toBe("draining");
  });

  it("release is idempotent and the count never goes negative", () => {
    const lc = new Lifecycle();
    const release = lc.enter();
    expect(lc.requestsInFlight).toBe(1);
    release();
    release();
    expect(lc.requestsInFlight).toBe(0);
  });

  it("waitForIdle resolves true when the last request ends", async () => {
    const lc = new Lifecycle(1_000);
    lc.markReady();
    const a = lc.enter();
    const b = lc.enter();
    lc.beginDrain();
    let settled: boolean | undefined;
    const waiting = lc.waitForIdle().then((idle) => (settled = idle));
    a();
    await Promise.resolve();
    expect(settled).toBeUndefined();
    b();
    await waiting;
    expect(settled).toBe(true);
  });

  it("waitForIdle gives up at the drain deadline, measured from beginDrain", async () => {
    vi.useFakeTimers();
    const lc = new Lifecycle(10_000);
    lc.markReady();
    lc.enter();
    lc.beginDrain();
    // Time already spent in other shutdown steps counts against the window.
    vi.advanceTimersByTime(7_000);
    let settled: boolean | undefined;
    void lc.waitForIdle().then((idle) => (settled = idle));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
  });

  it("waitForIdle returns false at once when the window has already passed", async () => {
    vi.useFakeTimers();
    const lc = new Lifecycle(1_000);
    lc.markReady();
    lc.enter();
    lc.beginDrain();
    vi.advanceTimersByTime(5_000);
    await expect(lc.waitForIdle()).resolves.toBe(false);
  });
});

describe("isGatedPath", () => {
  it("gates API, MCP, webhook and proxy routes, never health or the SPA", () => {
    expect(isGatedPath("/api/sessions")).toBe(true);
    expect(isGatedPath("/api/ws")).toBe(true);
    expect(isGatedPath("/mcp")).toBe(true);
    expect(isGatedPath("/webhooks/github-app")).toBe(true);
    expect(isGatedPath("/proxy/anthropic/v1/messages")).toBe(true);
    expect(isGatedPath("/api/health")).toBe(false);
    expect(isGatedPath("/api/ready")).toBe(false);
    expect(isGatedPath("/")).toBe(false);
    expect(isGatedPath("/assets/index.js")).toBe(false);
    expect(isGatedPath("/mcp-docs")).toBe(false);
  });
});

describe("lifecycleGate", () => {
  it("answers 503 + Retry-After with a JSON body while booting", async () => {
    const app = gatedApp(new Lifecycle());
    const res = await app.request("/api/things", {}, external);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe(String(RETRY_AFTER_SECONDS));
    const body = (await res.json()) as UnavailableBody;
    expect(body).toEqual({ error: "unavailable", reason: "booting", retryAfterSeconds: RETRY_AFTER_SECONDS });
    expect((await app.request("/mcp", { method: "POST" }, external)).status).toBe(503);
  });

  it("keeps health and the SPA answering while booting", async () => {
    const app = gatedApp(new Lifecycle());
    expect((await app.request("/api/health", {}, external)).status).toBe(200);
    expect((await app.request("/api/ready", {}, external)).status).toBe(503);
    expect((await app.request("/", {}, external)).status).toBe(200);
  });

  it("passes requests once ready", async () => {
    const lc = new Lifecycle();
    lc.markReady();
    const res = await gatedApp(lc).request("/api/things", {}, external);
    expect(res.status).toBe(200);
    expect(lc.requestsInFlight).toBe(0);
  });

  it("answers 503 + Retry-After with reason draining after beginDrain", async () => {
    const lc = new Lifecycle();
    lc.markReady();
    lc.beginDrain();
    const res = await gatedApp(lc).request("/api/things", {}, external);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe(String(RETRY_AFTER_SECONDS));
    expect(((await res.json()) as UnavailableBody).reason).toBe("draining");
  });

  it("never gates loopback or in-process requests: they belong to work in flight", async () => {
    const lc = new Lifecycle();
    lc.markReady();
    lc.beginDrain();
    const app = gatedApp(lc);
    expect((await app.request("/api/things", {}, loopback)).status).toBe(200);
    expect((await app.request("/api/things", {}, { incoming: { socket: { remoteAddress: "::ffff:127.0.0.1" } } })).status).toBe(200);
    // No server env: `app.fetch(inner)` from the MCP tool dispatcher.
    expect((await app.request("/api/things")).status).toBe(200);
  });

  it("reads the peer from Bun's requestIP when there is no Node socket", async () => {
    const lc = new Lifecycle();
    const app = gatedApp(lc);
    const bunEnv = (address: string) => ({ requestIP: () => ({ address }) });
    expect((await app.request("/api/things", {}, bunEnv("10.0.0.9"))).status).toBe(503);
    expect((await app.request("/api/things", {}, bunEnv("::1"))).status).toBe(200);
  });
});

describe("SIGTERM drain ordering", () => {
  it("flips readiness, refuses new requests, finishes in-flight ones, then evicts", async () => {
    const order: string[] = [];
    const lc = new Lifecycle(5_000);
    lc.markReady();
    let finishSlow!: () => void;
    const app = gatedApp(lc, async () => {
      await new Promise<void>((resolve) => (finishSlow = resolve));
      order.push("in-flight handler finished");
    });

    // A request is in flight when the signal arrives.
    const slow = Promise.resolve(app.request("/api/things", {}, external));
    await vi.waitFor(() => expect(lc.requestsInFlight).toBe(1));

    // Mirrors main.ts close(): beginDrain, stop claim loops, wait, evict, close.
    const shutdown = (async () => {
      lc.beginDrain();
      order.push("readiness off");
      order.push("claim loops stopped");
      const idle = await lc.waitForIdle();
      order.push(`drained idle=${idle}`);
      order.push("sessions evicted");
    })();

    expect((await app.request("/api/ready", {}, external)).status).toBe(503);
    const fresh = await app.request("/api/things", {}, external);
    expect(fresh.status).toBe(503);
    order.push("new request 503");

    finishSlow();
    const [slowRes] = await Promise.all([slow, shutdown]);
    expect(slowRes.status).toBe(200);
    expect(order).toEqual([
      "readiness off",
      "claim loops stopped",
      "new request 503",
      "in-flight handler finished",
      "drained idle=true",
      "sessions evicted",
    ]);
  });
});

describe("startBootListener", () => {
  async function freePort(): Promise<number> {
    return await new Promise((resolve) => {
      const probe = createServer().listen(0, () => {
        const addr = probe.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        probe.close(() => resolve(port));
      });
    });
  }

  it("answers every path with 503 + Retry-After, then frees the port", async () => {
    const port = await freePort();
    const listener = await startBootListener(port);
    expect(listener).not.toBeNull();
    for (const path of ["/api/sessions", "/api/health", "/mcp"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe(String(RETRY_AFTER_SECONDS));
      expect(((await res.json()) as UnavailableBody).reason).toBe("booting");
    }
    await listener?.close();
    // The real app binds the same port right after.
    const rebound = await startBootListener(port);
    expect(rebound).not.toBeNull();
    await rebound?.close();
  });

  it("returns null when the port is taken", async () => {
    const port = await freePort();
    const first = await startBootListener(port);
    const second = await startBootListener(port);
    expect(second).toBeNull();
    await first?.close();
  });
});
