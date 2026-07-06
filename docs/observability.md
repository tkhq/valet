# Observability

Valet instruments with **OpenTelemetry over OTLP** — a vendor-neutral standard, so the
backend is swappable via two env vars (a Collector, Datadog, Grafana Tempo, …). This is
the first slice (the Worker layer); the runner and OpenCode layers follow in later PRs.

**Metrics are the durable signal; traces are transient.** Spans export over OTLP, but the
lasting value is **metrics derived from them** — RED (rate/errors/duration) and, later,
spend/usage — at a Collector's `spanmetrics` connector. So retaining raw traces is
optional, and dashboards are built on metrics, not on trace queries. Treat spans as a
high-detail debugging signal, not the source of truth a dashboard depends on.

## What's instrumented today (Worker)

The Worker fetch/scheduled handler is wrapped with
[`@microlabs/otel-cf-workers`](https://github.com/evanderkoogh/otel-cf-workers), which
auto-creates spans for each request, instruments outbound `fetch`, and — via the DO
bindings — emits a **client span + W3C trace-context propagation for each worker→DO
call**, so DO calls stay correlated even though the DOs run uninstrumented. On top of that:

> **The DOs are deliberately not wrapped with `instrumentDO()`.** That wrapper proxies
> `ctx.storage`, which breaks the SQLite storage API (`ctx.storage.sql.exec`) the DOs
> rely on with an `Illegal invocation` error — even when tracing is disabled. DO-internal
> spans are a follow-up that adds manual spans inside the DO code (which bypass the
> storage proxy).

- **`valet.*` correlation attributes** (`valet.session.id`, `valet.user.id`,
  `valet.org.id`) are set as **span attributes** (not resource attributes — a Worker
  isolate is multi-tenant) via `setSessionAttributes()`. Query in Tempo with
  `{ span.valet.user.id = "..." }`.
- **Structured, trace-aware logging** (`lib/log.ts`): leveled JSON lines stamped with
  the active `trace_id` / `span_id`, so logs pivot to the trace that produced them.
- **Query strings are stripped from span URLs at the exporter** (`RedactingSpanExporter`
  in `index.ts`), so OAuth codes / tokens in URLs (e.g. `?code=...`) are never exported.
  This is source-side defense-in-depth; the Collector gateway (below) is still the place
  for full redaction.

Tracing is a **no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset** — the head sampler
drops every span, so nothing is recorded or exported and no network call is made. It
is safe to ship dark and enable per-environment.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (disabled) | OTLP/HTTP base, e.g. `http://localhost:4318`. Traces POST to `/v1/traces`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `key=value,key2=value2` auth headers (e.g. Grafana Cloud basic auth). Set via `wrangler secret put`. |

## Run it locally

```bash
make otel-local        # starts grafana/otel-lgtm (Collector + Tempo + Prometheus + Loki + Grafana)
```

Then point the worker at it — add to `packages/worker/.dev.vars`:

```
OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
```

```bash
make dev-worker        # wrangler dev on :8787
curl http://localhost:8787/health
```

Open Grafana at <http://localhost:3000> (admin/admin) → **Explore** → **Tempo** →
*Search* to see the trace. Filter by attribute, e.g. `{ span.valet.user.id = "..." }`.

Or run **`make otel-e2e`** for an automated smoke (no Grafana needed): it boots the
worker against a throwaway local collector and asserts spans export, query-string
secrets are redacted, and disabling the endpoint is a true no-op.

## Log shipping to Loki

The same trace-stamped JSON lines that `lib/log.ts` writes to the console (visible in
`wrangler tail`) are also shipped to **Loki** when configured, so logs sit next to the
Tempo traces in Grafana and pivot both ways on `trace_id`. Like tracing, this **ships
dark**: with `LOKI_PUSH_URL` unset the only cost per line is one boolean check, and no
network call is ever made. Console output is identical either way.

| Env var | Default | Purpose |
|---|---|---|
| `LOKI_PUSH_URL` | unset (disabled) | Loki base URL, e.g. `http://localhost:3100`. Lines POST to `/loki/api/v1/push`. |
| `LOKI_BASIC_AUTH` | unset | `base64(user:token)` sent as `Authorization: Basic …`. Set via `wrangler secret put`. |

How it works (`lib/log.ts`): Workers have no cross-request timers, so `emit()` appends
to a bounded in-memory buffer (500 lines; on overflow the oldest are dropped and a
synthetic warn line reports `dropped` / `dropped_total` on the next flush) and
`flushLogs` runs over `waitUntil` from the request/DO lifecycle: a Hono middleware on
the worker fetch path, the end of the scheduled tick, and the DOs' existing
`flushTraces` drivers (alarm / webSocketClose / pre-hibernate). Each batch is labeled
`{service_name, level}` where `service_name` is the flushing runtime —
`valet-worker`, `valet-session-agent-do`, or `valet-event-bus-do` (matching the trace
service names). A failed push is dropped (one `console.warn`, no retry), mirroring the
fire-and-forget trace exporter.

**Grafana Cloud:** logs need their **own** credentials — a token with `logs:write`
and the stack's **Loki instance ID** as the basic-auth user. The `traces:write` token and
the Tempo push instance ID will NOT work; Loki is a separate tenant on the stack.
`LOKI_PUSH_URL` is the stack's Loki host (e.g. `https://logs-prod-021.grafana.net`) and
`LOKI_BASIC_AUTH` is `base64(<loki instance id>:<logs:write token>)`.

Local test recipe (the same otel-lgtm image used for traces bundles Loki):

```bash
docker run -d --name valet-lgtm -p 4318:4318 -p 3001:3000 -p 3100:3100 grafana/otel-lgtm:latest
curl http://localhost:3100/ready        # Loki can take 30-60s
# add to packages/worker/.dev.vars:  LOKI_PUSH_URL = "http://localhost:3100"
make dev-worker
curl http://localhost:8787/health
curl -G -s http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service_name="valet-worker"}'
```

Open Grafana at <http://localhost:3001> → **Explore** → **Loki** and query
`{service_name="valet-worker"}`; with `OTEL_EXPORTER_OTLP_ENDPOINT` also set, the
`trace_id` in each line links to the Tempo trace.

## Production

Do **not** point the worker directly at the backend in production. The `otel-cf-workers`
exporter sends one OTLP/HTTP request per worker invocation over `ctx.waitUntil` with
**no batching, no retry, and a silent drop on any non-2xx** — a brief outage loses every
span in that window with zero signal. Production sends to a standalone **OTel Collector**
(or Grafana Alloy) that owns the sending queue, retry, WAL, tail sampling, and PII
redaction. Crucially, the Collector also **derives metrics from the spans** (the
`spanmetrics` connector) and forwards *those* to the metrics backend (Datadog / Prometheus)
— retaining the raw traces is optional. Point `OTEL_EXPORTER_OTLP_ENDPOINT` at the
Collector; reconcile worker-emitted vs Collector-accepted span counts to watch the one
lossy hop.

The full cross-layer design (runner + OpenCode layers, the spend/usage metrics, span
links) lives in the tracing design doc / Linear issue.

## Frontend observability (Faro)

The client instruments with **Grafana Faro** (`@grafana/faro-web-sdk` +
`@grafana/faro-web-tracing`) — the Grafana Cloud equivalent of Sentry/PostHog. Like the
worker, it **ships dark**: everything in `packages/client/src/lib/observability.ts` is a
hard no-op unless `VITE_FARO_URL` is set at build time, and the SDK is loaded dynamically
so dark builds never even download it.

| Env var | Default | Purpose |
|---|---|---|
| `VITE_FARO_URL` | unset (disabled) | Faro collector URL (Grafana Cloud Frontend Observability endpoint or Alloy `faro.receiver`). Build-time only. |
| `FARO_URL` | unset | `scripts/deploy.sh` passes this through to the client build as `VITE_FARO_URL`. |

**What's captured when enabled**

- **Web vitals + page/navigation performance** (`getWebInstrumentations`, console capture
  deliberately **off** — console logs can contain free text).
- **Uncaught errors / unhandled rejections**, plus React error-boundary catches
  (`trackError` in `components/error-boundary.tsx`).
- **Route transitions**: a `route_change` event per TanStack Router `onResolved` with the
  **pathname only** — search params never leave the browser.
- **Frontend traces** via `TracingInstrumentation`; `traceparent` is propagated **only to
  the API origin** (derived from `VITE_API_URL`, allowed by the worker's CORS
  `allowHeaders`), so frontend spans correlate with worker traces in Tempo.
- **Sanitized API failures** (`api_error`: status/code/path) and **WebSocket lifecycle**
  (`ws_connected` / `ws_disconnected` / `ws_error` with the socket path).
- **Product events** via `trackEvent(name, attrs)` — a safe no-op when dark:
  `prompt_submitted`, `session_created`, `workflow_run`, `approval_resolved`, each carrying
  ids/enums/counts only (`valet.session.id` where available).

**Scrubbing guarantees** (`scrubBeforeSend`, applied to every beacon — events, errors,
measurements, traces):

- Query strings are stripped from **every** URL anywhere in a payload (page URL, stack
  frames, fetch spans) — OAuth `?code=`, token, and path params are never exported.
- Token-shaped values (`glc_…`, GitHub `gho_`/`ghp_`/…, `Bearer …`, `api-token=…`) are
  replaced with `[REDACTED]`.
- User identity is only ever the **opaque user id** (`faro.api.setUser({ id })` on login,
  reset on logout) — no email, no name.
- Prompts, messages, and any other free text are never sent: `trackEvent` attributes are
  restricted to ids, enums, and numbers, and console capture is off.
