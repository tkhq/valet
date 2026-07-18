/**
 * Server-runtime seam unit tests. Pure — no I/O. Under Node (the only runtime
 * these run in) `isBunRuntime()` must be false and `selectServerAdapter()` must
 * hand back the Node bridge without loading `hono/bun` (which throws on import
 * under Node).
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { isBunRuntime, selectServerAdapter } from "./server-adapter.js";
import { nodeServerAdapter } from "./server-adapter.node.js";
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
