# Durable Object Lifecycle Background Tracing Design

## Goal

Make the durable-object portion of a session lifecycle observable after its
initiating HTTP request has returned. The work covers the Worker/DO boundary
only; it does not instrument Modal sandbox code, the Runner, or OpenCode.

## Problem

`SessionAgentDO.fetch()` creates a trace for control requests, but `/start`,
`/wake`, and `/hibernate` schedule the expensive lifecycle work with
`ctx.waitUntil()`. Alarm-driven recovery does the same work without an HTTP
request at all. The existing `DoTracer` can create request roots and child
spans, but has no API to create and flush a standalone background root.

As a result, the current traces describe lifecycle acceptance, not lifecycle
completion or failure.

## Design

Add a `traceTask()` method to `DoTracer` that creates a standalone root span
from `ROOT_CONTEXT`, rather than inheriting a request context that may already
have completed. It runs a callback in that span's active context and flushes
its own provider through `ctx.waitUntil()`. The no-op tracer remains
allocation-free when tracing is disabled.

The task callback receives a small result handle. It calls `succeed(outcome)`
on its success path or `fail(errorClass, outcome)` before it handles an error
locally. `fail()` records an error status without an error message while
preserving the supplied fixed terminal outcome. An uncaught error is marked as
an error with the fixed `unexpected` class and `failed` outcome before being
re-thrown.
This makes caught and best-effort lifecycle failures visible without changing
their existing control flow.

`SessionAgentDO` will use that method at each lifecycle task boundary:

- `session.lifecycle.spawn` for initial and recovery sandbox creation;
- `session.lifecycle.hibernate` for snapshot/stop work;
- `session.lifecycle.restore` for wake/restore work;
- `session.lifecycle.recover` for recovery decisions and respawn scheduling.

The existing `SessionLifecycle` class remains responsible for the Modal HTTP
calls. `SessionAgentDO` wraps these calls in child spans at the Worker/DO
boundary; no sandbox implementation is changed. Termination remains awaited
and preserves its current semantics: it is a child `session.lifecycle.terminate`
span of the request or background task that initiated it, not a new background
root. This covers stop, refresh, snapshot-failure, and recovery-exhaustion
call sites.

`SessionLifecycle` will expose a typed, trace-safe result contract:

- successful spawn, snapshot, and restore results include `httpStatus` in
  addition to their existing fields;
- failures throw a `SandboxLifecycleError` with a fixed `traceErrorClass`, while
  preserving the existing error message for the product's current error path;
- termination returns `{ outcome, httpStatus?, errorClass? }` rather than
  swallowing network/non-success HTTP outcomes, while remaining best-effort and
  non-throwing to callers.

The only allowed error classes are `backend_http`, `backend_network`,
`sandbox_exited`, `snapshot_failed`, `configuration_missing`, and `unexpected`.
Trace code reads only that property, never `Error.message` or a backend body.

Each lifecycle root receives the existing session and user correlation
attributes, plus low-cardinality attributes appropriate to the operation:
`valet.lifecycle.trigger`, `valet.lifecycle.outcome`,
`valet.lifecycle.error.class`, `valet.session.status.from`,
`valet.session.status.to`, and `valet.recovery.attempt` when relevant.
Triggers are fixed enums: `initial_start`, `manual_hibernate`, `idle_timeout`,
`manual_wake`, `auto_wake`, `runner_disconnect`, `backoff_retry`,
`watchdog_timeout`, `ensure_running`, `refresh`, `restore_failed`, and
`spawn_failed`. `sandbox_wake_timeout` and any future health-monitor reason
map to `watchdog_timeout` before attributes are written. Outcomes are fixed
enums: `started`, `restored`, `hibernated`, `terminated`, `skipped`, `stale`,
`recovery_scheduled`, `backoff`, `exhausted`, and `failed`.

Sandbox IDs, snapshot IDs, runner tokens, prompt content, raw backend error
bodies, and dynamically composed recovery reasons are excluded from span
attributes, events, and exception messages. HTTP status can be recorded as a
numeric child-span attribute without recording its response body.

## Error Handling and Cardinality

`traceTask()` records only the fixed `unexpected` error class before rethrowing,
so existing lifecycle error handling remains authoritative. A task that catches
an error calls `fail()` with a fixed classification. `terminateSandbox()`
classifies network and non-success HTTP results rather than silently appearing
successful. Child spans around Modal calls record HTTP status/error class but
never request or response bodies.

The task result mapping is explicit:

| Task | Branch | Outcome | Error class / status |
| --- | --- | --- | --- |
| spawn | created | `started` | success |
| spawn | superseded generation | `stale` | success |
| spawn | backend/configuration failure | `failed` | typed lifecycle error |
| hibernate | not in `hibernating` state | `skipped` | success; status unchanged |
| hibernate | sandbox ID or hibernate URL missing | `failed` | `configuration_missing`; `hibernating` → `running` |
| hibernate | snapshot succeeds | `hibernated` | success |
| hibernate | sandbox exited or snapshot failed, then stop | `terminated` | `sandbox_exited` / `snapshot_failed` |
| hibernate | other failure | `failed` | typed lifecycle error |
| restore | already `running` or `restoring` | `skipped` | success; status unchanged |
| restore | snapshot, restore URL, or spawn request missing | `failed` | `configuration_missing`; status → `error` |
| restore | restore succeeds | `restored` | success |
| restore | restore fails and recovery starts | `recovery_scheduled` | typed lifecycle error |
| recover | spawn scheduled | `recovery_scheduled` | success |
| recover | orchestrator breaker | `backoff` | success |
| recover | regular-session breaker | `exhausted` | success |
| recover | missing configuration | `failed` | `configuration_missing` |
| terminate child | no sandbox / successful response | `skipped` / `terminated` | success |
| terminate child | HTTP/network failure | `failed` | `backend_http` / `backend_network` |

Tracing remains a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is configured.
Each standalone task flushes independently; it must not rely on the completed
HTTP request's exporter flush.

## Validation

Unit tests cover the `traceTask()` API with a test tracer/exporter and prove it
creates an independent root even with an active request parent, preserves task
attributes, records fixed error classes without a sensitive mock body, and
schedules a flush. Lifecycle tests verify the typed safe result/error contract,
including termination HTTP/network outcomes. Session-agent tests verify every
listed terminal branch, dynamic-watchdog-trigger sanitization, trigger
selection, and the stop, refresh,
snapshot-failure, and recovery-exhaustion termination call sites. The worker
tracing documentation is updated to describe the implemented DO coverage.
