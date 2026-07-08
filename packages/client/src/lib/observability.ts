import type { Faro, TransportItem } from '@grafana/faro-web-sdk';
import { buildInfo } from '@/lib/build-info';
import { useAuthStore } from '@/stores/auth';

/**
 * Grafana Faro frontend observability (RUM + product events).
 *
 * Ships dark: everything in this module is a hard no-op unless
 * `VITE_FARO_URL` is set at build time — mirroring the worker's
 * OTEL_EXPORTER_OTLP_ENDPOINT pattern. The SDK is loaded dynamically so a
 * dark build never evaluates (or downloads) Faro code.
 *
 * Privacy: `scrubBeforeSend` runs on every beacon — query strings are
 * stripped from URLs and token-shaped values are redacted. User identity is
 * only ever the opaque user id (no email, no name). Event attributes are
 * restricted to ids/enums/numbers — never free text, prompts, or messages.
 */

let faroInstance: Faro | null = null;
let initStarted = false;

export function isFaroEnabled(): boolean {
  const url = import.meta.env.VITE_FARO_URL;
  return typeof url === 'string' && url.trim().length > 0;
}

// Full-match token shapes are replaced with [REDACTED]; the key=value shape
// keeps the key so redacted payloads stay debuggable.
const TOKEN_PATTERNS: RegExp[] = [
  /glc_[A-Za-z0-9+/=_-]{4,}/g, // Grafana Cloud tokens
  /gh[oprsu]_[A-Za-z0-9]{8,}/g, // GitHub tokens (gho_, ghp_, ghr_, ghs_, ghu_)
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, // Authorization header values
];
const TOKEN_KEY_VALUE_PATTERN = /(api[-_]?token['"]?\s*[:=]\s*)[^\s"',;&]+/gi;

// Query strings can carry OAuth codes, tokens, and file paths — strip them
// from every http(s)/ws(s) URL that appears anywhere in a beacon.
const URL_WITH_QUERY_PATTERN = /((?:https?|wss?):\/\/[^\s?"'<>()]+)\?[^\s"'<>()]*/g;

export function scrubValue(value: string): string {
  let out = value.replace(URL_WITH_QUERY_PATTERN, '$1');
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out.replace(TOKEN_KEY_VALUE_PATTERN, '$1[REDACTED]');
}

const MAX_SCRUB_DEPTH = 16;

function deepScrub(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubValue(value);
  if (depth >= MAX_SCRUB_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => deepScrub(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = deepScrub(entry, depth + 1);
  }
  return out;
}

/**
 * beforeSend hook applied to every Faro beacon (exceptions, events,
 * measurements, traces, logs). Returns a scrubbed copy — the shared meta
 * object is never mutated.
 */
export function scrubBeforeSend(item: TransportItem): TransportItem {
  return deepScrub(item, 0) as TransportItem;
}

/**
 * Only propagate `traceparent` to the API origin — never to third-party
 * hosts. In dev the API is same-origin (Vite proxy), which the fetch
 * instrumentation propagates to by default.
 */
export function getTracePropagationUrls(): RegExp[] {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (!apiUrl || !/^https?:\/\//.test(apiUrl)) return [];
  try {
    const origin = new URL(apiUrl).origin;
    // Anchor to a path boundary so https://api.example.com never matches
    // https://api.example.com.evil.com or https://api.example.company.com.
    return [new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`)];
  } catch {
    return [];
  }
}

function syncUser(user: { id: string } | null | undefined): void {
  if (!faroInstance) return;
  // Opaque id only — never email or name.
  if (user?.id) {
    faroInstance.api.setUser({ id: user.id });
  } else {
    faroInstance.api.resetUser();
  }
}

export async function initFaro(): Promise<void> {
  if (initStarted || !isFaroEnabled()) return;
  initStarted = true;

  try {
    const [{ initializeFaro, getWebInstrumentations }, { TracingInstrumentation }] =
      await Promise.all([import('@grafana/faro-web-sdk'), import('@grafana/faro-web-tracing')]);

    faroInstance = initializeFaro({
      url: import.meta.env.VITE_FARO_URL!.trim(),
      app: {
        name: 'valet-client',
        version: buildInfo.versionTag ?? buildInfo.commitHash,
        environment: buildInfo.environment,
      },
      sessionTracking: { enabled: true },
      instrumentations: [
        // captureConsole stays off — console logs can contain free text.
        ...getWebInstrumentations({ captureConsole: false }),
        new TracingInstrumentation({
          instrumentationOptions: {
            propagateTraceHeaderCorsUrls: getTracePropagationUrls(),
          },
        }),
      ],
      beforeSend: scrubBeforeSend,
    });

    syncUser(useAuthStore.getState().user);
    useAuthStore.subscribe((state) => syncUser(state.user));
  } catch {
    // Observability must never break the app — stay dark on init failure.
    faroInstance = null;
  }
}

export type TrackEventAttributes = Record<string, string | number | boolean | null | undefined>;

/**
 * Push a product event. Safe no-op before init or when Faro is dark.
 * Attributes must be ids, enums, or numbers — never free text.
 */
export function trackEvent(name: string, attrs?: TrackEventAttributes): void {
  if (!faroInstance) return;
  try {
    const attributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (value === null || value === undefined) continue;
      attributes[key] = String(value);
    }
    faroInstance.api.pushEvent(name, attributes);
  } catch {
    // Telemetry must never break the app.
  }
}

/** Report a handled error (e.g. from a React error boundary). Safe no-op when dark. */
export function trackError(error: Error, context?: Record<string, string>): void {
  if (!faroInstance) return;
  try {
    faroInstance.api.pushError(error, { context });
  } catch {
    // Telemetry must never break the app.
  }
}

interface RouterLike {
  subscribe: (
    eventType: 'onResolved',
    fn: (event: {
      toLocation: { pathname: string };
      fromLocation?: { pathname: string };
      pathChanged: boolean;
    }) => void,
  ) => () => void;
}

/**
 * Track route transitions on the TanStack Router instance. Only pathnames
 * are recorded — search params never leave the browser. The `from` pathname
 * is included (absent on initial load) so funnels get edges, not just nodes.
 */
export function observeRouter(router: RouterLike): void {
  if (!isFaroEnabled()) return;
  router.subscribe('onResolved', ({ toLocation, fromLocation, pathChanged }) => {
    if (!pathChanged && fromLocation) return;
    faroInstance?.api.setView({ name: toLocation.pathname });
    trackEvent('route_change', { to: toLocation.pathname, from: fromLocation?.pathname });
  });
}
