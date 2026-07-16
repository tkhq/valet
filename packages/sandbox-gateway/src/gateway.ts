/**
 * JWT-gated reverse proxy for the sandbox's interactive services.
 *
 * Routes:
 *   /health    -> 200 { status: "ok" }, no auth
 *   /ttyd/*    -> 127.0.0.1:{targets.ttyd}    (web terminal)
 *   /vscode/*  -> 127.0.0.1:{targets.vscode}  (code-server)
 *
 * Auth: cookie-first (in-memory session map, see `session.ts`), falling back
 * to a `?token=`/`Bearer` gateway JWT (see `jwt.ts`) which mints a fresh
 * session cookie on success. WebSocket upgrades for the same two prefixes
 * are handled by `ws-proxy.ts`, registered onto this same app.
 *
 * Lifted from `packages/runner/src/gateway.ts` (the legacy Bun gateway):
 * `createProxyHeaders`, the fetch-based proxy body, and the cookie
 * constants. Deliberately NOT lifted: that module's module-level
 * `pendingSessionCookie` singleton, which raced under concurrent requests —
 * here the session cookie is threaded through as a local value and applied
 * to the response via `c.header("Set-Cookie", …)` in the same handler that
 * computed it.
 */
import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status";
import { Server } from "node:http";
import { registerWsProxyRoutes } from "./ws-proxy.js";
import { bearerToken, resolveAuth, sessionCookieHeader, SessionStore } from "./session.js";

export interface SandboxGatewayTargets {
  ttyd: number;
  vscode: number;
}

export interface StartGatewayOpts {
  port: number;
  sessionId: string;
  jwtSecret: string;
  targets: SandboxGatewayTargets;
}

export interface GatewayHandle {
  server: Server;
  close(): Promise<void>;
}

const HOP_BY_HOP_HEADERS = new Set([
  "accept-encoding",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "host",
]);

/** Strips compression/hop-by-hop headers and forces uncompressed upstream
 * responses so proxying doesn't have to re-encode. */
function createProxyHeaders(rawHeaders: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of rawHeaders.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  headers.set("Accept-Encoding", "identity");
  return headers;
}

/** Drops the `token` query param before forwarding upstream — backend
 * services never need to see it. */
function upstreamSearch(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete("token");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

type ProxyRequestInit = RequestInit & { duplex?: "half" };

const CONTENTLESS_STATUS_CODES = new Set([101, 204, 205, 304]);

/** Hono types `.body()`'s status param as the closed `StatusCode` union, but
 * an upstream backend's response status is just `number` — nothing proves
 * at compile time it falls in that union. Runtime-validate against the
 * legal HTTP status range and assert; anything outside it means the
 * upstream response itself is broken, so it's reported as a 502 instead of
 * forwarded verbatim. */
function asStatusCode(status: number): StatusCode {
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return status as StatusCode;
  }
  return 502;
}

/** As `asStatusCode`, but for the "response has a body" branch, where
 * `c.body()` requires the narrower `ContentfulStatusCode` (excludes
 * bodyless codes like 204/304 — a body present alongside one of those would
 * mean the upstream response is malformed anyway). */
function asContentfulStatusCode(status: number): ContentfulStatusCode {
  if (Number.isInteger(status) && status >= 100 && status <= 599 && !CONTENTLESS_STATUS_CODES.has(status)) {
    return status as ContentfulStatusCode;
  }
  return 502;
}

async function proxyHttp(c: Context, serviceName: string, targetPort: number, prefix: string): Promise<Response> {
  const url = new URL(c.req.url);
  const path = url.pathname.slice(prefix.length) || "/";
  const target = `http://127.0.0.1:${targetPort}${path}${upstreamSearch(url)}`;
  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";

  try {
    const init: ProxyRequestInit = {
      method: c.req.method,
      headers: createProxyHeaders(c.req.raw.headers),
      body: hasBody ? c.req.raw.body : undefined,
      duplex: hasBody ? "half" : undefined,
    };
    const res = await fetch(target, init);

    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    // Route through `c.body()` (not a bare `new Response()`) so any
    // `Set-Cookie` queued via `c.header()` earlier in this handler gets
    // merged in — Hono only folds pending headers into responses built via
    // its own `c.body`/`c.text`/`c.json`, not into a Response constructed
    // and returned directly.
    return res.body
      ? c.body(res.body, { status: asContentfulStatusCode(res.status), statusText: res.statusText, headers })
      : c.body(null, { status: asStatusCode(res.status), statusText: res.statusText, headers });
  } catch {
    return c.body(`${serviceName} is not reachable`, { status: 502 });
  }
}

function registerProxyRoute(opts: {
  app: Hono;
  prefix: string;
  serviceName: string;
  targetPort: number;
  sessions: SessionStore;
  secret: string;
  sessionId: string;
}): void {
  opts.app.all(`${opts.prefix}/*`, async (c) => {
    const url = new URL(c.req.url);
    const auth = resolveAuth({
      cookieHeader: c.req.header("Cookie"),
      token: url.searchParams.get("token") ?? bearerToken(c.req.header("Authorization")),
      secret: opts.secret,
      expectedSid: opts.sessionId,
      sessions: opts.sessions,
    });
    if (!auth) return c.text("Unauthorized", 401);
    if (auth.newCookieToken) {
      c.header("Set-Cookie", sessionCookieHeader(auth.newCookieToken));
    }
    return proxyHttp(c, opts.serviceName, opts.targetPort, opts.prefix);
  });
}

/** Builds and starts the gateway HTTP+WS server. Callers own lifecycle via
 * the returned `close()`. */
export function startGateway(opts: StartGatewayOpts): GatewayHandle {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  const sessions = new SessionStore();

  app.get("/health", (c) => c.json({ status: "ok" }));

  registerWsProxyRoutes({
    app,
    upgradeWebSocket,
    sessions,
    secret: opts.jwtSecret,
    sessionId: opts.sessionId,
    targets: [
      { prefix: "/ttyd", port: opts.targets.ttyd, subprotocol: "tty" },
      { prefix: "/vscode", port: opts.targets.vscode },
    ],
  });

  registerProxyRoute({
    app,
    prefix: "/ttyd",
    serviceName: "ttyd",
    targetPort: opts.targets.ttyd,
    sessions,
    secret: opts.jwtSecret,
    sessionId: opts.sessionId,
  });
  registerProxyRoute({
    app,
    prefix: "/vscode",
    serviceName: "code-server",
    targetPort: opts.targets.vscode,
    sessions,
    secret: opts.jwtSecret,
    sessionId: opts.sessionId,
  });

  const server: ServerType = serve({ fetch: app.fetch, port: opts.port });
  injectWebSocket(server);

  // `serve()` is typed to return `Server | Http2Server | Http2SecureServer`
  // because @hono/node-server supports all three, but we never pass an http2
  // `createServer` option — at runtime this is always a plain `http.Server`.
  // Narrow with `instanceof` (not a cast) so a future change to those
  // options would fail loudly here instead of silently lying to callers
  // about the type of `GatewayHandle.server`.
  if (!(server instanceof Server)) {
    throw new Error("sandbox-gateway: expected a plain http.Server, got an http2 server");
  }

  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
