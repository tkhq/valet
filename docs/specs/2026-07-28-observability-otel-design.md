# Observability — OTel engine-trace export + bundled Grafana LGTM stack

**Date:** 2026-07-28
**Status:** Implemented (rev 3 — metrics + provisioned dashboard, 2026-07-29)
**Scope:** Env-gated OpenTelemetry trace export from `packages/api` (a pure
consumer of the engine event bus) and a bundled local observability stack
(`grafana/otel-lgtm`) in the Helm chart. Builds directly on the engine
traces substrate (`2026-07-22-engine-traces-design.md`), which put usage/
cost on the `turn_end` event and patch-capture records on
`submission_settled`.

## Decisions

1. **Direct instrumentation on `@opentelemetry/api` (rev 2).** The first
   revision synthesized spans from bus events; it is replaced by direct
   instrumentation everywhere. `@valet/engine` depends ONLY on
   `@opentelemetry/api` — the dependency-free facade whose spans are no-ops
   until a host registers an SDK. The api registers the SDK
   (`initTelemetry`, env-gated on `OTEL_EXPORTER_OTLP_ENDPOINT`) globally,
   which activates every span in-process AND installs the
   AsyncLocalStorage context manager that makes parent/child nesting flow
   across await boundaries. No SDK ⇒ dev-local/tests byte-identical.

2. **Span tree per submission, linked (not parented) to the admitting
   request.** Admission stamps the active context's W3C traceparent into
   `QueueItem.metadata["otel.traceparent"]` (`buildQueueItem`, the single
   construction funnel). At claim, `submission.run` starts with a span LINK
   back to it — the HTTP span ended long before the turn runs, so a link is
   the honest causality edge. Tree:

   - `{METHOD} {route}` — Hono middleware (`traceRequests`), one server
     span per request, health probes excluded, active across `next()`.
   - `submission.run` — claim→settle; `queue_wait_ms` (admission→claim
     latency), attempt, outcome; ERROR on failed outcomes.
     - `agent.turn` — the whole turn; `gen_ai.request.model`,
       `gen_ai.usage.*`, `valet.usage.*`, `valet.cost.total_usd` stamped at
       turn_end (same snapshot as the entry); resumes carry
       `valet.turn.resumed`.
       - `model.resolve` — host resolver latency.
       - `tool.{name}` — every tool call via the tool bridge; a
         decision-gate suspension ends the span with ERROR status (the
         suspension marker in the trace).
         - `sandbox.exec` / `sandbox.exec_job` — PolicySandbox dispatch,
           command (truncated), exit code; covers the ensureReady wait.
         - `credentials.get` — every credential access (resolver or raw
           store), service + hit/miss; never values.
       - `compaction` — proactive/reactive/manual passes.
     - `submission.settle` — reserve→finalize, outcome.
       - `patch.capture` — settle-time diff status/bytes.
   - `sandbox.provision` — full cold boot incl. the `prepareSandbox` hook
     (fire-and-forget warm; may outlive its parent turn).
   - `store.{method}` — every SessionStore call via a tracing proxy
     (`tracedSessionStore`), applied only when telemetry is enabled.

3. **Values never land on spans.** Credential spans carry service + hit;
   sandbox spans carry a 200-char command prefix; tool spans carry names
   and call ids, not args or results.

4. **Bundled stack: `grafana/otel-lgtm`, default-enabled, ephemeral.** One
   Deployment + two Services (`valet-otel` ClusterIP for OTLP 4317/4318,
   `valet-grafana` NodePort 30300 with anonymous-admin Grafana). emptyDir
   storage — this is the local reference/debug stack, not durable
   telemetry. `observability.enabled=false` drops all of it AND the api's
   OTLP env; `observability.otlpEndpoint` points the api at an external
   collector instead. Golden assertions in
   `deploy/chart/valet/test/golden.sh` pin all three renders.

5. **Metrics (rev 3): first-class OTel instruments, same no-op contract.**
   `packages/engine/src/metrics.ts` records via `metrics.getMeter()` (lazy —
   instruments resolve after the host's global MeterProvider registration):
   `valet.turns`, `valet.turn.duration`, `valet.tokens` (by kind/model),
   `valet.cost.usd`, `valet.submissions.settled` (by outcome),
   `valet.submission.queue_wait`, `valet.tool.duration`,
   `valet.sandbox.exec.duration`, `valet.sandbox.provision.duration`,
   `valet.credential.reads` (service, hit). The api adds
   `valet.http.request.duration` (middleware) and `valet.store.duration`
   (traced-store proxy). `initTelemetry` exports them via OTLP every 10s;
   the otel-lgtm collector forwards to Prometheus's native OTLP endpoint
   (names render as `valet_*_total` / `valet_*_milliseconds_*`).

6. **Provisioned dashboard.** `deploy/chart/valet/dashboards/valet.json`
   ("Valet — Agent Observability", uid `valet-observability`) is mounted
   into the otel-lgtm container via the `-grafana-dashboards` ConfigMap:
   stat tiles (turns/spend/tokens/settlements since api start — plain sums,
   because `increase()` misses a counter's birth value), rate/quantile
   timeseries for outcomes, turn duration, tokens, spend, tools, sandbox,
   credentials, HTTP and store latencies, plus a Tempo traces panel listing
   recent `submission.run` trees. Golden assertions pin the ConfigMap render
   and its observability.enabled gate.

## Out of scope

- Logs export (the LGTM stack accepts OTLP logs; stdout/kubectl remains the
  log surface today).
- Trace-context propagation INTO sandboxes (traceparent env into exec'd
  processes) and into the LLM provider's HTTP calls (pi-ai owns that
  client); the `agent.turn` span bounds LLM latency from outside.
- Grafana dashboards-as-code; Tempo search + Explore is the v1 surface.
- Durable telemetry storage or remote-cluster observability defaults.
