# TKAI-427 implementation plan

The user approved selected home persistence on the existing volume and an awaited resume restoration hook.

## Requirements

- Keep `/workspace` and existing repository files in place.
- Persist selected home configuration, caches, and toolchains for root and workload users on the same per-sandbox volume.
- Seed defaults without overwriting persisted user changes. Keep transient Docker data and credential rotation separate.
- Provide ordered, awaited `afterResume` restoration before readiness or tool release.
- Restore credential helpers and managed Git configuration. Preserve uncommitted files and unpushed commits.
- Required restoration failure must fail readiness. Handle cancellation and concurrent waiters.
- Adopt existing volumes without changing visible repository paths or deleting claims.

## Tasks

- [x] Add resume regression tests, lifecycle hook, and credential restoration wiring.
- [x] Add home persistence tests and provider preparation using the existing volume.
- [x] Update lifecycle specs and review both requirements and code quality.
- [x] Run focused tests and full `make e2e`; record environmental failures.
- Delivery: commit the scoped changes and open a PR against `dev-v2` referencing TKAI-427.

## Validation

The full `make e2e` run completed with 29 passing suites, two failing suites, and four expected skips.
Final Kubernetes rerun passed all 459 tests after startup and resume-conflict fixes.
Root unit and Postgres reruns passed after intermittent webhook setup and deadlock failures.
Final typechecks, engine tests, conventions, and docs lint passed.
The live pod-cycle test preserved home files, cache ownership, repository files, and claim identity.
