/**
 * Loopback stand-ins for ttyd and code-server: two tiny Hono servers, each
 * with an HTTP marker route and a WS echo route. Used by gateway.test.ts and
 * ws-proxy.test.ts to exercise the real proxy/auth code against a live
 * (but fake) backend instead of mocking `fetch`/`WebSocket`.
 */
import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSMessageReceive } from "hono/ws";

/** Node's `ws`-backed WSContext only ever delivers `string` or `ArrayBuffer`
 * payloads (never `Blob` — that's a browser-only WebSocket case), but the
 * shared `WSMessageReceive` type includes `Blob` for portability. Narrow
 * before echoing back so `.send()`'s stricter type accepts it. */
function toEchoable(data: WSMessageReceive): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  throw new Error("fake-backend: unsupported websocket message payload (Blob)");
}

export interface FakeBackend {
  ttydPort: number;
  vscodePort: number;
  /** `Sec-WebSocket-Protocol` request header seen on the most recent ttyd WS
   * upgrade, if any — lets a test assert the gateway forwards the "tty"
   * subprotocol to the real ttyd backend. */
  lastTtydProtocol(): string | undefined;
  /** Same, for the vscode target (expected to stay undefined). */
  lastVscodeProtocol(): string | undefined;
  close(): Promise<void>;
}

function buildEchoApp(
  marker: string,
  recordProtocol: (proto: string | undefined) => void,
): { app: Hono; inject: (server: ServerType) => void } {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  // A single "/*" route (Hono's wildcard matches the literal root too) with
  // the WS-upgrade middleware chained ahead of the plain-text fallback:
  // `upgradeWebSocket` only completes an upgrade when the request actually
  // carries `Upgrade: websocket`; otherwise it calls `next()` and falls
  // through to the marker handler. A separate literal "/" route would win
  // over "/*" for exact-root requests (Hono prioritizes literal matches),
  // silently answering WS upgrade requests to "/" with a plain 200 instead
  // of upgrading — which is exactly the bug this single-route shape avoids.
  app.get(
    "/*",
    upgradeWebSocket((c) => {
      recordProtocol(c.req.header("sec-websocket-protocol") ?? undefined);
      return {
        onMessage(evt, ws) {
          ws.send(toEchoable(evt.data));
        },
      };
    }),
    (c) => c.text(marker),
  );

  return { app, inject: injectWebSocket };
}

function listenAddress(server: ServerType): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

export async function startFakeBackend(): Promise<FakeBackend> {
  let lastTtyd: string | undefined;
  let lastVscode: string | undefined;

  const ttyd = buildEchoApp("ttyd-ok", (p) => {
    lastTtyd = p;
  });
  const vscode = buildEchoApp("vscode-ok", (p) => {
    lastVscode = p;
  });

  const ttydServer: ServerType = serve({ fetch: ttyd.app.fetch, port: 0 });
  ttyd.inject(ttydServer);
  const vscodeServer: ServerType = serve({ fetch: vscode.app.fetch, port: 0 });
  vscode.inject(vscodeServer);

  return {
    ttydPort: listenAddress(ttydServer),
    vscodePort: listenAddress(vscodeServer),
    lastTtydProtocol: () => lastTtyd,
    lastVscodeProtocol: () => lastVscode,
    close: () =>
      Promise.all([
        new Promise<void>((resolve) => ttydServer.close(() => resolve())),
        new Promise<void>((resolve) => vscodeServer.close(() => resolve())),
      ]).then(() => undefined),
  };
}
