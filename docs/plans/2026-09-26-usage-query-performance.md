# Usage query performance implementation plan

Goal: remove transcript parsing and unbounded joins from usage page reads.

Architecture: a database-maintained, per-entry fact table stores compact usage and settled tool counts.
Insert/update triggers keep facts in the same transaction as the source entry. Deletes cascade.
A resumable schema repair installs tracking, builds indexes concurrently, and backfills entries in small batches.
It publishes the new views after the backfill completes.
Read-time session/workflow ownership preserves current access semantics.

- [x] Test projection updates, deletes, NUL escapes, and existing-database backfill.
- [x] Route cost, tool-efficiency, and terminal outcomes through indexed facts.
- [x] Add effective action-time and skill-context-time indexes.
- [x] Split skill invocation/context aggregates into bounded time scans.
- [x] Limit outcome cost aggregation to parents with confirmed outcomes.
- [x] Compare before/after results and timings on a disposable synthetic database.
- [x] Run route/schema tests, typecheck, and the full e2e scorecard.
- [x] Document rollout locking and benchmark limits; review and commit.

Validation: 90 focused tests passed. Typecheck and documentation lint passed.
The full e2e run passed 32 suites and skipped four optional suites.
The live-agent suite had one aborted request, then passed in isolation.
Review found no remaining blocking issues.
