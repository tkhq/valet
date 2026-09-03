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
