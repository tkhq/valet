/**
 * Process lifecycle for the api: booting → ready → draining.
 *
 * The api runs as one replica on the Recreate strategy, so during a deploy
 * there is no other pod to send callers to. What a caller sees in that window
 * is decided here:
 *
 *   - booting: the port binds before database upgrades start (`startBootListener`)
 *     and every request gets 503 + `Retry-After` until the real app takes the
 *     port. On the real app, `lifecycleGate` keeps answering 503 for API, MCP,
 *     webhook and proxy routes until the boot chain calls `markReady()`.
 *   - ready: requests pass, and the gate counts the ones in flight.
 *   - draining (SIGTERM): `/api/ready` reports 503, new gated requests get
 *     503 + `Retry-After`, and `waitForIdle()` lets the requests already in
 *     flight finish, up to `drainMs` after the drain began.
 *
 * Requests the process makes to itself are never gated: in-process dispatch
 * (`app.fetch` with no server env, the MCP tool path) and loopback callers
 * with no proxy headers (engine tools over `apiBaseUrl`). Both are part of
 * work already in flight.
 *
 * Health endpoints are never gated. The chart serves the pod with
 * `publishNotReadyAddresses`, so these 503s reach callers instead of the
 * ingress's own error page or a refused connection.
 */
import { createServer, type Server } from "node:http";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";

export type LifecyclePhase = "booting" | "ready" | "draining";

/** Seconds a client should wait before it retries a 503 from this module. */
export const RETRY_AFTER_SECONDS = 5;

/** Default bound on how long a drain waits for requests in flight. It sits
 * well inside `SHUTDOWN_HARD_EXIT_MS` (main.ts), so the evict and close steps
 * after the drain still run before the hard exit. */
export const DEFAULT_DRAIN_MS = 10_000;

/** Paths that are never gated: the kubelet and `valet status` read them. */
const HEALTH_PATHS = new Set(["/api/health", "/api/ready"]);

/** Paths and path prefixes that get 503 while not ready. The SPA and public
 * pages are left alone: they hold no server state, and a browser that loads
 * them reaches the API through these routes anyway. */
const GATED_PATHS = new Set(["/mcp"]);
const GATED_PREFIXES = ["/api/", "/mcp/", "/webhooks/", "/proxy/"];

export function isGatedPath(path: string): boolean {
  if (HEALTH_PATHS.has(path)) return false;
  return GATED_PATHS.has(path) || GATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export interface UnavailableBody {
  error: "unavailable";
  reason: "booting" | "draining";
  retryAfterSeconds: number;
}

export function unavailableBody(reason: "booting" | "draining"): UnavailableBody {
  return { error: "unavailable", reason, retryAfterSeconds: RETRY_AFTER_SECONDS };
}

export class Lifecycle {
  private current: LifecyclePhase = "booting";
  private inFlight = 0;
  private drained: Promise<boolean> | undefined;
  private drainDeadline = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly drainMs = DEFAULT_DRAIN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get phase(): LifecyclePhase {
    return this.current;
  }

  get requestsInFlight(): number {
    return this.inFlight;
  }

  isReady(): boolean {
    return this.current === "ready";
  }

  /** Boot chain finished. Ignored once draining: a shutdown that raced the
   * boot chain tail must not report ready again. */
  markReady(): void {
    if (this.current === "booting") this.current = "ready";
  }

  /**
   * SIGTERM: stop reporting ready and start the drain clock. Returns the wait
   * for in-flight requests, started now, so slow shutdown steps that run
   * before eviction cannot use up the requests' window. Idempotent: a second
   * call returns the same wait.
   */
  beginDrain(): Promise<boolean> {
    if (this.current === "draining" && this.drained) return this.drained;
    this.current = "draining";
    this.drainDeadline = this.now() + this.drainMs;
    this.drained = this.waitForIdle();
    return this.drained;
  }

  /** Counts one gated request in flight. Returns the matching release, which
   * is safe to call more than once. */
  enter(): () => void {
    this.inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      if (this.inFlight === 0) this.wakeIdleWaiters();
    };
  }

  /**
   * Resolves once no counted request is in flight, or when the drain window
   * ends, whichever is first. Resolves `true` when idle, `false` on timeout.
   * Without a drain in progress it waits at most `drainMs` from now.
   */
  async waitForIdle(): Promise<boolean> {
    if (this.inFlight === 0) return true;
    const deadline = this.current === "draining" ? this.drainDeadline : this.now() + this.drainMs;
    const remaining = Math.max(0, deadline - this.now());
    if (remaining === 0) return false;
    return await new Promise<boolean>((resolve) => {
      const onIdle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== onIdle);
        resolve(false);
      }, remaining);
      timer.unref?.();
      this.idleWaiters.push(onIdle);
    });
  }

  private wakeIdleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake();
  }
}

/**
 * True for a request the process sent to itself: no server env (in-process
 * `app.fetch`), or a loopback peer with no proxy headers. Node exposes the peer through
 * `c.env.incoming.socket`; Bun through `server.requestIP(req)`.
 */
export function isSelfRequest(c: Context<AppEnv>): boolean {
  const env: unknown = c.env;
  if (typeof env !== "object" || env === null) return true;
  let addr = field(field(field(env, "incoming"), "socket"), "remoteAddress");
  const requestIP = field(env, "requestIP");
  if (addr === undefined && typeof requestIP === "function") {
    addr = field(requestIP.call(env, c.req.raw), "address");
  }
  return typeof addr === "string" && isLoopback(addr) && !hasProxyHeaders(c);
}

/** A same-host reverse proxy (Caddy on one box, a sidecar) connects from
 * loopback for every external caller. Such a request carries a proxy header;
 * the api's own loopback calls do not. */
function hasProxyHeaders(c: Context<AppEnv>): boolean {
  return PROXY_HEADERS.some((name) => c.req.header(name) !== undefined);
}

const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"];

/** Reads one property of an unknown value, or `undefined`. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  // `key in value` narrowed the key; TypeScript cannot index on it without a cast.
  return (value as Record<string, unknown>)[key];
}

function isLoopback(addr: string): boolean {
  return addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127.");
}

/** Hono middleware: 503 + `Retry-After` for gated routes while booting or
 * draining, and an in-flight count for the rest. Register it before routes. */
export function lifecycleGate(lifecycle: Lifecycle): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!isGatedPath(c.req.path) || isSelfRequest(c)) {
      await next();
      return;
    }
    const phase = lifecycle.phase;
    if (phase !== "ready") {
      c.header("Retry-After", String(RETRY_AFTER_SECONDS));
      c.header("Cache-Control", "no-store");
      return c.json(unavailableBody(phase), 503);
    }
    const release = lifecycle.enter();
    try {
      await next();
    } finally {
      release();
    }
  };
}

export interface BootListener {
  /** Stops listening and drops open connections. Resolves once the port is free. */
  close(): Promise<void>;
}

/**
 * Binds `port` before database upgrades and provider setup run, so the
 * seconds before the real app listens answer 503 + `Retry-After` instead of
 * refusing the connection. `/api/health` also answers 503 here: the
 * startupProbe reads it, and its budget (values.yaml) is meant to cover
 * database upgrades, so startup must not pass before the real app is up.
 *
 * Resolves `null` when the port cannot be bound (another process holds it);
 * the real listener then reports the error as it did before.
 */
export async function startBootListener(port: number): Promise<BootListener | null> {
  const body = JSON.stringify(unavailableBody("booting"));
  const server: Server = createServer((_req, res) => {
    res.writeHead(503, {
      "Content-Type": "application/json",
      "Retry-After": String(RETRY_AFTER_SECONDS),
      "Cache-Control": "no-store",
      Connection: "close",
    });
    res.end(body);
  });
  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, () => resolve(true));
  });
  if (!bound) return null;
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
