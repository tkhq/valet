# Error instrumentation and self-diagnosis

**Date:** 2026-10-30
**Status:** Implemented
**Scope:** Counters and span errors for error paths that only logged, API
process health gauges, and three read-only diagnostics tools that let an
organization admin's Valet read its own infrastructure. Builds on the
observability spec (`2026-07-28-observability-otel-design.md`).

## Problem

The 2026-10-28 dev OOM outage, the 503s on 10-27 and 10-29, and the
liveness restarts after deploys all needed debugging by hand. The causes
had the same shape: a catch block that only wrote `console.error`, so no
metric moved and no trace showed the failure. Prometheus had container
RSS, but no V8 heap and no event-loop delay. Valet could read its tool
failures and slow routes, but not a 5xx, a restart, or an OOM kill.

## Decisions

1. **One call for an error path that does not throw.** `reportError` in
   `packages/engine/src/error-report.ts` replaces `console.error` and
   `console.warn` at the error paths that matter. One call does four
   things:
   - It adds 1 to `valet.errors{area, reason, provider}`. Prometheus
     exports it as `valet_errors_total`.
   - It marks the active span ERROR, with the status message
     `<area>.<reason>`, the attributes `valet.error.area`,
     `valet.error.reason`, `valet.error.provider`, and an `exception`
     event with the error class only. Error text never goes on a span,
     because it can hold a URL or a token.
   - It writes one JSON log line through `log` (`packages/engine/src/log.ts`)
     with `level`, `message`, `time`, `trace_id`, `span_id`, the labels,
     the error message, its class, and its stack. The shape matches the
     legacy worker's trace-aware logger. A `kubectl logs` line now leads
     to its trace in Tempo.
   - It adds the report to a one-hour, in-process tally that
     `diagnostics.list_server_errors` reads.

   `reportError` never retries or repairs ("Invariants: alert, don't
   auto-repair" in CLAUDE.md). The caller keeps its own control flow.

2. **Bounded labels.** `area` is a closed union: `api`, `boot`, `engine`,
   `channels`, `events`, `workflows`, `plugins`, `sandbox`. `reason` is a
   fixed snake_case name for the failing step, such as
   `outbound_delivery` or `schedule_fire`. `provider` is a channel type,
   an integration name, or a sandbox backend. A value that does not match
   `^[a-z][a-z0-9_-]{0,47}$` becomes `invalid_reason` or `other`. Past 256
   series, a new series counts as `reason=series_overflow` for its area.
   Ids go in the log message or in `fields`, never in a label.

3. **Which paths report.** The pass converted the log-only error paths in
   `api` (route errors with status 500 or more, unhandled rejections,
   uncaught exceptions), boot restore and boot services, channels
   (delivery, streams, Slack inbox, gates, transports), events (dispatch,
   ingress, attention, waiters, claims, receipts), workflows (scheduler,
   run host, notifications, reclaim), plugin call paths (credential
   refresh, token renewal, GitHub and Linear connect and webhook
   handlers, policy resolution), the engine (session hooks, heartbeat,
   wakeups, leases, checkpoints, thread errors), and the sandbox layer
   (attachment reconcile, hibernation, the kubernetes provider). It left
   config notices, expected fallbacks, and sites that a dedicated metric
   already counts as plain log lines. A declared 4xx route error is a
   client refusal and stays a plain log line.

4. **API process gauges.** `packages/api/src/observability/process-health.ts`
   samples the process every 10 seconds and keeps one hour of samples:

   | OTel name | Prometheus name | Labels |
   |---|---|---|
   | `valet.process.memory` | `valet_process_memory_bytes` | `kind`: rss, heap_used, heap_total, external, array_buffers, cgroup_usage, cgroup_limit |
   | `valet.process.heap_limit` | `valet_process_heap_limit_bytes` | none |
   | `valet.process.event_loop.delay` | `valet_process_event_loop_delay_milliseconds` | `quantile`: p50, p99, max over the last interval |
   | `valet.process.start_time` | `valet_process_start_time_seconds` | none |

   `cgroup_usage` is the number the container OOM killer compares to
   `cgroup_limit`. `changes(valet_process_start_time_seconds[1h])` counts
   container restarts.

5. **Self-diagnosis tools.** The diagnostics plugin
   (`packages/api/src/diagnostics/actions.ts`) adds three tools next to
   `list_tool_failures` and `list_slow_requests`. All of them only read.
   They are for organization admins only. They refuse an external sender
   and a team's unattended run.
   - `diagnostics.list_server_errors`: 5xx responses by route pattern and
     status from the request-timing window, plus the `reportError` tally
     by area, reason, and provider. It reads one API process, up to 60
     minutes back.
   - `diagnostics.process_health`: RSS, heap used, total, and limit,
     cgroup memory and limit, event-loop delay, uptime, and start time,
     with peaks over the sample window.
   - `diagnostics.list_pod_restarts`: on the kubernetes backend, the API
     namespace's pods (the API and its database) with restart counts,
     state, last termination reason, and the last hour's Warning events.
     Sandbox pods are counts by node and termination reason, without pod
     or session names, because sandboxes belong to every organization on
     the deployment.

6. **RBAC is reported, not worked around.** The chart's Role
   (`deploy/chart/valet/templates/rbac.yaml`) lets the API service account
   list pods and events in the sandbox namespace only. The chart keeps it
   out of the API's own namespace on purpose. Until an operator grants
   the rule below, `list_pod_restarts` returns
   `{ error: "forbidden", requiredRbac }` for the API namespace and still
   answers for sandboxes:

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: Role
   metadata:
     name: valet-api-diagnostics
     namespace: valet            # the API's release namespace
   rules:
     - apiGroups: [""]
       resources: ["pods"]
       verbs: ["get", "list"]
     - apiGroups: [""]
       resources: ["events"]
       verbs: ["list"]
   ---
   apiVersion: rbac.authorization.k8s.io/v1
   kind: RoleBinding
   metadata:
     name: valet-api-diagnostics
     namespace: valet
   subjects:
     - kind: ServiceAccount
       name: valet-api
       namespace: valet
   roleRef:
     apiGroup: rbac.authorization.k8s.io
     kind: Role
     name: valet-api-diagnostics
   ```

   The grant lets the API read pod specs next to it, which include
   literal environment values. Review that before you add it.

## Deviations

- dev-v2 had no trace-aware logger. `log.ts` ports the legacy worker's
  shape instead of adding a dependency.
- Node restarts and node memory pressure need cluster-scoped `nodes`
  reads. They are out of scope; the runbook reads them with `kubectl`.

## Out of scope

- OTLP log export. stdout stays the log surface.
- Alert rules. The metrics above are the inputs; the Grafana alert
  definitions live with the deployment.
