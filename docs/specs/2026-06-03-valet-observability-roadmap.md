# Valet Observability Roadmap: Session Tracing and Grafana Faro

**Date:** 2026-06-03
**Status:** Draft
**Reviewers:** Conner Swann

## Context

Valet already has a broad session tracing branch at `origin/carey/tkai-2-session-tracing`, but the branch spans Worker, Runner, OpenCode, protocol, and runtime attachment behavior. It now conflicts with current `main`, so the observability work should restart as a sequence of smaller PRs that preserve the current runtime behavior while landing reviewable tracing slices.

The backend/session tracing work should also include a separate Grafana Faro track for the web app. Backend traces answer what happened inside Worker, Runner, and OpenCode. Faro answers what users experienced in the browser: page load, route transitions, uncaught errors, API failures, and realtime connection churn.

## Goals

- Land observability in narrow PRs with clear review boundaries.
- Keep the backend/session tracing work separate from frontend Real User Monitoring.
- Correlate Faro frontend events with Tempo traces once scrubbers and identifiers are proven safe.
- Preserve the current attachment, PDF, and runtime path behavior while reapplying runner spans.
- Keep telemetry disabled unless explicit public collector configuration is present.

## Non-Goals

- Replacing the existing metrics, analytics, or logging systems.
- Landing code in this document PR.
- Enabling prompt, message, file, request body, or response body capture.
- Adding dashboards before the data model and scrubbing rules are stable.

## Roadmap

### 1. Shared tracing foundation

Add the shared tracing primitives used by the backend/session work:

- W3C `traceparent` helpers.
- OTLP JSON export utilities.
- BigInt nanosecond timestamp handling.
- Span batching and flush behavior.
- Unit tests for serialization, propagation, and no-op behavior.

This PR should avoid instrumentation breadth. Its job is to create the small foundation other slices can use.

### 2. Protocol and OTel environment propagation

Propagate trace context through the Worker/session/orchestrator boundaries without changing behavior:

- Add optional `traceparent` fields to runner protocol messages.
- Thread OTel environment variables through session spawn and restore paths.
- Keep protocol additions backward-compatible.
- Add tests around message shape and environment assembly.

This prepares correlation before adding many spans.

### 3. Runner prompt and workflow spans

Reapply runner-side spans against current `main`:

- Runner bootstrap and WebSocket connection lifecycle.
- Prompt dispatch and completion.
- Workflow execution.
- OpenCode request boundaries.

This slice should explicitly preserve current attachment, PDF, and runtime-path behavior. The previous tracing branch conflicted in this area, so review should focus on tracing as an overlay rather than a runtime refactor.

### 4. Worker `SessionAgentDO` spans

Instrument the Worker Durable Object lifecycle in a narrow PR:

- Sandbox spawn, restore, hibernate, terminate.
- Session status changes.
- Prompt queue dispatch and collect-mode flushes.
- Queue wait attributes such as reason, wait duration, and collect buffer size.

This remains the backend/session tracing track. It should not introduce Faro or browser telemetry.

### 5. Grafana Faro frontend RUM and browser errors

Add Faro as its own frontend telemetry PR after the backend context propagation shape is clear.

Likely implementation surface:

- `packages/client/package.json`: add Faro dependencies.
- `packages/client/src/main.tsx`: initialize Faro before React render.
- `packages/client/src/app.tsx`: route navigation instrumentation around TanStack Router.
- `packages/client/src/lib/telemetry/faro.ts`: initialization, no-op behavior, route naming, scrubbing, and helper events.
- `packages/client/src/api/client.ts`: sanitized API failure and timing capture.
- `packages/client/src/hooks/use-websocket.ts`, `use-sse.ts`, and `use-chat.ts`: realtime lifecycle and error events.
- Client Vite/deploy config: public `VITE_FARO_*` settings.

Capture first:

- Web vitals, initial load, and route transition timing.
- Uncaught errors and unhandled promise rejections.
- React error boundary events.
- Sanitized API method, status, duration, and error class.
- WebSocket/SSE connect, disconnect, reconnect, and abnormal close.
- Safe dimensions: route template, app version, environment, browser/device, and optional opaque IDs.

Privacy and security requirements:

- Disabled unless a public Faro collector config is set.
- No prompt text, chat messages, tool args, file contents, auth tokens, invite/join tokens, emails, raw URLs, request bodies, or response bodies.
- Use route templates instead of raw paths.
- Scrub query strings and headers.
- Keep Faro separate from `OTEL_CAPTURE_CONTENT`.
- Add CSP `connect-src` only for the configured collector.

Verification for this slice:

- Unit tests for no-op initialization and scrubbers.
- Client typecheck/build.
- Browser smoke test with a fake collector endpoint.
- Grafana Cloud check that web vitals and errors arrive without sensitive content.

### 6. Grafana dashboards and correlation

Build dashboards only after traces and Faro events are flowing with safe dimensions:

- Tempo/session traces by `valet.session.id`.
- Faro web vitals and route latency.
- Frontend error rates.
- API failure panels.
- Realtime disconnect/reconnect panels.

Correlation should start anonymous/opaque by default. Add user, org, and session correlation only after scrubbers are proven and the data contract is reviewed.

## Backend/session tracing split

The tracing branch should be split by review boundary:

| Slice | Primary surface | Review focus |
| --- | --- | --- |
| Shared foundation | shared tracing helpers and tests | Correct W3C propagation, export shape, timestamp handling, no-op behavior |
| Protocol propagation | Worker/session/orchestrator protocol and env assembly | Backward compatibility and trace context availability |
| Runner spans | `packages/runner` and OpenCode request boundaries | Span placement without runtime behavior changes |
| Worker `SessionAgentDO` spans | `packages/worker` session lifecycle and queue paths | Durable Object lifecycle visibility, queue wait attribution |
| Faro frontend telemetry | `packages/client` | Browser RUM, errors, realtime events, privacy scrubbers |
| Dashboards/correlation | Grafana Cloud dashboards and queries | Useful panels, safe dimensions, cross-signal navigation |

## Open Question

Should frontend telemetry remain fully anonymous for the first Faro PR, or should it include opaque session correlation from day one? The conservative default is anonymous/opaque browser telemetry first, then add user/org/session correlation in a later PR after scrubbers and route templating are proven.
