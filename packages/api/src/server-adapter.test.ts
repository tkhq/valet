/**
 * Server-runtime seam unit tests. Pure — no I/O. Under Node (the only runtime
 * these run in) `isBunRuntime()` must be false and `selectServerAdapter()` must
 * hand back the Node bridge without loading `hono/bun` (which throws on import
 * under Node).
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { isBunRuntime, selectServerAdapter } from "./server-adapter.js";
import { createServer } from "node:http";
import { configureKeepAlive, HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, nodeServerAdapter } from "./server-adapter.node.js";
import type { AppEnv } from "./env.js";

describe("isBunRuntime", () => {
  it("is false under Node (no global Bun)", () => {
    expect(isBunRuntime()).toBe(false);
  });

  it("tracks a temporarily-injected global Bun", () => {
    const g = globalThis as { Bun?: unknown };
    expect(isBunRuntime()).toBe(false);
    g.Bun = {};
    try {
      expect(isBunRuntime()).toBe(true);
    } finally {
      delete g.Bun;
    }
    expect(isBunRuntime()).toBe(false);
  });
});

describe("selectServerAdapter", () => {
  it("returns the Node adapter under Node", async () => {
    const adapter = await selectServerAdapter();
    expect(adapter).toBe(nodeServerAdapter);
    expect(adapter.runtime).toBe("node");
  });
});

describe("nodeServerAdapter.createWebSocket", () => {
  it("exposes an upgradeWebSocket middleware and a serve()", () => {
    const app = new Hono<AppEnv>();
    const binding = nodeServerAdapter.createWebSocket(app);
    expect(typeof binding.upgradeWebSocket).toBe("function");
    expect(typeof binding.serve).toBe("function");
  });

  it("serve() listens on an ephemeral port and close() releases it", async () => {
    const app = new Hono<AppEnv>();
    app.get("/ping", (c) => c.text("pong"));
    const binding = nodeServerAdapter.createWebSocket(app);
    const server = await new Promise<ReturnType<typeof binding.serve>>((resolve) => {
      const handle = binding.serve({ port: 0, onListen: () => resolve(handle) });
    });
    try {
      expect(server.port).toBeGreaterThan(0);
      const res = await fetch(`http://localhost:${server.port}/ping`);
      expect(await res.text()).toBe("pong");
    } finally {
      await server.close();
    }
  });
});

describe("nodeServerAdapter close", () => {
  it("close() resolves while a WebSocket client stays connected", async () => {
    const app = new Hono<AppEnv>();
    const binding = nodeServerAdapter.createWebSocket(app);
    app.get("/ws", binding.upgradeWebSocket(() => ({})));
    const server = await new Promise<ReturnType<typeof binding.serve>>((resolve) => {
      const handle = binding.serve({ port: 0, onListen: () => resolve(handle) });
    });
    const client = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.onopen = () => resolve();
      client.onerror = () => reject(new Error("WebSocket did not open"));
    });
    const closedClient = new Promise<void>((resolve) => { client.onclose = () => resolve(); });
    const started = Date.now();
    await server.close();
    await closedClient;
    // Before, server.close() waited on the open WebSocket forever.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("bunServerAdapter", () => {
  it("raises Bun's idle timeout above the longest MCP wait", async () => {
    // Bun's 10-second default closed a 45-second MCP wait mid-response.
    const g = globalThis as { Bun?: unknown };
    const seen: Array<Record<string, unknown>> = [];
    g.Bun = { serve: (options: Record<string, unknown>) => {
      seen.push(options);
      return { port: 1234, stop: async () => undefined };
    } };
    try {
      const { bunServerAdapter } = await import("./server-adapter.bun.js");
      const { Hono } = await import("hono");
      const binding = bunServerAdapter.createWebSocket(new Hono());
      binding.serve({ port: 0 });
      expect(seen[0]?.idleTimeout).toBe(255);
    } finally {
      delete g.Bun;
    }
  });
});

describe("configureKeepAlive", () => {
  it("keeps idle connections open past nginx's 60 s upstream keep-alive", () => {
    const server = createServer();
    configureKeepAlive(server);
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(HEADERS_TIMEOUT_MS).toBeGreaterThan(KEEP_ALIVE_TIMEOUT_MS);
  });
});
