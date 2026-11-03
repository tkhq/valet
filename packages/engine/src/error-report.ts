/**
 * One call for an error path that does not throw
 * (`docs/specs/2026-10-30-error-instrumentation-design.md`). A catch block
 * that only logs hides its failures from metrics and traces, so the next
 * incident starts with an observability gap. `reportError`:
 *
 *  1. counts the failure in `valet.errors{area, reason, provider}`
 *     (Prometheus: `valet_errors_total`);
 *  2. marks the active span ERROR with the area and reason, never the
 *     error text, which can hold a URL or a token;
 *  3. writes one trace-aware log line (`log.ts`) with the message, the
 *     error, and its stack;
 *  4. keeps a one-hour, in-process tally that the
 *     `diagnostics.list_server_errors` tool reads.
 *
 * It never retries or repairs anything ("Invariants: alert, don't
 * auto-repair" in CLAUDE.md). The caller keeps its own control flow.
 */
import { trace } from "@opentelemetry/api";
import { errorLogFields, log, type LogFields } from "./log.js";
import { recordError } from "./metrics.js";
import { markSpanError } from "./tracing.js";

export const ERROR_AREAS = ["api", "boot", "engine", "channels", "events", "workflows", "plugins", "sandbox"] as const;
export type ErrorArea = (typeof ERROR_AREAS)[number];

export interface ErrorReport {
  area: ErrorArea;
  /** Fixed snake_case name of the failing step, such as `outbound_delivery`.
   * It is a metric label: never an id, a count, or error text. */
  reason: string;
  /** The integration, channel type, or sandbox backend, when one applies.
   * It is a metric label: a name such as `slack`, never an id. */
  provider?: string;
  /** Log level. Default `error`. A `warn` report still counts and still
   * marks the span: it is a failure the caller chose to tolerate. */
  level?: "warn" | "error";
  /** Log-only context such as ids. Never a metric label or span attribute. */
  fields?: LogFields;
}

/** A metric label value: lowercase, starts with a letter, at most 48 chars. */
const LABEL = /^[a-z][a-z0-9_-]{0,47}$/;
/** Distinct (area, reason, provider) series. Past the cap, a new series
 * counts as `reason=series_overflow` for its area, so a bad label cannot
 * grow the series count without bound. */
export const MAX_ERROR_SERIES = 256;
/** How far back the in-process tally reaches. */
export const ERROR_TALLY_WINDOW_MS = 60 * 60_000;
const MINUTE_MS = 60_000;

interface Series {
  area: ErrorArea;
  reason: string;
  provider?: string;
  /** Per-minute counts, oldest first, pruned past the window on every
   * write and read: at most 61 entries. */
  minutes: Array<{ minute: number; count: number }>;
  lastAt: number;
}

/** Every series seen since start. Capped at `MAX_ERROR_SERIES` entries plus
 * one overflow entry per area; entries are never deleted, because the
 * label set is bounded. */
const series = new Map<string, Series>();

function labels(report: ErrorReport): { area: ErrorArea; reason: string; provider?: string; key: string } {
  const reason = LABEL.test(report.reason) ? report.reason : "invalid_reason";
  const provider = report.provider === undefined ? undefined : LABEL.test(report.provider) ? report.provider : "other";
  const key = `${report.area}|${reason}|${provider ?? ""}`;
  if (series.has(key) || series.size < MAX_ERROR_SERIES) return { area: report.area, reason, provider, key };
  return { area: report.area, reason: "series_overflow", key: `${report.area}|series_overflow|` };
}

function errorClass(err: unknown): string {
  if (err instanceof Error) return err.name;
  return err === undefined ? "none" : typeof err;
}

function tally(key: string, area: ErrorArea, reason: string, provider: string | undefined, now: number): void {
  let entry = series.get(key);
  if (!entry) {
    entry = { area, reason, ...(provider ? { provider } : {}), minutes: [], lastAt: now };
    series.set(key, entry);
  }
  const minute = Math.floor(now / MINUTE_MS);
  const last = entry.minutes[entry.minutes.length - 1];
  if (last?.minute === minute) last.count += 1;
  else entry.minutes.push({ minute, count: 1 });
  prune(entry, now);
  entry.lastAt = now;
}

function prune(entry: Series, now: number): void {
  const oldest = Math.floor((now - ERROR_TALLY_WINDOW_MS) / MINUTE_MS);
  while (entry.minutes.length > 0 && entry.minutes[0]!.minute < oldest) entry.minutes.shift();
}

export function reportError(report: ErrorReport, message: string, err?: unknown, now = Date.now()): void {
  const { area, reason, provider, key } = labels(report);
  recordError(area, reason, provider);
  tally(key, area, reason, provider, now);
  const span = trace.getActiveSpan();
  if (span?.isRecording()) {
    markSpanError(span, `${area}.${reason}`);
    span.setAttributes({
      "valet.error.area": area,
      "valet.error.reason": reason,
      ...(provider ? { "valet.error.provider": provider } : {}),
    });
    span.addEvent("exception", { "exception.type": errorClass(err) });
  }
  const fields: LogFields = {
    ...report.fields,
    area,
    reason,
    ...(provider ? { provider } : {}),
    ...errorLogFields(err),
  };
  if (report.level === "warn") log.warn(message, fields);
  else log.error(message, fields);
}

export interface ErrorTallyRow {
  area: ErrorArea;
  reason: string;
  provider?: string;
  count: number;
  lastAt: number;
}

/** Error reports in this process since `sinceMs` (at most one hour back),
 * most frequent first. A restart clears it; `valet_errors_total` keeps the
 * durable count. */
export function recentErrorReports(opts: { sinceMs: number; limit: number; now?: number }): ErrorTallyRow[] {
  const now = opts.now ?? Date.now();
  const sinceMinute = Math.floor(Math.max(opts.sinceMs, now - ERROR_TALLY_WINDOW_MS) / MINUTE_MS);
  const rows: ErrorTallyRow[] = [];
  for (const entry of series.values()) {
    prune(entry, now);
    const count = entry.minutes.reduce((sum, bucket) => (bucket.minute >= sinceMinute ? sum + bucket.count : sum), 0);
    if (count === 0) continue;
    rows.push({ area: entry.area, reason: entry.reason, ...(entry.provider ? { provider: entry.provider } : {}), count, lastAt: entry.lastAt });
  }
  rows.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  return rows.slice(0, opts.limit);
}

/** Test seam: forget every series. */
export function resetErrorReports(): void {
  series.clear();
}
