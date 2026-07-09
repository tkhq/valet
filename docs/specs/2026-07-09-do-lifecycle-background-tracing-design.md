# Durable Object Lifecycle Background Tracing Design

## Goal

Make `SessionAgentDO` lifecycle work observable after the HTTP request that
scheduled it has returned. This covers Worker/DO orchestration only—not the
Modal sandbox, Runner, or OpenCode internals.

## Existing Coverage and Gap

The current DO tracer is cached per DO instance and batches spans. It already
traces HTTP control requests, WebSocket messages, and alarm ticks. Lifecycle
work such as sandbox spawn, hibernate, restore, and recovery is scheduled with
`ctx.waitUntil()` and has no explicit operation span. Its parent context is
therefore ambiguous and traces cannot directly answer which lifecycle operation
ran or why.

## Design

Add `DoTracer.traceTask()`. It starts an `INTERNAL` root from `ROOT_CONTEXT`,
so a task never inherits a completed HTTP request span. It reuses the cached
DO tracer and its existing batch processor; it does not create a provider or
force a network export per task. `SessionAgentDO` flushes the batch once each
lifecycle task completes, preventing the final span from being lost to DO
hibernation.

`SessionAgentDO` schedules named task roots for:

- `session.lifecycle.spawn`
- `session.lifecycle.hibernate`
- `session.lifecycle.restore`
- `session.lifecycle.recover`

Termination remains awaited and is traced as a child
`session.lifecycle.terminate` span of the request or lifecycle task that
initiated it. Its control flow is unchanged. It reports only its fixed outcome,
HTTP status, and a fixed HTTP/network error class; it never reads a backend
response body.

Lifecycle task attributes are limited to:

- `valet.session.id` and `valet.user.id`
- `valet.lifecycle.trigger`
- `valet.session.status.from` and `valet.session.status.to`
- `valet.recovery.attempt` when recovery is involved

Triggers are fixed values: `initial_start`, `manual_stop`,
`completed`, `sandbox_exited`, `recovery_exhausted`, `manual_hibernate`,
`idle_timeout`, `manual_wake`, `auto_wake`,
`runner_disconnect`, `backoff_retry`, `watchdog_timeout`, `ensure_running`,
`refresh`, `snapshot_failed`, `restore_failed`, and `spawn_failed`.
Dynamic health-monitor and backend error text is mapped to a fixed trigger
before it reaches a span attribute.

`traceTask()` marks uncaught errors with `do.task.error.class=unexpected`; the
lifecycle handlers mark caught failures with fixed `valet.lifecycle.error.class`
values. Neither path calls `recordException()`: existing lifecycle errors can
contain raw backend response text, which must not be sent to OTLP. Lifecycle
handlers keep their current status updates and user-facing error behavior.

## Validation

Unit tests prove that task roots are independent of an active request span,
are a no-op while tracing is disabled, and do not export uncaught error text.
Session-agent coverage verifies initial background spawn is scheduled through
the task tracer, caught failures use a fixed error class, and termination uses
a safe failure result and expected terminal status. Pure helper tests verify
recovery-reason sanitization and the stable attribute shape. The observability
guide documents the resulting DO coverage.
