import { trace } from '@opentelemetry/api';
import type { TraceConfig } from '@microlabs/otel-cf-workers';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { Env } from '../env.js';

/**
 * OpenTelemetry config + helpers for the Worker.
 *
 * Only `import type` is used against `@microlabs/otel-cf-workers` (it pulls in the
 * Workers-only `cloudflare:workers` module), so this stays unit-testable under Node;
 * the runtime `instrument()` wiring (and the redacting exporter) live in `index.ts`.
 * Tracing is a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset — the head sampler
 * drops every span, so nothing is recorded or exported and no network call is made.
 */

type TracingEnv = Pick<Env, 'OTEL_EXPORTER_OTLP_ENDPOINT' | 'OTEL_EXPORTER_OTLP_HEADERS'>;

const DEFAULT_OTLP_BASE = 'http://localhost:4318';

export function isTracingEnabled(env: TracingEnv): boolean {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return typeof endpoint === 'string' && endpoint.trim().length > 0;
}

/**
 * Parse the OTLP `key=value,key2=value2` header convention into a header map.
 *
 * Values are percent-decoded to match the backend parser (backend/tracing.py):
 * one OTEL_EXPORTER_OTLP_HEADERS value (e.g. the Grafana Cloud `Authorization=
 * Basic%20<token>` form) must yield the same auth header on both exporters.
 * Malformed escapes are left literal per-sequence, mirroring Python's lenient
 * unquote() — see percentDecode.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) headers[key] = percentDecode(value);
  }
  return headers;
}

const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;

/**
 * Percent-decode a single header value with the same per-sequence leniency as
 * Python's `urllib.parse.unquote` (backend/tracing.py). Splitting on `%`, each
 * fragment whose first two chars are valid hex contributes that byte and keeps
 * the rest literal; any other fragment keeps its leading `%` literal. The
 * assembled bytes are decoded as UTF-8 with replacement, so a stray `%` (or an
 * invalid UTF-8 byte) stays local to its own sequence instead of voiding the
 * whole value — `decodeURIComponent` would throw and drop the entire string,
 * making the two exporters derive different auth headers from one config.
 */
function percentDecode(value: string): string {
  if (!value.includes('%')) return value;
  const encoder = new TextEncoder();
  const bits = value.split('%');
  const chunks: Uint8Array[] = [encoder.encode(bits[0])];
  for (let i = 1; i < bits.length; i++) {
    const item = bits[i];
    const hex = item.slice(0, 2);
    if (HEX_PAIR.test(hex)) {
      chunks.push(Uint8Array.of(parseInt(hex, 16)));
      chunks.push(encoder.encode(item.slice(2)));
    } else {
      chunks.push(encoder.encode(`%${item}`));
    }
  }
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  // ignoreBOM keeps a leading U+FEFF instead of stripping it, matching
  // Python's urllib.parse.unquote (the backend decoder) byte-for-byte.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

// Secrets that sit in the URL PATH rather than the query — e.g. the Telegram bot token
// in `https://api.telegram.org/bot<token>/<method>` (services/telegram.ts,
// routes/channel-webhooks.ts). The HTTP instrumentation records the full outbound URL,
// so these must be scrubbed from the path too. Add patterns as integrations embed
// secrets in paths.
const PATH_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot<redacted>'],
];

function scrubPathSecrets(value: string): string {
  let out = value;
  for (const [pattern, replacement] of PATH_SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Drop secrets/PII from a span's URL attributes (applied by RedactingSpanExporter before
 * export). The HTTP instrumentation records the full request URL: query strings carry
 * OAuth codes/tokens (`/auth/github/callback?code=...`) and some outbound paths embed a
 * secret directly (the Telegram bot token). So strip every query string AND scrub known
 * path secrets across url.full / http.url / url.path; the low-cardinality path is kept.
 */
export function redactUrlAttributes(attrs: Record<string, unknown>): void {
  // Full-URL attributes (url.full, and http.url on cache spans): strip query, scrub path.
  for (const key of ['url.full', 'http.url']) {
    const v = attrs[key];
    if (typeof v === 'string') {
      const q = v.indexOf('?');
      attrs[key] = scrubPathSecrets(q >= 0 ? v.slice(0, q) : v);
    }
  }
  // Path-only attribute carries no query but can still embed a path secret.
  const path = attrs['url.path'];
  if (typeof path === 'string') attrs['url.path'] = scrubPathSecrets(path);
  if ('url.query' in attrs) attrs['url.query'] = '';
}

/**
 * Wraps an OTLP exporter to redact URL secrets from every span before it leaves the
 * worker. The library configures but never invokes `postProcessor` (rc.52), so the
 * exporter is the one hook that always fires. Shared by the worker (index.ts) and the
 * DO tracer (do-tracing.ts) so Durable Object spans get identical redaction.
 */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}
  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    for (const span of spans) redactUrlAttributes(span.attributes);
    this.inner.export(spans, resultCallback);
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export function buildTraceConfig(env: TracingEnv, serviceName: string): TraceConfig {
  const enabled = isTracingEnabled(env);
  const base = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_BASE).replace(/\/+$/, '');
  return {
    service: { name: serviceName },
    exporter: {
      url: `${base}/v1/traces`,
      headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    },
    // Sample everything when enabled, nothing when disabled (the no-op). Production
    // samples centrally at the Collector gateway, so the edge stays at 1.0.
    sampling: { headSampler: { ratio: enabled ? 1 : 0, acceptRemote: enabled } },
  };
}

/**
 * Attach Valet correlation ids to the active span as SPAN attributes (not resource
 * attributes — a Worker isolate serves many sessions). Safe to call when tracing is
 * off: `getActiveSpan()` returns undefined and this is a no-op. Query in Tempo with
 * `{ span.valet.user.id = "..." }`.
 */
export function setSessionAttributes(attrs: {
  sessionId?: string | null;
  userId?: string | null;
  orgId?: string | null;
}): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  if (attrs.sessionId) span.setAttribute('valet.session.id', attrs.sessionId);
  if (attrs.userId) span.setAttribute('valet.user.id', attrs.userId);
  if (attrs.orgId) span.setAttribute('valet.org.id', attrs.orgId);
}

/**
 * W3C `traceparent` for the currently-active span, or null when there's no real span
 * (tracing off, or called outside a span). Lets DO→DO fetches (e.g. SessionAgent→EventBus
 * publish) propagate trace context so the callee's spans join the same trace.
 */
export function activeTraceparent(): string | null {
  const sc = trace.getActiveSpan()?.spanContext();
  if (!sc || !sc.traceId || sc.traceId === '0'.repeat(32)) return null;
  const flags = (sc.traceFlags & 1) === 1 ? '01' : '00';
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

/**
 * `base` headers plus a `traceparent` for the active span, when there is one.
 * Shared by DO backend fetches (session-lifecycle.ts) and the scheduled
 * workspace-delete fan-out (index.ts) so both propagate trace context to the
 * Modal backend identically.
 */
export function withTraceparent(base: Record<string, string> = {}): Record<string, string> {
  const headers = { ...base };
  const traceparent = activeTraceparent();
  if (traceparent) headers['traceparent'] = traceparent;
  return headers;
}
