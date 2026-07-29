/**
 * Engine tracing seam (observability spec, distributed-tracing extension).
 *
 * The engine depends ONLY on `@opentelemetry/api` — the dependency-free
 * facade whose tracer is a no-op until a host registers an SDK (the api does
 * this in `packages/api/src/observability/otel.ts` when an OTLP endpoint is
 * configured). With no SDK registered every helper here degrades to calling
 * the wrapped function with near-zero overhead, so dev-local and tests are
 * byte-identical to the untraced engine.
 *
 * Span linkage across the async boundary between an HTTP admission and the
 * turn that later runs it uses a W3C traceparent stamped into
 * `QueueItem.metadata["otel.traceparent"]` at admission — the submission's
 * root span then LINKS to the admitting request instead of parenting under
 * it (the request span has long since ended).
 */
import {
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Link,
  type Span,
} from "@opentelemetry/api";

const TRACER_NAME = "@valet/engine";

/** Metadata key carrying the admitting request's W3C traceparent. */
export const TRACEPARENT_METADATA_KEY = "otel.traceparent";

export function engineTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Run `fn` inside a new active span. The span is ended when `fn` settles;
 * a throw records ERROR status (message included) and rethrows. Children
 * created inside `fn` (including in other packages) nest automatically via
 * the host's AsyncLocalStorage context manager.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  opts?: { links?: Link[]; startTime?: number },
): Promise<T> {
  return engineTracer().startActiveSpan(
    name,
    { attributes, links: opts?.links, startTime: opts?.startTime },
    async (span) => {
      try {
        const result = await fn(span);
        span.end();
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.end();
        throw err;
      }
    },
  );
}

/** Mark a span failed without throwing (for error-shaped return values). */
export function markSpanError(span: Span, message: string): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/**
 * The active context's traceparent (`00-traceId-spanId-flags`), or undefined
 * when there is no recording span (no SDK, or not inside a request).
 */
export function activeTraceparent(): string | undefined {
  const spanContext = trace.getSpanContext(context.active());
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return undefined;
  return `00-${spanContext.traceId}-${spanContext.spanId}-0${spanContext.traceFlags.toString(16)}`;
}

/** Parse a stored traceparent back into a span link. Undefined on garbage. */
export function linkFromTraceparent(traceparent: unknown): Link | undefined {
  if (typeof traceparent !== "string") return undefined;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(traceparent);
  if (!m) return undefined;
  return {
    context: { traceId: m[1], spanId: m[2], traceFlags: parseInt(m[3], 16), isRemote: true },
  };
}

/** Truncate a command/label for span attributes — keep traces lean. */
export function attrTruncate(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
