# Sandbox storage and eviction implementation plan

The user approved the linked design. Implement in isolated checkouts of Valet and test-agents-infra.

## Task 1: Eviction diagnostics

- [x] Add failing tests in sandbox-kubernetes for failed/empty polls and explicit eviction.
- [x] Preserve Kubernetes status details in exec.ts. Reject failed polling exec and invalid status in jobs.ts.
- [x] Extend pod status diagnostics in provider.ts and event lookup for deleted pods, with minimal namespace RBAC.
- [x] Preserve `Sandbox evicted` through PolicySandbox; keep ordinary command failures distinct and avoid replay.
- [x] Run sandbox-kubernetes and relevant engine tests and update the maintained spec.

## Task 2: Storage allocation

- [x] Change chart/default env examples from 2Gi/8Gi to 2Gi/30Gi.
- [x] Verify provider-level per-sandbox overrides support ephemeral request and limit without changing persistent storage behavior.
- [x] Add focused tests and documentation of scheduling versus eviction limits.

## Task 3: Pre-eviction alerting

- [x] Use a dedicated monitoring collector of kubelet pod/emptyDir stats and pod limits, with limited read permissions.
- [x] Export session-labelled usage, limits, and measurement health. Never substitute node free space or false zeros.
- [x] Add 70%-of-limit alerts at 15-second evaluation, no long hold, routed to Slack; include usage/limit/session/recovery.
- [x] Test sample parsing and rule evaluation; validate manifests and Terraform formatting.

## Task 4: Review and completion

- [x] Independently review spec compliance and correctness across both repositories.
- [x] Run full make e2e; capture all output and document environment failures.
- [x] Commit each repository change with its spec. Report results and rollout requirements.

## Validation results

- Full `make e2e`: 29 passed, 2 failed, 4 skipped.
- The API bundle started before the parallel web build finished. Its isolated rerun passed after the web build completed.
- The PostgreSQL command-result fixture found an extra entry. The full PostgreSQL suite passed in isolation without code changes.
- Final root typecheck, Kubernetes unit suite, and documentation lint passed after the job-identity review fix.
- Helm golden tests passed. Monitoring validation passed 12 Python tests, 10 PromQL scenarios, and all 10 rendered manifests.
- Skips: opt-in full-stack Kubernetes deployment, Telegram, live GitHub, and 1Password integration.
- Independent reviews approved both changes after the job-identity correction.

Changes remain on isolated local branches. Live deployment and notification delivery are not verified.
See the design's rollout section and the infrastructure exporter README for deployment checks.
