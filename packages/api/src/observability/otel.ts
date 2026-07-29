/**
 * OpenTelemetry export of engine traces (engine traces spec follow-on:
 * observability wiring). Env-gated: when `OTEL_EXPORTER_OTLP_ENDPOINT` (or
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is unset, `initEngineTelemetry`
 * returns null and the api runs exactly as before — no SDK started, no
 * subscriber attached.
 *
 * The exporter is a pure CONSUMER of the engine event bus (decision: the
 * engine emits durable events; observability attaches without engine
 * changes). One subscriber maps enriched bus events to spans:
 *
 *  - `turn_end`    → `agent.turn` span whose duration is the event's
 *                    `turnDurationMs` (the span is synthesized retroactively
 *                    at turn end — start time is derived, not observed) with
 *                    gen_ai.* usage/cost attributes from the same snapshot
 *                    persisted on the MessageEntry.
 *  - `submission_settled` → instant `submission.settled` span carrying the
 *                    outcome and the settle-patch record.
 *  - `error`       → instant `engine.error` span with ERROR status.
 *  - `sandbox_status` → instant `sandbox.status` span (provision/ready/
 *                    suspend transitions; epoch attribute).
 *
 * The span mapping lives in `spansForBusEvent` (pure, unit-tested); the
 * SDK/bus wiring below is a thin shell around it.
 */
import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { DeliveredBusEvent, EventStream } from "@valet/engine";

export interface MappedSpan {
  name: string;
  /** ms epoch. Instant spans have startTime === endTime. */
  startTime: number;
  endTime: number;
  attributes: Record<string, string | number | boolean>;
  error?: boolean;
}

/**
 * Pure mapping from a bus event to zero-or-one span descriptions. Exported
 * for unit coverage — the SDK wiring is untestable without a collector, the
 * mapping is where the correctness lives.
 */
export function spansForBusEvent(e: DeliveredBusEvent): MappedSpan[] {
  const base: Record<string, string | number | boolean> = {
    "valet.session.id": e.sessionId,
    ...(e.threadId ? { "valet.thread.id": e.threadId } : {}),
    ...(e.queueItemId ? { "valet.queue_item.id": e.queueItemId } : {}),
  };
  const ev = e.event;
  switch (ev.type) {
    case "turn_end": {
      const duration = ev.turnDurationMs ?? 0;
      return [
        {
          name: "agent.turn",
          startTime: e.timestamp - duration,
          endTime: e.timestamp,
          error: ev.reason === "error",
          attributes: {
            ...base,
            "valet.turn.reason": ev.reason,
            ...(ev.model !== undefined ? { "gen_ai.request.model": ev.model } : {}),
            ...(ev.usage
              ? {
                  "gen_ai.usage.input_tokens": ev.usage.input,
                  "gen_ai.usage.output_tokens": ev.usage.output,
                  "valet.usage.cache_read_tokens": ev.usage.cacheRead,
                  "valet.usage.cache_write_tokens": ev.usage.cacheWrite,
                  "valet.usage.total_tokens": ev.usage.total,
                }
              : {}),
            ...(ev.cost ? { "valet.cost.total_usd": ev.cost.total } : {}),
          },
        },
      ];
    }
    case "submission_settled":
      return [
        {
          name: "submission.settled",
          startTime: e.timestamp,
          endTime: e.timestamp,
          error: ev.outcome.outcome === "failed",
          attributes: {
            ...base,
            "valet.submission.outcome": ev.outcome.outcome,
            ...(ev.outcome.error !== undefined ? { "valet.submission.error": ev.outcome.error } : {}),
            ...(ev.patch
              ? {
                  "valet.patch.status": ev.patch.status,
                  ...(ev.patch.reason !== undefined ? { "valet.patch.reason": ev.patch.reason } : {}),
                  ...(ev.patch.blobKey !== undefined ? { "valet.patch.blob_key": ev.patch.blobKey } : {}),
                  ...(ev.patch.bytes !== undefined ? { "valet.patch.bytes": ev.patch.bytes } : {}),
                  ...(ev.patch.truncated !== undefined ? { "valet.patch.truncated": ev.patch.truncated } : {}),
                }
              : {}),
          },
        },
      ];
    case "error":
      return [
        {
          name: "engine.error",
          startTime: e.timestamp,
          endTime: e.timestamp,
          error: true,
          attributes: {
            ...base,
            "valet.error.code": ev.code,
            "valet.error.message": ev.error,
            "valet.error.recoverable": ev.recoverable,
          },
        },
      ];
    case "sandbox_status":
      return [
        {
          name: "sandbox.status",
          startTime: e.timestamp,
          endTime: e.timestamp,
          error: ev.state === "error",
          attributes: {
            ...base,
            "valet.sandbox.state": ev.state,
            "valet.sandbox.epoch": ev.epoch,
            ...(ev.sandboxId !== undefined ? { "valet.sandbox.id": ev.sandboxId } : {}),
          },
        },
      ];
    default:
      return [];
  }
}

function emitSpan(tracer: Tracer, mapped: MappedSpan): void {
  const span = tracer.startSpan(mapped.name, {
    startTime: mapped.startTime,
    attributes: mapped.attributes,
  });
  if (mapped.error) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end(mapped.endTime);
}

export interface EngineTelemetry {
  endpoint: string;
  shutdown(): Promise<void>;
}

/**
 * Start the OTLP trace pipeline and attach the bus subscriber. Returns null
 * (a full no-op) unless an OTLP endpoint is configured in the environment.
 */
export function initEngineTelemetry(eventStream: EventStream): EngineTelemetry | null {
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
  const tracer = provider.getTracer("valet-engine-traces");

  const unsubscribe = eventStream.subscribe({}, (e) => {
    try {
      for (const mapped of spansForBusEvent(e)) emitSpan(tracer, mapped);
    } catch (err) {
      // Observability must never take down the event plane.
      console.error("[otel] span emit failed:", err instanceof Error ? err.message : String(err));
    }
  });

  return {
    endpoint,
    shutdown: async () => {
      unsubscribe();
      await provider.shutdown();
    },
  };
}
