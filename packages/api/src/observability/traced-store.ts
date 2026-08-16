/**
 * SessionStore tracing proxy (distributed tracing): wraps every async store
 * method in a `store.{method}` span so Postgres round-trip time is visible
 * inside the submission/turn trees — store writes are a candidate bottleneck
 * the LLM/tool spans can't explain on their own.
 *
 * Apply only when telemetry is enabled (`initTelemetry` returned non-null):
 * with the SDK off the extra wrapper would be pure overhead on the hottest
 * I/O path in the process.
 */
import { withSpan } from "@valet/engine";
import { metrics, type Attributes, type Histogram } from "@opentelemetry/api";

/** Generic so tests can trace a partial store without lying to the compiler;
 * production use is `tracedSessionStore<SessionStore>(pgStore)`. Only async
 * methods belong on the wrapped object — the wrapper awaits every call. */
/** Methods whose FIRST string argument is not a session id — everything
 * else on SessionStore takes sessionId first, which makes "all store calls
 * for session X" a one-attribute Tempo query. */
const NON_SESSION_ARG0 = new Set([
  "insertAttemptMarker",
  "deleteAttemptMarker",
  "hasAttemptMarker",
  "renewLeases",
]);

interface TracedStoreOptions {
  /** Span name prefix: `{prefix}.{method}`. */
  prefix: string;
  meterName: string;
  histogramName: string;
  histogramDescription: string;
  /** Attributes derived from the call, by method name + args. */
  attrFor: (method: string, args: unknown[]) => Attributes;
}

function tracedStore<T extends object>(store: T, opts: TracedStoreOptions): T {
  // Lazy: the meter must resolve AFTER initTelemetry's global registration.
  let storeDuration: Histogram | undefined;
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) =>
        withSpan(`${opts.prefix}.${prop}`, opts.attrFor(prop, args), async () => {
          storeDuration ??= metrics.getMeter(opts.meterName).createHistogram(opts.histogramName, {
            unit: "ms",
            description: opts.histogramDescription,
          });
          const startedAt = Date.now();
          try {
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          } finally {
            storeDuration.record(Date.now() - startedAt, { method: prop });
          }
        });
    },
  });
}

export function tracedSessionStore<T extends object>(store: T): T {
  return tracedStore(store, {
    prefix: "store",
    meterName: "@valet/api-store",
    histogramName: "valet.store.duration",
    histogramDescription: "SessionStore call duration, by method",
    attrFor: (method, args) =>
      typeof args[0] === "string" && !NON_SESSION_ARG0.has(method)
        ? { "valet.session.id": args[0] }
        : {},
  });
}

/**
 * WorkflowStore tracing proxy — same contract as `tracedSessionStore`, with
 * `workflow-store.{method}` spans. Every WorkflowStore method that takes a
 * run id takes it as the first string argument — except
 * `consumeSignalAndCheckpoint`, whose first argument is a signal id — which
 * makes "all store calls for run X" a one-attribute query next to the
 * interpreter's `workflow.drive`/`workflow.node.*` spans.
 */
const WORKFLOW_SIGNAL_ARG0 = new Set(["consumeSignalAndCheckpoint"]);

export function tracedWorkflowStore<T extends object>(store: T): T {
  return tracedStore(store, {
    prefix: "workflow-store",
    meterName: "@valet/api-workflow-store",
    histogramName: "valet.workflow.store.duration",
    histogramDescription: "WorkflowStore call duration, by method",
    attrFor: (method, args) => {
      if (typeof args[0] !== "string") return {};
      return WORKFLOW_SIGNAL_ARG0.has(method)
        ? { "valet.workflow.signal.id": args[0] }
        : { "valet.workflow.run.id": args[0] };
    },
  });
}
