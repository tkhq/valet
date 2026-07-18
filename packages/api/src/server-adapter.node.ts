/**
 * Node server adapter: `@hono/node-server` `serve()` + `@hono/node-ws`
 * `createNodeWebSocket()`. This is the default path (`make dev-local`, the
 * esbuild node bundle, every existing test boot). It is import-safe under Bun
 * too, but is never *called* there — the composition root passes the Bun
 * adapter when `isBunRuntime()`.
 */
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Hono } from "hono";
import type { AppEnv } from "./env.js";
import type { RunningServer, ServeOptions, ServerAdapter, WebSocketBinding } from "./server-adapter.js";

export const nodeServerAdapter: ServerAdapter = {
  runtime: "node",

  createWebSocket(app: Hono<AppEnv>): WebSocketBinding {
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    return {
      upgradeWebSocket,
      serve(opts: ServeOptions): RunningServer {
        let boundPort = opts.port;
        const server = serve({ fetch: app.fetch, port: opts.port }, (info) => {
          boundPort = info.port;
          opts.onListen?.(info.port);
        });
        // Attach the WS upgrade handler to the running http server.
        injectWebSocket(server);
        return {
          get port() {
            return boundPort;
          },
          close: () => new Promise<void>((res) => server.close(() => res())),
        };
      },
    };
  },
};
