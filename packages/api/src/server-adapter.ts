/**
 * Server-runtime seam. The HTTP + WebSocket server runs under either
 * `@hono/node-server` + `@hono/node-ws` (Node — the default path) or
 * `Bun.serve` + `hono/bun` (a `bun build --compile` native binary). The
 * route handlers are already adapter-agnostic: both runtimes expose the same
 * Hono `UpgradeWebSocket` middleware signature, so `registerWsRoutes` /
 * `registerGatewayWsProxy` need no change.
 *
 * The two runtimes differ only in (a) how the WS handler is built — Node's
 * `createNodeWebSocket({ app })` needs the app; Bun's `createBunWebSocket()`
 * does not — and (b) how listening starts and WS attaches: Node calls
 * `serve()` then `injectWebSocket(server)`; Bun passes the `websocket` handler
 * straight to `Bun.serve({ fetch, port, websocket })` and never injects.
 *
 * `createWebSocket(app)` returns both the upgrade middleware AND a `serve`
 * closure that has already captured the runtime-specific attach plumbing
 * (Node: `injectWebSocket`; Bun: the `websocket` handler). Callers therefore
 * never touch — or even name — the attach token; the two phases stay
 * decoupled without leaking a runtime-specific type across the boundary. Per
 * `createApp` call, so concurrent boots (the test suite runs many) never share
 * mutable adapter state.
 *
 * IMPORTANT — do not statically import `./server-adapter.bun.js` anywhere: it
 * pulls in `hono/bun`, which throws `Bun is not defined` at module-load under
 * Node. The Bun adapter is only ever reached via `selectServerAdapter`'s
 * dynamic `import()` guarded by `isBunRuntime()`. (`@hono/node-server` /
 * `@hono/node-ws` are import-safe under Bun, so the Node adapter may be a
 * static import — it is simply never *called* on the Bun path.)
 */
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { AppEnv } from "./env.js";

/** True inside the Bun runtime (dev `bun run` or a `bun --compile` binary). */
export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** A running web server, uniform across runtimes. */
export interface RunningServer {
  /** The port the server is actually listening on. */
  readonly port: number;
  /** Stop listening and release the socket. Resolves once fully closed. */
  close(): Promise<void>;
}

export interface ServeOptions {
  port: number;
  /** Called with the actual bound port once the server is listening. */
  onListen?: (port: number) => void;
}

/**
 * The WS upgrade middleware plus a `serve` bound to the same app + runtime WS
 * plumbing. Produced by `ServerAdapter.createWebSocket`.
 */
export interface WebSocketBinding {
  upgradeWebSocket: UpgradeWebSocket;
  /** Start listening (and attach WS) for the app this binding was built from. */
  serve(opts: ServeOptions): RunningServer;
}

/** Runtime-specific HTTP + WS serving. */
export interface ServerAdapter {
  readonly runtime: "node" | "bun";
  /** Build the WS upgrade middleware + `serve` bound to `app`. */
  createWebSocket(app: Hono<AppEnv>): WebSocketBinding;
}

/**
 * Pick the adapter matching the current runtime. Async because the Bun adapter
 * must be dynamically imported (its `hono/bun` dependency throws on load under
 * Node). The composition root (`main.ts`) awaits this once at boot and passes
 * the result into `createApp`.
 */
export async function selectServerAdapter(): Promise<ServerAdapter> {
  if (isBunRuntime()) {
    const { bunServerAdapter } = await import("./server-adapter.bun.js");
    return bunServerAdapter;
  }
  const { nodeServerAdapter } = await import("./server-adapter.node.js");
  return nodeServerAdapter;
}
