/**
 * WebSocket reverse proxy: bidirectionally pipes a client connection on
 * `/ttyd/*` or `/vscode/*` to the matching loopback backend.
 *
 * Modeled on the legacy Bun WS pipe in `packages/runner/src/gateway.ts`
 * (~1993-2142: `Bun.serve`'s `websocket.open/message/close` handlers),
 * rewritten for Node's `ws` package via `@hono/node-ws`'s
 * `upgradeWebSocket` helper. Differences from the legacy version:
 *   - Auth happens once, in `onOpen`, using the same cookie-first/JWT
 *     resolution as the HTTP proxy (`session.ts`); an unauthenticated
 *     upgrade is closed with code 4001 rather than rejected pre-upgrade —
 *     the handshake to the *client* has already completed by the time
 *     `onOpen` fires (see `@hono/node-ws`'s upgrade sequencing), so a clean
 *     WS close is the only way to signal rejection.
 *   - The outbound `token` query param is stripped before dialing the
 *     backend; backend services never see it.
 *   - Frames sent by the client before the backend socket opens are
 *     buffered and flushed once it does (pre-open buffering) instead of
 *     being dropped.
 */
import type { Hono } from "hono";
import type { UpgradeWebSocket, WSContext, WSMessageReceive } from "hono/ws";
import { WebSocket as BackendWebSocket, type RawData } from "ws";
import { bearerToken, resolveAuth, type SessionStore } from "./session.js";

export interface WsProxyTarget {
  /** Route prefix, e.g. "/ttyd". Matched as `${prefix}/*`. */
  prefix: string;
  /** Loopback port of the backend service. */
  port: number;
  /** Subprotocol to request on the outbound backend connection (ttyd
   * requires "tty"; code-server requires none). */
  subprotocol?: string;
}

export interface RegisterWsProxyOpts {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  sessions: SessionStore;
  secret: string;
  sessionId: string;
  targets: WsProxyTarget[];
}

/** Client `WSMessageReceive` is only ever `string` or `ArrayBuffer` under
 * Node's `ws`-backed WSContext (`Blob` is a browser-only case) — narrow
 * before forwarding so the backend socket's stricter `.send()` type accepts
 * it. */
function toBackendPayload(data: WSMessageReceive): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  throw new Error("ws-proxy: unsupported websocket message payload (Blob)");
}

/** Copies a `Uint8Array` view into a fresh, plain `ArrayBuffer` — a `Buffer`'s
 * `.buffer` is typed `ArrayBufferLike` (it can be backed by a
 * `SharedArrayBuffer`), which `WSContext.send()` doesn't accept. A copy
 * sidesteps that instead of asserting the type away. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

/** Normalizes the backend `ws` client's `RawData` (`Buffer | ArrayBuffer |
 * Buffer[]`) into what `WSContext.send()` accepts. */
function toClientPayload(data: RawData, isBinary: boolean): string | ArrayBuffer {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : data;
  if (buffer instanceof ArrayBuffer) return isBinary ? buffer : Buffer.from(buffer).toString("utf8");
  return isBinary ? toArrayBuffer(buffer) : buffer.toString("utf8");
}

/** WS close codes 1005 ("no status received"), 1006 ("abnormal closure"),
 * and 1015 (TLS failure) are reserved for local reporting only — the `ws`
 * library throws if asked to actually *send* one of them (or anything
 * outside the legal 1000-4999 range) in a close frame. Mirroring a peer's
 * close code onto the other leg must go through this guard, or an
 * abrupt/codeless disconnect on one side throws synchronously while
 * handling the other side's close event, leaking the socket instead of
 * closing it. */
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
 * itself throws. `reason` is client-controlled and the `ws` library throws
 * synchronously when asked to send a close frame whose reason encodes to
 * more than 123 UTF-8 bytes (a JS string can be short in `.length` — UTF-16
 * code units — while still exceeding that once multi-byte characters are
 * encoded) — letting that escape this handler would leave the backend
 * socket connected instead of closed. Mirrors the api-side proxy's
 * `closeBackendOnClientClose` (`packages/api/src/routes/gateway-proxy.ts`),
 * duplicated rather than shared per this module's existing convention (see
 * that file's module doc comment).
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
    console.error("[sandbox-gateway] mirrorClose to backend failed, terminating:", err);
    backend.terminate();
  }
}

function upstreamWsUrl(url: URL, prefix: string, port: number): string {
  const path = url.pathname.slice(prefix.length) || "/";
  const params = new URLSearchParams(url.search);
  params.delete("token");
  const qs = params.toString();
  return `ws://127.0.0.1:${port}${path}${qs ? `?${qs}` : ""}`;
}

/** Registers one `upgradeWebSocket` route per target onto `opts.app`. */
export function registerWsProxyRoutes(opts: RegisterWsProxyOpts): void {
  for (const target of opts.targets) {
    opts.app.get(
      `${target.prefix}/*`,
      opts.upgradeWebSocket((c) => {
        const url = new URL(c.req.url);
        const auth = resolveAuth({
          cookieHeader: c.req.header("Cookie"),
          token: url.searchParams.get("token") ?? bearerToken(c.req.header("Authorization")),
          secret: opts.secret,
          expectedSid: opts.sessionId,
          sessions: opts.sessions,
        });

        let backend: BackendWebSocket | undefined;
        let clientOpen = true;
        const preOpenBuffer: Array<string | ArrayBuffer> = [];

        return {
          onOpen(_evt, ws: WSContext) {
            if (!auth) {
              ws.close(4001, "unauthorized");
              return;
            }
            const wsUrl = upstreamWsUrl(url, target.prefix, target.port);
            const protocols = target.subprotocol ? [target.subprotocol] : undefined;
            backend = protocols ? new BackendWebSocket(wsUrl, protocols) : new BackendWebSocket(wsUrl);
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
                console.error("[sandbox-gateway] error forwarding backend frame to client:", err);
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
              console.error(`[sandbox-gateway] backend WS error (${target.prefix}):`, err);
              if (!clientOpen) return;
              try {
                ws.close(1011, "backend error");
              } catch {
                // client socket may already be closed
              }
            });
          },

          onMessage(evt, _ws) {
            if (!auth) return;
            let payload: string | ArrayBuffer;
            try {
              payload = toBackendPayload(evt.data);
            } catch (err) {
              // Unexpected payload shape (e.g. a Blob) — drop the frame
              // instead of throwing inside the handler.
              console.error(`[sandbox-gateway] dropping unsupported client frame (${target.prefix}):`, err);
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
            console.error(`[sandbox-gateway] client WS error (${target.prefix}):`, evt);
            if (backend) backend.terminate();
          },
        };
      }),
    );
  }
}
