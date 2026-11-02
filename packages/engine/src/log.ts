/**
 * Structured, trace-aware logging. Each line is one JSON object stamped
 * with the active span's `trace_id` and `span_id` when a span is in
 * context, so a line read with `kubectl logs` leads to its trace in Tempo.
 * The shape matches the legacy worker's `lib/log.ts`. Error paths log
 * through `reportError` (`error-report.ts`), which also counts and marks
 * the span.
 */
import { trace } from "@opentelemetry/api";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const INVALID_TRACE_ID = "00000000000000000000000000000000";
/** Longest serialized non-Error value kept in a log line. */
const MAX_VALUE_CHARS = 2_000;

/** JSON.stringify that survives cycles and bigints instead of throwing. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      return item;
    });
  } catch {
    return String(value);
  }
}

/** The log fields for a caught value: message, class and stack for an Error. */
export function errorLogFields(err: unknown): LogFields {
  if (err === undefined) return {};
  if (err instanceof Error) {
    return { error: err.message, error_class: err.name, ...(err.stack ? { stack: err.stack } : {}) };
  }
  const text = typeof err === "string" ? err : safeStringify(err);
  return { error: text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text };
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const ctx = trace.getActiveSpan()?.spanContext();
  // Caller fields go first, so they cannot replace the level, message, or trace ids.
  const entry: LogFields = { ...fields, level, message, time: new Date().toISOString() };
  if (ctx && ctx.traceId && ctx.traceId !== INVALID_TRACE_ID) {
    entry.trace_id = ctx.traceId;
    entry.span_id = ctx.spanId;
  }
  const line = safeStringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
