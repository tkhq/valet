import { trace } from '@opentelemetry/api';

/**
 * Structured, leveled, trace-aware logging. Each line is one JSON object stamped with
 * the active `trace_id` / `span_id` (when a span is in context), so logs pivot to the
 * trace that produced them. Replaces ad-hoc `console.*` (no levels, no JSON).
 *
 * Lines always go to `console.*` (visible in `wrangler tail`). When `LOKI_PUSH_URL` is
 * configured they are ALSO buffered and shipped to Loki (see `flushLogs`), so the same
 * trace-stamped JSON is queryable in Grafana next to the Tempo traces. Dark by default:
 * with no `LOKI_PUSH_URL` the only added cost per line is one boolean check.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const INVALID_TRACE_ID = '00000000000000000000000000000000';

let threshold: number = LEVEL_WEIGHT.debug;

/** Drop log lines below `level`. Defaults to `debug` (emit everything). */
export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_WEIGHT[level];
}

export type LogFields = Record<string, unknown>;

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < threshold) return;

  const now = Date.now();
  const ctx = trace.getActiveSpan()?.spanContext();
  const entry: Record<string, unknown> = { level, message, time: new Date(now).toISOString() };
  if (ctx && ctx.traceId && ctx.traceId !== INVALID_TRACE_ID) {
    entry.trace_id = ctx.traceId;
    entry.span_id = ctx.spanId;
  }
  if (fields) Object.assign(entry, fields);

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  if (shipEnabled) bufferLine(now, level, line);
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};

// ─── Loki shipping (dark by default) ─────────────────────────────────────────
//
// Workers have no cross-request timers, so shipping is buffer + explicit flush:
// emit() appends to a bounded module-level buffer and the request/DO lifecycle
// drives `flushLogs` via `waitUntil` (Hono middleware in index.ts; the DOs'
// existing `flushTraces` drivers). The buffer is isolate-global: an isolate that
// hosts both the worker and a DO (local dev) ships each batch under whichever
// flush driver ran first, so its `service_name` label reflects the flusher.

export interface LogShipEnv {
  LOKI_PUSH_URL?: string;
  LOKI_BASIC_AUTH?: string;
}

/** Loki timestamps are nanoseconds-since-epoch as a string; we have ms precision. */
type BufferedLine = { tsNs: string; level: LogLevel; line: string };

const BUFFER_MAX = 500;

let shipEnabled = false;
let buffer: BufferedLine[] = [];
// Lines lost to buffer overflow or failed pushes. `droppedTotal` is a running
// total (never reset — mirrors do-tracing's export_dropped_total); `droppedSinceReport`
// resets each time a flush reports it.
let droppedTotal = 0;
let droppedSinceReport = 0;

/**
 * Latch shipping on/off for this isolate from env config. Called per-request by the
 * flush middleware (and by the DO constructors) — must stay this cheap.
 */
export function configureLogShipping(env: LogShipEnv): void {
  shipEnabled = typeof env.LOKI_PUSH_URL === 'string' && env.LOKI_PUSH_URL.trim().length > 0;
}

function bufferLine(nowMs: number, level: LogLevel, line: string): void {
  if (buffer.length >= BUFFER_MAX) {
    buffer.shift();
    droppedTotal += 1;
    droppedSinceReport += 1;
  }
  buffer.push({ tsNs: `${nowMs}000000`, level, line });
}

/**
 * Push buffered lines to Loki. Never throws and never recurses into `log.*` — a
 * failed push is one raw `console.warn` and the batch is counted dropped (no
 * retry/re-queue; matches the fire-and-forget trace exporter). Safe under
 * concurrent invocation: the buffer is swapped out synchronously before any await,
 * so overlapping flushes each take a disjoint batch.
 */
export async function flushLogs(env: LogShipEnv, serviceName = 'valet-worker'): Promise<void> {
  const base = env.LOKI_PUSH_URL?.trim();
  // Flush when there are lines OR unreported drops — a drop report must not wait
  // for the next log line (there may never be one after a failed final push).
  if (!base || (buffer.length === 0 && droppedSinceReport === 0)) return;

  const batch = buffer;
  buffer = [];

  // Surface drops (overflow or failed pushes) as a synthetic warn line riding this flush.
  const reportedDrops = droppedSinceReport;
  if (reportedDrops > 0) {
    droppedSinceReport = 0;
    batch.push({
      tsNs: `${Date.now()}000000`,
      level: 'warn',
      line: JSON.stringify({
        level: 'warn',
        message: 'log shipping dropped lines (buffer overflow or failed push)',
        time: new Date().toISOString(),
        dropped: reportedDrops,
        dropped_total: droppedTotal,
      }),
    });
  }

  // One stream per level so `level` is a queryable label; batch order (chronological)
  // is preserved within each stream, as Loki requires.
  const byLevel = new Map<LogLevel, Array<[string, string]>>();
  for (const { tsNs, level, line } of batch) {
    let values = byLevel.get(level);
    if (!values) byLevel.set(level, (values = []));
    values.push([tsNs, line]);
  }
  const streams = [...byLevel.entries()].map(([level, values]) => ({
    stream: { service_name: serviceName, level },
    values,
  }));

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.LOKI_BASIC_AUTH) headers.Authorization = `Basic ${env.LOKI_BASIC_AUTH}`;

  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/loki/api/v1/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ streams }),
    });
    if (!res.ok) throw new Error(`Loki push failed: HTTP ${res.status}`);
  } catch (err) {
    // Count only real lines as newly dropped (not the synthetic report line), and
    // restore the drops whose report line was lost so the next flush re-reports them.
    const realLines = reportedDrops > 0 ? batch.length - 1 : batch.length;
    droppedTotal += realLines;
    droppedSinceReport += realLines + reportedDrops;
    // Raw console.warn — routing this through log.warn would re-buffer and recurse.
    console.warn('[log-shipping] Loki push failed, dropped batch', {
      error: err instanceof Error ? err.message : String(err),
      batch: realLines,
      droppedTotal,
    });
  }
}

/** Test-only: reset module shipping state (buffer, drop counters, enable latch). */
export function resetLogShippingForTests(): void {
  shipEnabled = false;
  buffer = [];
  droppedTotal = 0;
  droppedSinceReport = 0;
}
