/**
 * `streamSession` — the CLI's WebSocket event stream for a single session.
 *
 * Connects to `GET /api/sessions/:id/ws` (the same socket the web client
 * uses) and yields each frame parsed + narrowed to the `WireEvent` union.
 *
 * Auth: the `x-api-key` header is set on the upgrade GET when an `apiKey` is
 * present (real instances); omitted for the local stub (`VALET_LOCAL_AUTH=1`).
 *
 * Reconnect design (documented, deliberately simple):
 *   - Durable frames carry a numeric `offset`. We track the highest one seen
 *     (`lastOffset`) as we go.
 *   - On an UNEXPECTED socket close (anything but a clean 1000, the terminal
 *     4040 "session not found", or a caller-initiated stop) we reconnect with
 *     `?fromOffset=<lastOffset>` so the server replays durable events after
 *     the gap. Retries are bounded (`MAX_RETRIES`) with small exponential
 *     backoff; a successful frame resets the retry counter. Exhausting the
 *     retries throws `UnreachableError` out of the generator.
 *   - A clean close (1000/4040) ends the generator. The `AbortSignal` (or the
 *     consumer `break`ing / `return`ing the generator) closes the socket and
 *     ends the stream.
 *
 * App-level `{type:"ping"}` keepalive frames are valid `WireEvent`s and are
 * yielded like any other; consumers ignore them. (The `ws` library answers
 * protocol-level pings automatically — those never surface here.)
 */
import { WebSocket, type RawData } from "ws";
import { UnreachableError } from "./exit.js";
import type { WireEvent, WireEventType } from "../wire/types.js";

export interface StreamSessionOpts {
  url: string;
  apiKey?: string;
  sessionId: string;
  fromOffset?: number;
  signal?: AbortSignal;
}

/**
 * Derive the WS(S) upgrade URL for a session's event stream from the HTTP(S)
 * base url. `http`→`ws`, `https`→`wss`; any base path is preserved.
 */
export function httpToWsUrl(baseUrl: string, sessionId: string, fromOffset?: number): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  const basePath = u.pathname.replace(/\/$/, "");
  u.pathname = `${basePath}/api/sessions/${encodeURIComponent(sessionId)}/ws`;
  if (fromOffset !== undefined) u.searchParams.set("fromOffset", String(fromOffset));
  else u.searchParams.delete("fromOffset");
  return u.toString();
}

/** Every member of the `WireEvent` union, keyed by discriminant. The
 *  `Record<WireEventType, true>` forces this to stay exhaustive — a missing or
 *  stray key is a compile error, so `isWireEvent` can't drift from the union. */
const WIRE_EVENT_TYPES: Record<WireEventType, true> = {
  init: true,
  message_start: true,
  text_delta: true,
  tool_call_update: true,
  message_update: true,
  message_end: true,
  tool_start: true,
  tool_end: true,
  status: true,
  turn_end: true,
  error: true,
  model_switched: true,
  compaction_start: true,
  compaction_end: true,
  decision_gate: true,
  decision_gate_resolved: true,
  decision_gate_expired: true,
  decision_gate_withdrawn: true,
  "queue.state": true,
  "submission.settled": true,
  "sandbox.status": true,
  command_result: true,
  ping: true,
};

/** Narrow an unknown parsed frame to `WireEvent` via its `type` discriminant. */
function isWireEvent(v: unknown): v is WireEvent {
  if (typeof v !== "object" || v === null) return false;
  // Structural access after the object check — read `type` without asserting
  // the full union shape (which we can't validate exhaustively here).
  const type = (v as { type?: unknown }).type;
  return (
    typeof type === "string" &&
    Object.prototype.hasOwnProperty.call(WIRE_EVENT_TYPES, type)
  );
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/** A minimal single-producer/single-consumer async queue bridging the `ws`
 *  event callbacks to the generator's pull loop. `end()` completes the
 *  iteration; `fail()` makes the pending/next `next()` reject. */
class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (r: IteratorResult<T, undefined>) => void;
    reject: (e: Error) => void;
  }> = [];
  private done = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    if (this.done) return;
    this.failure = error;
    this.done = true;
    for (const w of this.waiters.splice(0)) w.reject(error);
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.values.length > 0) {
      // length checked above → shift() is defined.
      return Promise.resolve({ value: this.values.shift() as T, done: false });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

type ConnectionOutcome = "clean" | "reconnect" | "terminal";

export async function* streamSession(opts: StreamSessionOpts): AsyncGenerator<WireEvent> {
  const { url, apiKey, sessionId, signal } = opts;
  const headers = apiKey ? { "x-api-key": apiKey } : undefined;

  const queue = new AsyncQueue<WireEvent>();
  let lastOffset = opts.fromOffset;
  let attempt = 0;
  let stopping = false;
  let currentWs: WebSocket | null = null;

  const stop = (): void => {
    stopping = true;
    if (currentWs) {
      try {
        currentWs.close(1000);
      } catch {
        // already closing/closed — nothing to do.
      }
    }
    queue.end();
  };

  if (signal?.aborted) {
    // Caller aborted before we started — nothing to stream.
    return;
  }
  signal?.addEventListener("abort", stop, { once: true });

  const runConnection = (): Promise<ConnectionOutcome> =>
    new Promise((resolve) => {
      const wsUrl = httpToWsUrl(url, sessionId, lastOffset);
      const ws = headers ? new WebSocket(wsUrl, { headers }) : new WebSocket(wsUrl);
      currentWs = ws;

      ws.on("message", (data: RawData) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawToString(data));
        } catch {
          process.stderr.write("streamSession: dropping malformed (non-JSON) frame\n");
          return;
        }
        if (!isWireEvent(parsed)) {
          process.stderr.write("streamSession: dropping frame with unknown type\n");
          return;
        }
        // Progress → reset backoff and advance the resume offset.
        attempt = 0;
        if (typeof parsed.offset === "string" && parsed.offset !== "") {
          const n = Number(parsed.offset);
          if (Number.isFinite(n)) lastOffset = n;
        }
        queue.push(parsed);
      });

      ws.on("close", (code: number) => {
        currentWs = null;
        if (stopping) {
          resolve("terminal");
          return;
        }
        // 1000 = normal close; 4040 = server "session not found" (terminal).
        if (code === 1000 || code === 4040) resolve("clean");
        else resolve("reconnect");
      });

      ws.on("error", () => {
        // A `close` always follows an `error`; the close handler decides
        // whether to reconnect. Swallow here to avoid an unhandled 'error'.
      });
    });

  // Connection driver — runs alongside the consumer's pull loop, feeding the
  // queue and ending/failing it when the stream terminates.
  void (async () => {
    try {
      while (!stopping) {
        const outcome = await runConnection();
        if (stopping || outcome === "terminal" || outcome === "clean") break;
        attempt += 1;
        if (attempt > MAX_RETRIES) {
          queue.fail(
            new UnreachableError(
              `lost connection to ${url} (session ${sessionId}) after ${MAX_RETRIES} retries`,
            ),
          );
          return;
        }
        const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        await delay(backoff, signal);
      }
      queue.end();
    } catch (err) {
      queue.fail(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  try {
    for (;;) {
      const result = await queue.next();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    stop();
  }
}
