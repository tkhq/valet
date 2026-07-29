/**
 * OpenTelemetry bootstrap (observability spec + distributed-tracing
 * extension). Env-gated: when `OTEL_EXPORTER_OTLP_ENDPOINT` (or the
 * `_TRACES_` variant) is unset, `initTelemetry` returns null, no SDK is
 * constructed, and every `@opentelemetry/api` call in the api AND the engine
 * stays a no-op — dev-local and tests run byte-identically to before.
 *
 * When enabled, `provider.register()` installs the GLOBAL tracer provider
 * plus the AsyncLocalStorage-backed context manager. That global is what
 * activates the direct instrumentation across the codebase:
 *  - the HTTP middleware (`traceRequests`) opens a server span per request;
 *  - `@valet/engine` (which depends only on `@opentelemetry/api`) opens
 *    `submission.run` → `agent.turn` → `tool.*` / `sandbox.exec` /
 *    `credentials.get` / `model.resolve` / `patch.capture` /
 *    `submission.settle` spans, linked to the admitting request via the
 *    traceparent stamped on the queue item;
 *  - the traced store wrapper times every SessionStore call.
 */
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { trace } from "@opentelemetry/api";

export interface Telemetry {
  endpoint: string;
  shutdown(): Promise<void>;
}

export function initTelemetry(): Telemetry | null {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME ?? "valet-api",
    }),
    // The exporter reads OTEL_EXPORTER_OTLP_* from the environment itself
    // (endpoint, headers, timeouts) — construct it bare so standard OTel env
    // configuration keeps working.
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  // Global registration: sets the tracer provider every `trace.getTracer()`
  // in-process resolves to (including the engine's) and installs the
  // AsyncLocalStorage context manager that makes parent/child nesting work
  // across await boundaries.
  provider.register();

  return {
    endpoint,
    shutdown: async () => {
      await provider.shutdown();
      trace.disable();
    },
  };
}
