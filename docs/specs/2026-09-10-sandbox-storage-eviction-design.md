# Sandbox storage and eviction reporting

## Approved behavior

The user approved these changes on 2026-09-10 after a dev sandbox exceeded its 8 GiB Docker emptyDir limit.

- Set the default ephemeral-storage request to 2Gi and limit to 30Gi. Preserve independent provider-level per-sandbox overrides and persistent storage settings.
- Report Docker emptyDir usage and total pod ephemeral usage against their actual limits. Include namespace, pod, session, usage, and limit.
- Alert before eviction, with short evaluation intervals. Route these alerts to the existing Slack receiver. Keep node disk alerts.
- Surface confirmed Kubernetes eviction as `Sandbox evicted`, with the Kubernetes reason and an actionable recovery instruction.
- A failed polling exec or missing status marker must never become a successful command result.

## Design

The Kubernetes provider reads pod identity and terminal status when dispatching and when exec fails. It also checks recent pod eviction events when the pod is already gone. Confirmation must distinguish eviction from a normal command exit. Preserve the reason across the engine error boundary, invalidate the failed attachment, and never automatically replay a command with unknown side effects.

Keep Kubernetes exec status diagnostics in an explicit failure. Polling checks transport status before parsing the job marker and rejects an empty or malformed marker.

Monitoring must use kubelet pod/volume statistics, not node filesystem free space or container writable-layer usage alone. The collector runs with its own monitoring identity. It must not extend the Valet workload identity with node access. Limit series come from pod specifications. Missing/stale measurements produce a monitoring-health alert, not a false zero. Alert at 70% of a finite limit, without a multi-minute hold. Use a 15-second collection/evaluation interval and short notification grouping. Alert delivery cannot be guaranteed for a jump past the limit between samples. Keep the existing node capacity backstop for aggregate burst usage.

A dedicated Alertmanager route sends storage warnings to the existing Slack receiver with a five-second grouping delay. Other warning routes stay unchanged. The warning text identifies session/pod, storage domain, bytes used, configured limit, and the instruction to increase allocation or reduce retained Docker data.

## Validation

Add regression tests for eviction before dispatch, during kickoff/poll, and after pod deletion. Keep normal command exit 1 distinct. Verify empty stderr never implies success. Test storage defaults and overrides. Test collector statistics/label matching, absent data, and alert thresholds with fixtures. Run targeted suites, type checks, and the full `make e2e` scorecard. Validate monitoring manifests and alert rules. Prepare rollout changes; do not modify a running sandbox or send a test Slack message without authorization.

## Storage configuration

`VALET_SANDBOX_EPHEMERAL_STORAGE_REQUEST=2Gi` reserves node-local disk for scheduling.
`VALET_SANDBOX_EPHEMERAL_STORAGE_LIMIT=30Gi` sets the eviction ceiling and Docker emptyDir size limit.
The chart exposes these as `sandbox.ephemeralStorageRequest` and `sandbox.ephemeralStorageLimit`.
The provider merges explicit `SandboxCreateOpts.resources` fields over these defaults.
`workspaceStorage` sizes the separate persistent volume. It does not increase Docker capacity.
A `df` result reports filesystem free space, not these Kubernetes limits.
Keep node disk alerts: concurrent bursts can exhaust a node before every sandbox reaches its own limit.

## Rollout

1. Apply the infrastructure monitoring change. Check collector authorization, connectivity, measurements, and the notification route.
2. Release the updated API image and Valet chart 0.10.8. Update the environment's image and chart pins.
3. Verify that new sandbox pods request 2Gi and limit both ephemeral storage and Docker emptyDir to 30Gi.

Existing pods retain their admitted limits. Explicit deployment or provider overrides also retain their configured values.
The collector reads each pod's actual limit, including older 8Gi pods.
Live notification delivery needs separate verification. This implementation does not deploy changes or send a test notification.
