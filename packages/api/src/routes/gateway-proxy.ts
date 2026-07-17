/**
 * Session gateway reverse-proxy (sandbox auth gateway plan, Task 6):
 *
 *   ALL /api/sessions/:id/gateway/*   HTTP proxy
 *   GET /api/sessions/:id/gateway/*   WS upgrade proxy (only engages on
 *                                     `Upgrade: websocket`; the HTTP `ALL`
 *                                     handles everything else on the same
 *                                     path)
 *
 * The browser reaches a "full"-profile sandbox's ttyd/code-server through
 * this route: session-access gated (owner-only, 404 for everyone else —
 * `loadOwnedSession` convention, matches `messages.ts`/`ws.ts`), path
 * rewritten (`/api/sessions/:id/gateway/x/…` -> `/x/…`), then reverse
 * proxied to the sandbox's in-sandbox auth gateway daemon
 * (`@valet/sandbox-gateway`, listening on :9000 inside the sandbox).
 *
 * This route does NOT mint or verify the sandbox gateway JWT itself — the
 * browser mints one via `POST /api/sessions/:id/sandbox-jwt`
 * (`EngineHost.mintSandboxJwtFor`) and passes it as `?token=` on the
 * gateway request; this proxy forwards that query string through
 * unmodified so the sandbox gateway's own `resolveAuth` (cookie-first,
 * JWT-fallback) can verify it. Ownership of the *session* (this route's own
 * gate) and possession of a valid *gateway* JWT (the sandbox's own gate)
 * are deliberately separate checks.
 *
 * `gatewayEndpoint()` reachability: `Session.attachment.current()` peeks
 * the live raw sandbox WITHOUT provisioning (see its doc comment in
 * `packages/engine/src/sandbox/attachment.ts`) — this route must never
 * cold-start a sandbox just to answer a proxy request. `null` (detached/
 * hibernated/provisioning) or an absent/null `gatewayEndpoint()` (headless
 * profile, or a provider without gateway support) both surface as
 * `409 { error: "sandbox not ready", wake: true }` — the UI's cue to call
 * whatever wakes the session (`ensureReady`) and retry.
 *
 * Structurally similar to (but NOT imported from) `@valet/sandbox-gateway`'s
 * own proxy code (`gateway.ts`/`ws-proxy.ts`, private to that module):
 * status-code coercion (HTTP) and the pre-open-buffered bidirectional pump
 * / close-code mirroring (WS) are duplicated here (~40 lines each) rather
 * than promoted into a shared export surface that would couple the
 * in-sandbox daemon's internals to this unrelated api-side proxy. The HTTP
 * header-forwarding rule is deliberately NOT the same shape, though: that
 * hop is same-trust-domain (gateway daemon -> co-located ttyd/vscode), so
 * it blanket-copies everything non-hop-by-hop; THIS hop crosses from the
 * browser's real valet session into a semi-trusted sandbox, so
 * `createProxyHeaders` below is an explicit allowlist plus a
 * `gateway_session`-only cookie filter — see its doc comment.
 */
import type { Hono, Context } from "hono";
import type { UpgradeWebSocket, WSContext, WSMessageReceive } from "hono/ws";
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status";
import { and, eq } from "drizzle-orm";
import { WebSocket as BackendWebSocket, type RawData } from "ws";
import type { AppEnv } from "../env.js";
import { agentSessions } from "../schema/index.js";
import { loadSessionMeta } from "../engine/session-meta.js";

type SessionRow = typeof agentSessions.$inferSelect;

/** Owner-gated session lookup — mirrors `messages.ts`'s private helper
 * (unexported there too; duplicated rather than imported, matching this
 * codebase's existing convention of each route file owning its own copy —
 * see `ws.ts`'s inline equivalent query). Takes `db`/`sessionId`/`userId`
 * directly rather than a `Context` so both the HTTP handler (which has one)
 * and the WS `onOpen` closure (which doesn't) can share it. */
async function loadOwnedSession(
  db: AppEnv["Variables"]["providers"]["db"],
  sessionId: string,
  userId: string,
): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

function gatewayPrefix(sessionId: string): string {
  return `/api/sessions/${sessionId}/gateway`;
}

/**
 * Strips the route prefix, defaulting to `/` for the bare gateway root.
 * Defense-in-depth against path traversal: rejects (`null`) any path
 * containing a literal `..` segment even though the eventual `fetch`/`URL`
 * construction would normalize dot-segments away on its own — an explicit
 * reject here means a future refactor of how the target URL gets built
 * can't silently reopen this, and it fails closed instead of guessing what
 * URL the caller meant.
 */
function rewritePath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length) || "/";
  const normalized = rest.startsWith("/") ? rest : `/${rest}`;
  if (normalized.split("/").some((seg) => seg === "..")) return null;
  return normalized;
}

/** "tty" is ttyd's required WS subprotocol; every other gateway target
 * (code-server today) needs none. Inferred from the rewritten path rather
 * than a static per-target list since this proxy is generic over the whole
 * `/x/…` gateway namespace. */
function subprotocolFor(rewrittenPath: string): string[] | undefined {
  return rewrittenPath === "/ttyd" || rewrittenPath.startsWith("/ttyd/") ? ["tty"] : undefined;
}

// ── HTTP proxy ───────────────────────────────────────────────────────────

/**
 * ALLOWLIST, not a blocklist — deliberately different from
 * `@valet/sandbox-gateway`'s own `createProxyHeaders` (the daemon's
 * internal gateway->ttyd/vscode hop, which blanket-copies minus
 * hop-by-hop): that hop is same-trust-domain inside the sandbox, forwarding
 * whatever the gateway daemon already authenticated. This hop crosses from
 * the browser's real valet session into a semi-trusted sandbox — blanket
 * forwarding would hand the sandbox the browser's `Authorization`/
 * `x-api-key`/`x-valet-test-user-id`/valet auth cookies, none of which the
 * sandbox needs or should ever see. Only headers ttyd/code-server actually
 * use for correct HTTP behavior are forwarded; auth is `?token=`
 * (forwarded via the query string, not a header) plus the sandbox
 * gateway's OWN `gateway_session` cookie, filtered out of whatever else is
 * in the incoming `Cookie` header by `filteredGatewaySessionCookie`.
 */
const FORWARDED_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-language",
  "content-type",
  "range",
  "if-none-match",
  "if-modified-since",
  "if-match",
  "cache-control",
  "user-agent",
  "x-requested-with",
]);

const GATEWAY_SESSION_COOKIE = "gateway_session";

/** Extracts only the sandbox gateway's own `gateway_session=…` cookie pair
 * from the incoming `Cookie` header, dropping every other cookie the
 * browser sent (in particular, the browser's real valet auth session
 * cookie) — see `FORWARDED_HEADER_ALLOWLIST`'s doc comment. */
function filteredGatewaySessionCookie(rawCookie: string | null): string | undefined {
  if (!rawCookie) return undefined;
  for (const part of rawCookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === GATEWAY_SESSION_COOKIE) return part.trim();
  }
  return undefined;
}

function createProxyHeaders(rawHeaders: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of rawHeaders.entries()) {
    if (FORWARDED_HEADER_ALLOWLIST.has(key.toLowerCase())) headers.set(key, value);
  }
  headers.set("Accept-Encoding", "identity");
  const cookie = filteredGatewaySessionCookie(rawHeaders.get("cookie"));
  if (cookie) headers.set("Cookie", cookie);
  return headers;
}

/**
 * Rewrites a `Set-Cookie` value's `Path` attribute to `path`, appending one
 * if absent. The sandbox gateway daemon mints `gateway_session` with
 * `Path=/` (`@valet/sandbox-gateway`'s `sessionCookieHeader` — correct for
 * ITS own origin, the sandbox, where it's the only cookie in play). Forwarded
 * unmodified through this api-side proxy, `Path=/` would scope the cookie to
 * the WHOLE api origin in the browser, so it'd get attached to — and
 * forwarded into — every OTHER session's proxied gateway requests too.
 * Confining it to this session's own proxy prefix keeps each session's
 * sandbox cookie from leaking into another session's request.
 */
function rewriteSetCookiePath(cookie: string, path: string): string {
  const attrs = cookie.split(";");
  let sawPath = false;
  const rewritten = attrs.map((attr, i) => {
    if (i === 0) return attr;
    if (/^\s*path\s*=/i.test(attr)) {
      sawPath = true;
      return ` Path=${path}`;
    }
    return attr;
  });
  return sawPath ? rewritten.join(";") : `${cookie}; Path=${path}`;
}

const CONTENTLESS_STATUS_CODES = new Set([101, 204, 205, 304]);

/** Hono's `.body()` types the status param as the closed `StatusCode`
 * union, but an upstream sandbox gateway's response status is just
 * `number` at compile time. Runtime-validate against the legal HTTP status
 * range; anything outside it means the upstream response itself is
 * malformed, so it's reported as a 502 instead of forwarded verbatim. */
function asStatusCode(status: number): StatusCode {
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return status as StatusCode;
  }
  return 502;
}

function asContentfulStatusCode(status: number): ContentfulStatusCode {
  if (Number.isInteger(status) && status >= 100 && status <= 599 && !CONTENTLESS_STATUS_CODES.has(status)) {
    return status as ContentfulStatusCode;
  }
  return 502;
}

type ProxyRequestInit = RequestInit & { duplex?: "half" };

async function proxyHttp(c: Context<AppEnv>): Promise<Response> {
  const row = await loadOwnedSession(c.var.providers.db, c.req.param("id"), c.var.user.id);
  if (!row) return c.json({ error: "not found" }, 404);

  const sessionId = row.id;
  // Stamp gateway activity as soon as ownership is confirmed — every
  // proxied request (not just ones that reach a ready sandbox) counts, so a
  // request that arrives just as the sandbox is mid-wake still resets the
  // idle clock (final-review fix wave, hibernation arc — see
  // `EngineHost.touchGatewayActivity`'s doc comment).
  c.var.providers.engineHost.touchGatewayActivity(sessionId);
  const prefix = gatewayPrefix(sessionId);
  const url = new URL(c.req.url);
  const rewrittenPath = rewritePath(url.pathname, prefix);
  if (rewrittenPath === null) return c.json({ error: "invalid path" }, 400);

  let session;
  try {
    session = await c.var.providers.engineHost.sessionFor(
      sessionId,
      await loadSessionMeta(c.var.providers.db, row),
    );
  } catch (err) {
    console.error(`gateway-proxy: sessionFor(${sessionId}) failed:`, err);
    return c.json({ error: "sandbox not ready", wake: true }, 409);
  }

  const sandbox = session.attachment.current();
  const endpoint = sandbox?.gatewayEndpoint ? await sandbox.gatewayEndpoint() : null;
  if (!endpoint) {
    // Fire-and-forget: kicks the resume path for a suspended attachment (or
    // a cold provision for a detached one) so the client's retry after this
    // 409 has a real chance of landing on a ready sandbox (sandbox
    // hibernation plan, Task 4).
    session.attachment.warm();
    return c.json({ error: "sandbox not ready", wake: true }, 409);
  }

  const target = `http://${endpoint.host}:${endpoint.port}${rewrittenPath}${url.search}`;
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
    const setCookies = res.headers.getSetCookie();
    if (setCookies.length > 0) {
      headers.delete("set-cookie");
      for (const cookie of setCookies) headers.append("set-cookie", rewriteSetCookiePath(cookie, prefix));
    }
    return res.body
      ? c.body(res.body, { status: asContentfulStatusCode(res.status), statusText: res.statusText, headers })
      : c.body(null, { status: asStatusCode(res.status), statusText: res.statusText, headers });
  } catch {
    return c.json({ error: "gateway unreachable" }, 502);
  }
}

export function registerGatewayHttpProxy(app: Hono<AppEnv>): void {
  app.all("/api/sessions/:id/gateway/*", proxyHttp);
}

// ── WS proxy ─────────────────────────────────────────────────────────────

function toBackendPayload(data: WSMessageReceive): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  throw new Error("gateway-proxy: unsupported websocket message payload (Blob)");
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

function toClientPayload(data: RawData, isBinary: boolean): string | ArrayBuffer {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : data;
  if (buffer instanceof ArrayBuffer) return isBinary ? buffer : Buffer.from(buffer).toString("utf8");
  return isBinary ? toArrayBuffer(buffer) : buffer.toString("utf8");
}

/** WS close codes 1005/1006/1015 are local-only reporting codes — the `ws`
 * library throws if asked to actually send one in a close frame. Mirroring
 * a peer's close code onto the other leg must go through this guard. */
const UNSENDABLE_CLOSE_CODES = new Set([1005, 1006, 1015]);

function mirrorClose(target: { close(code?: number, reason?: string): void }, code: number, reason: string): void {
  if (Number.isInteger(code) && code >= 1000 && code <= 4999 && !UNSENDABLE_CLOSE_CODES.has(code)) {
    target.close(code, reason);
  } else {
    target.close();
  }
}

/**
 * Mirrors the client's close code/reason onto `backend`, falling back to a
 * hard `terminate()` if `backend` isn't open, or if the mirror attempt
 * itself throws. `evt.reason` is client-controlled and the `ws` library
 * throws synchronously when asked to send a close frame whose reason
 * encodes to more than 123 UTF-8 bytes (a JS string can be short in
 * `.length` — UTF-16 code units — while still exceeding that once
 * multi-byte characters are encoded) — letting that escape this handler
 * would leave the backend socket connected instead of closed. Extracted
 * (rather than inlined in `onClose`) so it's unit-testable without a live
 * WS round trip — see `gateway-proxy.test.ts`.
 */
export function closeBackendOnClientClose(
  backend: { readyState: number; close(code?: number, reason?: string): void; terminate(): void },
  code: number,
  reason: string,
): void {
  if (backend.readyState !== BackendWebSocket.OPEN) {
    backend.terminate();
    return;
  }
  try {
    mirrorClose(backend, code, reason);
  } catch (err) {
    console.error("gateway-proxy ws: mirrorClose to backend failed, terminating:", err);
    backend.terminate();
  }
}

export function registerGatewayWsProxy(app: Hono<AppEnv>, upgradeWebSocket: UpgradeWebSocket): void {
  app.get(
    "/api/sessions/:id/gateway/*",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("id");
      const userId = c.var.user.id;
      const providers = c.var.providers;
      const url = new URL(c.req.url);
      const prefix = gatewayPrefix(sessionId);

      let backend: BackendWebSocket | undefined;
      let clientOpen = true;
      const preOpenBuffer: Array<string | ArrayBuffer> = [];

      return {
        async onOpen(_evt, ws: WSContext) {
          try {
            const row = await loadOwnedSession(providers.db, sessionId, userId);
            if (!row) {
              ws.close(4040, "session not found");
              return;
            }

            const rewrittenPath = rewritePath(url.pathname, prefix);
            if (rewrittenPath === null) {
              ws.close(4000, "invalid path");
              return;
            }

            // Connection established by an owning user — counts as gateway
            // activity same as the HTTP proxy's entry stamp (final-review
            // fix wave, hibernation arc).
            providers.engineHost.touchGatewayActivity(sessionId);

            let session;
            try {
              session = await providers.engineHost.sessionFor(
                sessionId,
                await loadSessionMeta(providers.db, row),
              );
            } catch (err) {
              console.error(`gateway-proxy ws: sessionFor(${sessionId}) failed:`, err);
              ws.close(4009, "sandbox not ready");
              return;
            }

            const sandbox = session.attachment.current();
            const endpoint = sandbox?.gatewayEndpoint ? await sandbox.gatewayEndpoint() : null;
            if (!endpoint) {
              // Fire-and-forget wake, same as the HTTP proxy's 409 path.
              session.attachment.warm();
              ws.close(4009, "sandbox not ready");
              return;
            }

            const backendUrl = `ws://${endpoint.host}:${endpoint.port}${rewrittenPath}${url.search}`;
            const protocols = subprotocolFor(rewrittenPath);
            backend = protocols ? new BackendWebSocket(backendUrl, protocols) : new BackendWebSocket(backendUrl);
            backend.binaryType = "arraybuffer";

            backend.on("open", () => {
              for (const msg of preOpenBuffer) backend?.send(msg);
              preOpenBuffer.length = 0;
            });
            backend.on("message", (data: RawData, isBinary: boolean) => {
              if (!clientOpen) return;
              try {
                ws.send(toClientPayload(data, isBinary));
              } catch (err) {
                console.error("gateway-proxy ws: error forwarding backend frame to client:", err);
              }
            });
            backend.on("close", (code: number, reason: Buffer) => {
              if (!clientOpen) return;
              try {
                mirrorClose(ws, code, reason.toString());
              } catch {
                // client socket may already be closed
              }
            });
            backend.on("error", (err: Error) => {
              console.error("gateway-proxy ws: backend WS error:", err);
              if (!clientOpen) return;
              try {
                ws.close(1011, "backend error");
              } catch {
                // client socket may already be closed
              }
            });
          } catch (err) {
            console.error("gateway-proxy ws: onOpen failed:", err);
            try {
              ws.close(1011, "internal error");
            } catch {
              // client socket may already be closed
            }
          }
        },

        onMessage(evt) {
          // Client -> backend traffic only (keystrokes/input) — deliberately
          // not stamped on backend -> client frames, which would count idle
          // terminal output/heartbeats as activity (final-review fix wave,
          // hibernation arc — see `EngineHost.touchGatewayActivity`).
          providers.engineHost.touchGatewayActivity(sessionId);
          let payload: string | ArrayBuffer;
          try {
            payload = toBackendPayload(evt.data);
          } catch (err) {
            // Unexpected payload shape (e.g. a Blob) — drop the frame
            // instead of throwing inside the handler, which would tear
            // down the connection over one bad frame.
            console.error("gateway-proxy ws: dropping unsupported client frame:", err);
            return;
          }
          if (backend && backend.readyState === BackendWebSocket.OPEN) {
            backend.send(payload);
          } else {
            preOpenBuffer.push(payload);
          }
        },

        onClose(evt) {
          clientOpen = false;
          if (backend) closeBackendOnClientClose(backend, evt.code, evt.reason);
        },

        onError(evt) {
          console.error("gateway-proxy ws: client WS error:", evt);
          if (backend) backend.terminate();
        },
      };
    }),
  );
}
