/**
 * Bun server adapter: `Bun.serve()` + `hono/bun` `createBunWebSocket()`. Only
 * loaded via `selectServerAdapter`'s dynamic `import()` under `isBunRuntime()`
 * — `hono/bun` throws `Bun is not defined` at module-load under Node, so this
 * file must never be statically imported from a Node-reachable module.
 *
 * Under Bun there is NO `injectWebSocket` step: the `websocket` handler from
 * `createBunWebSocket()` is handed straight to `Bun.serve({ ..., websocket })`,
 * which performs the real `101` upgrade + frame streaming + close.
 */
import { createBunWebSocket } from "hono/bun";
import type { Hono } from "hono";
import type { AppEnv } from "./env.js";
import type { RunningServer, ServeOptions, ServerAdapter, WebSocketBinding } from "./server-adapter.js";

/** The Bun `websocket` handler object produced alongside `upgradeWebSocket`. */
type BunWebSocketHandler = ReturnType<typeof createBunWebSocket>["websocket"];

/** Minimal shape of the `Bun.serve` return value we depend on. */
interface BunServer {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
}

interface BunServeOptions {
  fetch: Hono<AppEnv>["fetch"];
  port: number;
  websocket: BunWebSocketHandler;
}

interface BunGlobal {
  serve(options: BunServeOptions): BunServer;
}

/**
 * Bridge to the Bun runtime global. Typed narrowly (only `serve`) rather than
 * pulling in `bun-types`, which would collide with `@types/node` globals in a
 * package that must also typecheck under Node.
 */
function bunGlobal(): BunGlobal {
  const g = globalThis as { Bun?: BunGlobal };
  if (!g.Bun) throw new Error("bunServerAdapter used outside the Bun runtime");
  return g.Bun;
}

export const bunServerAdapter: ServerAdapter = {
  runtime: "bun",

  createWebSocket(app: Hono<AppEnv>): WebSocketBinding {
    // Bun's WS handler is app-independent, but `upgradeWebSocket` and
    // `websocket` must come from the SAME call (they share internal state).
    const { upgradeWebSocket, websocket } = createBunWebSocket();
    return {
      upgradeWebSocket,
      serve(opts: ServeOptions): RunningServer {
        const server = bunGlobal().serve({
          fetch: app.fetch,
          port: opts.port,
          websocket,
        });
        opts.onListen?.(server.port);
        return {
          port: server.port,
          // `stop(true)` FORCE-closes in-flight connections rather than draining
          // them (the Node adapter's `server.close()` drains). This is
          // deliberate and safe here: callers evict sandboxes BEFORE close(),
          // and the signal handler has a 5s hard-exit guard — a compiled binary
          // shutting down does not need to wait for open WS streams to finish.
          close: async () => {
            await server.stop(true);
          },
        };
      },
    };
  },
};
