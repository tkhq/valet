# Usage rollups implementation plan

Goal: make dashboard reads scale with daily and hourly groups instead of individual usage entries.

Architecture: transactionally maintained daily and hourly summaries retain source identity and model dimensions.
Current ownership is resolved at read time. Complete days and hours read summaries; partial hours read indexed source rows.
Updates subtract old contributions and add new ones. Deletes subtract contributions.
A resumable repair tracks writes before backfill and publishes readiness only after backfill.

- [x] Add failing regression coverage for hourly totals, updates, deletes, boundaries, and ownership.
- [x] Implement engine and proxy hourly cost, tool, and outcome summaries.
- [x] Implement action and skill summaries without changing distinct-count semantics.
- [x] Route dashboard aggregate queries through complete hours plus exact boundary rows.
- [x] Preserve per-turn export and drill-down detail; optimize aggregate activity queries.
- [x] Test fresh and existing database rollout, interrupted backfill, and concurrent writes.
- [x] Benchmark ten million facts and simultaneous endpoint requests on PostgreSQL.
- [x] Run focused tests, typecheck, full e2e, and independent code review.
- [x] Update the subsystem spec and commit the verified change.

Files: API migration 0000_app.sql and Drizzle metadata define summary tables and triggers.
New usage-rollup migration helpers provide resumable deployed repair.
Usage service helpers provide the exact period relation used by dashboard queries.
Regression tests compare summary queries with raw aggregates across update and ownership transitions.
The benchmark uses a disposable PostgreSQL container and records fixture shape and query latency.


Validation: 111 focused tests passed. Final schema/hourly checks passed 51 tests after the outcome indexes were added.
Typecheck, API bundle, chart golden tests, and documentation lint passed.
The full e2e run passed 26 suites. Its typecheck failure was fixed and passed on rerun.
The PostgreSQL concurrency suite passed in isolation after a timing-sensitive failure in unchanged engine code.
Five live-agent suites remain blocked by exhausted Anthropic credits: orchestrator-smoke, session-smoke, integration-agent, cli, and fullstack-docker.
Full output is preserved in `/tmp/valet-rollups-e2e.log`; targeted rerun logs are in `/tmp/valet-rollup-final-*`.
No production deployment or historical repricing was performed.
