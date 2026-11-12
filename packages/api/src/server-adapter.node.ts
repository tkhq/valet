/**
 * Node server adapter: `@hono/node-server` `serve()` + `@hono/node-ws`
 * `createNodeWebSocket()`. This is the default path (`make dev-local`, the
 * esbuild node bundle, every existing test boot). It is import-safe under Bun
 * too, but is never *called* there — the composition root passes the Bun
 * adapter when `isBunRuntime()`.
 */
import { Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Hono } from "hono";
import type { AppEnv } from "./env.js";
import type { RunningServer, ServeOptions, ServerAdapter, WebSocketBinding } from "./server-adapter.js";

/**
 * Idle keep-alive time, above ingress-nginx's 60 s upstream keep-alive.
 * With Node's 5 s default, nginx reused a connection Node had just closed,
 * got "connection reset by peer", and answered 502. nginx does not retry a
 * POST, so a GitHub webhook was lost (agents-dev, 2026-11-09 15:49Z).
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
/** Above the keep-alive time, as Node requires for the timeouts to apply in order. */
export const HEADERS_TIMEOUT_MS = 66_000;

/** Keep idle connections open longer than the proxy in front of the api. */
export function configureKeepAlive(server: HttpServer): void {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}

export const nodeServerAdapter: ServerAdapter = {
  runtime: "node",

  createWebSocket(app: Hono<AppEnv>): WebSocketBinding {
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    return {
      upgradeWebSocket,
      serve(opts: ServeOptions): RunningServer {
        let boundPort = opts.port;
        // `overrideGlobalObjects: false` keeps Node's own `Request`/`Response`
        // on `globalThis`. By default `serve()` replaces both with its own
        // subclasses, and a WASM SDK that builds requests from those globals
        // then fails: the 1Password client rejects every call with
        // "request library compatibility issue ... reqwest library: error
        // sending request" from the moment the listener starts, at boot and in
        // every request alike. Hono reads the natives fine; the override is a
        // throughput optimisation, and correctness for in-process SDKs is
        // worth more than it. See `onepassword.live-server.test.ts`, which
        // fails without this line.
        const server = serve({ fetch: app.fetch, port: opts.port, overrideGlobalObjects: false }, (info) => {
          boundPort = info.port;
          opts.onListen?.(info.port);
        });
        if (server instanceof HttpServer) configureKeepAlive(server);
        // Attach the WS upgrade handler to the running http server.
        injectWebSocket(server);
        // Every open socket, upgraded WebSockets included. `server.close()`
        // waits for all of them, and a WebSocket client never closes on its
        // own, so shutdown sat until the 20 s hard exit. The set holds only
        // live sockets: each one leaves on its own `close`.
        const sockets = new Set<Socket>();
        server.on("connection", (socket: Socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        return {
          get port() {
            return boundPort;
          },
          // The caller drains in-flight requests first (`Lifecycle.waitForIdle`),
          // so what remains is idle keep-alive and WebSocket sockets. Clients
          // reconnect to the next process.
          close: () => new Promise<void>((res) => {
            server.close(() => res());
            for (const socket of sockets) socket.destroy();
          }),
        };
      },
    };
  },
};
