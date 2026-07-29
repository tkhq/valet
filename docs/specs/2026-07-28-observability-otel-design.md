# Observability — OTel engine-trace export + bundled Grafana LGTM stack

**Date:** 2026-07-28
**Status:** Implemented
**Scope:** Env-gated OpenTelemetry trace export from `packages/api` (a pure
consumer of the engine event bus) and a bundled local observability stack
(`grafana/otel-lgtm`) in the Helm chart. Builds directly on the engine
traces substrate (`2026-07-22-engine-traces-design.md`), which put usage/
cost on the `turn_end` event and patch-capture records on
`submission_settled`.

## Decisions

1. **The exporter is an event-bus subscriber, not engine instrumentation.**
   The engine stays free of OTel imports. `initEngineTelemetry`
   (`packages/api/src/observability/otel.ts`) subscribes to the shared
   `EventStream` and synthesizes spans from enriched bus events. This is
   exactly the consumption pattern the engine-traces spec designed the
   enriched `turn_end` payload for — no `engine_entries` reads.

2. **Env-gated to a no-op.** Unless `OTEL_EXPORTER_OTLP_ENDPOINT` (or the
   `_TRACES_` variant) is set, no SDK is constructed and no subscriber is
   attached — dev-local and every test run behave byte-identically to
   before. The helm chart sets the var; nothing else does.

3. **Spans are synthesized retroactively.** The engine has no per-turn span
   context to propagate; instead `turn_end.turnDurationMs` gives the span
   its real duration (`startTime = event.timestamp - turnDurationMs`).
   Settlements/errors/sandbox transitions are instant (zero-duration)
   spans. There is deliberately no cross-span trace/parent linkage in this
   iteration — Tempo search by `service.name` / span name / session-id
   attribute is the query surface.

4. **Span vocabulary:**
   - `agent.turn` — `gen_ai.request.model`, `gen_ai.usage.input_tokens`/
     `output_tokens`, `valet.usage.cache_read_tokens`/`cache_write_tokens`/
     `total_tokens`, `valet.cost.total_usd` (absent when unpriced — the
     cost-is-null rule carries through), `valet.turn.reason`; ERROR status
     on `reason === "error"`.
   - `submission.settled` — `valet.submission.outcome` (+`.error`),
     `valet.patch.*` (the settle-patch record verbatim).
   - `engine.error` — `valet.error.code`/`message`/`recoverable`, ERROR.
   - `sandbox.status` — `valet.sandbox.state`/`epoch`/`id`.
   - Every span: `valet.session.id`, `valet.thread.id`,
     `valet.queue_item.id` when present.
   The mapping is the pure function `spansForBusEvent` (unit-tested);
   SDK/exporter wiring is a thin shell.

5. **Bundled stack: `grafana/otel-lgtm`, default-enabled, ephemeral.** One
   Deployment + two Services (`valet-otel` ClusterIP for OTLP 4317/4318,
   `valet-grafana` NodePort 30300 with anonymous-admin Grafana). emptyDir
   storage — this is the local reference/debug stack, not durable
   telemetry. `observability.enabled=false` drops all of it AND the api's
   OTLP env; `observability.otlpEndpoint` points the api at an external
   collector instead. Golden assertions in
   `deploy/chart/valet/test/golden.sh` pin all three renders.

## Out of scope

- Metrics and logs export (the LGTM stack accepts both; the api only sends
  traces today).
- Trace-context propagation into sandboxes / LLM HTTP calls.
- Grafana dashboards-as-code; Tempo search + Explore is the v1 surface.
- Durable telemetry storage or remote-cluster observability defaults.
