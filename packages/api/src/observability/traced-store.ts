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
import { metrics, type Histogram } from "@opentelemetry/api";

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

export function tracedSessionStore<T extends object>(store: T): T {
  // Lazy: the meter must resolve AFTER initTelemetry's global registration.
  let storeDuration: Histogram | undefined;
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      const sessionAttr = (args: unknown[]) =>
        typeof args[0] === "string" && !NON_SESSION_ARG0.has(prop)
          ? { "valet.session.id": args[0] }
          : {};
      return (...args: unknown[]) =>
        withSpan(`store.${prop}`, sessionAttr(args), async () => {
          storeDuration ??= metrics.getMeter("@valet/api-store").createHistogram("valet.store.duration", {
            unit: "ms",
            description: "SessionStore call duration, by method",
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
