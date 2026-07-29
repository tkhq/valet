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
export function tracedSessionStore<T extends object>(store: T): T {
  // Lazy: the meter must resolve AFTER initTelemetry's global registration.
  let storeDuration: Histogram | undefined;
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) =>
        withSpan(`store.${prop}`, {}, async () => {
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
