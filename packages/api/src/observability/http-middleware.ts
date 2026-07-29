/**
 * Hono middleware: one server span per HTTP request (distributed tracing).
 * Always installed — with no SDK registered (`initTelemetry` returned null)
 * every span here is a no-op object, so the untraced request path costs one
 * closure. Health probes are excluded (kube liveness noise).
 *
 * The span is ACTIVE across `next()`, so anything the route handler does —
 * store reads, engine admission (which stamps the queue item's traceparent
 * from this very context) — nests under or links back to this request.
 */
import type { MiddlewareHandler } from "hono";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const EXCLUDED_PATHS = new Set(["/api/health"]);

export function traceRequests(): MiddlewareHandler {
  const tracer = trace.getTracer("@valet/api-http");
  return async (c, next) => {
    if (EXCLUDED_PATHS.has(c.req.path)) return next();
    // Route pattern (e.g. /api/sessions/:id/messages) keeps span-name
    // cardinality bounded; fall back to the raw path pre-routing.
    const name = `${c.req.method} ${c.req.routePath ?? c.req.path}`;
    return tracer.startActiveSpan(
      name,
      {
        attributes: {
          "http.request.method": c.req.method,
          "url.path": c.req.path,
        },
      },
      async (span) => {
        try {
          await next();
          span.setAttribute("http.response.status_code", c.res.status);
          if (c.res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          // Rename to the matched route now that routing has happened.
          span.updateName(`${c.req.method} ${c.req.routePath ?? c.req.path}`);
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  };
}
