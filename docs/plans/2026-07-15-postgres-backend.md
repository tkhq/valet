# Postgres Backend Implementation Plan (sub-project A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Postgres dialect everywhere per `docs/specs/2026-07-15-postgres-backend-design.md` — PGlite for dev/tests, real PG via `DATABASE_URL`; SQLite/better-sqlite3 retire in the final task.

**Architecture:** Additive first (new `packages/store-postgres` + pg impls + pg schema, repo stays green on sqlite), then an atomic cutover wave (boot + test harness + test files), then deletion. The spec is normative — every task brief inherits its numbered decisions.

**Tech Stack:** `@electric-sql/pglite` (^0.5.4), `pg` (^8.x), `drizzle-orm/node-postgres` + `drizzle-orm/pglite` (0.45.2), existing conformance suites.

## Global Constraints

- **Spec is normative:** `docs/specs/2026-07-15-postgres-backend-design.md`. Plan/spec conflict → STOP and report.
- Node 22 prefix on every bash call: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && `.
- **`transaction(fn)` primitive only** — routing `BEGIN`/`COMMIT` through shared `query()` is forbidden (spec decision 4; it demonstrably loses updates on PGlite and cannot transact on pg.Pool).
- Thin interface returns normalized `{ rows, rowCount }` (PGlite `affectedRows` → `rowCount`).
- **ms-epoch columns stay integer/bigint-as-number** wherever services/stores do numeric time arithmetic (spec decision 7). Only Date-consumed columns become timestamptz.
- No `any` / `as unknown as` / `@ts-ignore`. Drizzle query builder in app services; raw SQL allowed only inside the store implementations and migrations (matching today's layering).
- Pre-1.0: pg migrations are single `0000` files, edited in place. Dev reset: `rm -rf ~/.valet/pg`.
- Repo must be GREEN after every task (the additive phase keeps sqlite as boot default until the cutover task).
- Known-allowed failures: the 2 pre-existing `messages.abort.test.ts` failures. Memory tests may flake ~14s under full-suite load — re-run in isolation to confirm.
- Root `pnpm typecheck` does NOT cover `packages/web` — run `cd packages/web && pnpm typecheck` too when web is touched.
- Commits per task, terse, no AI trailers.

---

### Task 0: PGlite durability spike (GATE)

**Files:** Create `packages/store-postgres/experiments/durability-spike.ts` + `FINDINGS-pglite-durability.md` (package scaffold minimal: package.json, tsconfig — full scaffold in Task 1).

Port the Phase-0 fencing-spike shape: a child process opens PGlite on a data dir and loops committed inserts of `(seq, checksum)` rows; the parent SIGKILLs it at randomized delays, reopens the data dir, and asserts (a) DB opens, (b) every committed row readable + checksums valid, (c) max committed seq matches the child's last fsync-acknowledged write (child appends acknowledged seqs to a plain log file after each commit resolves). ≥50 kill cycles. Investigate PGlite's fsync/durability options (`dataDir` mode, any `relaxedDurability` flag — read the installed package's docs/types) and run with the DURABLE configuration.

- [ ] Write + run the spike; record pass/fail and the exact PGlite config in FINDINGS.
- [ ] **Verdict gate:** PASS → proceed with PGlite-for-dev as specced. FAIL → record in FINDINGS, amend spec decision 2/3 fallback (dev = dockerized postgres:17; PGlite only where it passed, or nowhere), and adjust Task 7's boot logic accordingly. Either way the plan continues — this task exists to make the choice evidence-based.
- [ ] Commit: `spike(store-postgres): pglite SIGKILL durability findings`

### Task 1: `packages/store-postgres` scaffold — PgDb interface + two drivers

**Files:** Create `packages/store-postgres/{package.json,tsconfig.json,src/db.ts,src/index.ts,test/db.test.ts}`; root tsconfig references; workspace deps (`@electric-sql/pglite`, `pg`, `@valet/engine`).

**Interfaces (produces — everything later consumes these):**
```ts
export interface PgQueryable { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>; }
export interface PgDb extends PgQueryable {
  transaction<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function pgDbFromPool(pool: pg.Pool): PgDb;          // transaction: pool.connect() + client-bound fn + release
export function pgDbFromPglite(p: PGlite): PgDb;            // transaction: pglite.transaction(fn)
export function isPgUniqueViolation(err: unknown): boolean; // code 23505
```

- [ ] Failing tests FIRST, including the **lost-update regression**: two concurrent `transaction(fn)` blocks doing read-increment-write on one row must serialize (final value 2) on PGlite; a `BEGIN` issued through raw `query()` is rejected by the implementation (throw with message naming `transaction(fn)`). rowCount normalization asserted for INSERT/UPDATE/DELETE on both drivers (pg.Pool tests skip when no `TEST_DATABASE_URL`; PGlite always).
- [ ] Implement; tests green; commit: `feat(store-postgres): PgDb interface with serializing transaction primitive`

### Task 2: Engine pg migrations + async migration runner

**Files:** Create `packages/store-postgres/migrations/pg/0000_engine.sql`, `src/migrate.ts` (+ test).

Translate `packages/store-sqlite/migrations/sqlite/0000_lonely_lizard.sql`: 10 `engine_*` tables, integer-ms columns become `bigint`, text/JSON stay `text`, PKs/indexes preserved (notably `engine_events` PK `(session_id, seq)`). `applyEngineMigrations(db: PgDb)`: async, `information_schema.tables` probe, `__valet_engine_migrations` tracker, per-file transaction, `assertSchemaVersion` (ENGINE_SCHEMA_VERSION "2") — no sqlite backfill path, no pragmas.

- [ ] Failing test: fresh PGlite → migrate → all 10 tables + meta row exist; idempotent re-run.
- [ ] Implement; green; commit: `feat(store-postgres): engine pg migrations + async runner`

### Task 3: PgSessionStore

**Files:** Create `src/store.ts`, `test/pg-store.test.ts`.

Port `SqliteSessionStore` (packages/store-sqlite/src/store.ts) onto `PgDb` per spec decision 6's three-bucket translation: single-statement CAS (`claimSubmission`, `replaceSubmissionAttempt`, `settleUnclaimed`, `requestAbort`, `renewLeases`) as direct `$n` UPDATEs reading `rowCount`; every fenced read-then-write (`appendEntries`, `updateEntry`, `saveSuspendedTurn`, `reserveSettlement`, `finalizeSettlement`, `setSubmissionBlocked`, `admitSubmission`, `forceSettle`, `deleteSession`) inside `transaction(fn)` with `SELECT ... FOR UPDATE` on the fenced queue-item row before the fence check. Timestamps remain ms numbers (bigint columns read back as numbers — set pg `types` parser or cast in SQL: verify `bigint → number` handling explicitly, don't let strings leak).

- [ ] Run `runSessionStoreContract` (from `@valet/engine` test-helpers) against PGlite → green.
- [ ] Same suite against docker-pg (skip-if-unreachable guard, `make test-pg` target added here: `docker run --rm -d -p 5433:5432 postgres:17` helper or testcontainer-style script).
- [ ] Commit: `feat(store-postgres): PgSessionStore passing session-store contract`

### Task 4: PgEventStream — with the seq-serialization design

**Files:** Create `src/event-stream.ts`, `test/pg-event-stream.test.ts`.

Port `SqliteEventStream` per spec decision 6's event-stream bullet exactly: append runs in `transaction(fn)` → `SELECT id FROM engine_sessions WHERE id=$1 FOR UPDATE` (per-session serialization independent of queue items) → fence check against `engine_queue_items.attempt_id` when a fence is supplied (throw `StaleAttemptError`) → appendOnce dedup select on `(session_id, event_key)` → `INSERT ... SELECT COALESCE(MAX(seq),0)+1`. On `23505` (PK `(session_id, seq)`): retry the whole transaction once; second failure propagates. Prune batches sized for pg param limits.

- [ ] `runEventStreamContract` + restart-safe-gates suite green on PGlite AND docker-pg.
- [ ] Commit: `feat(store-postgres): PgEventStream with per-session seq serialization`

### Task 5: Concurrency contract tests (docker-pg)

**Files:** Modify `packages/engine/src/test-helpers/event-stream-contract.ts` (+ store contract if applicable), `packages/store-postgres/test/concurrency.pg.test.ts`.

Add to the ENGINE's exported suites (so all backends inherit): (a) N=25 concurrent same-session appends — no fence — yield gapless unique seqs 1..25; (b) concurrent appends fenced on two different queue items of one session likewise; (c) concurrent fenced `updateEntry` vs `replaceSubmissionAttempt` preserves fencing (stale writer gets `StaleAttemptError`, no partial write). Suites accept a `supportsConcurrency` flag: sqlite (synchronous driver) and PGlite (single connection) run them trivially/skip; docker-pg runs them for real. This is the regression net for spec decision 6.

- [ ] Tests exist, run green vs docker-pg via `make test-pg`; existing sqlite store still green (flag-gated). Commit: `test(engine,store-postgres): concurrency contracts for seq + fencing`

### Task 6: App pg schema + better-auth regeneration + app migrations

**Files:** Create `packages/api/src/schema/index.pg.ts` (becomes `index.ts` at cutover — author complete now, swap in Task 7), `packages/api/migrations/pg/0000_app.sql`. Modify `packages/api/src/lib/drizzle.ts` (add pg variants alongside sqlite for one task's lifetime).

Rewrite all ~34 tables in `pg-core` per spec decision 7's per-column disposition (produce the disposition table in the task report: every timestamp column → `bigint`-ms or `timestamptz`, every text-JSON → `text` or `jsonb`). Regenerate the better-auth block: `npx -y @better-auth/cli generate` against a pg-provider config, transcribe verbatim. `workflow_signals` id → `generated always as identity`. Memory tables carry the `search_vector tsvector` **generated column** (weights per spec decision 9: A=title, B=description, C=path+tags, D=content) + GIN index — defined in raw migration SQL (drizzle pg-core can't express it; schema file documents it like the sqlite fts comment did). Async `applyAppMigrations(db: PgDb)` mirrors Task 2.

- [ ] Test: fresh PGlite → app migrations apply → spot-check tables incl. tsvector column + a `websearch_to_tsquery` round-trip; better-auth block boots (reuse the Task-6-auth-style instance smoke test pointed at pg schema).
- [ ] Repo still green on sqlite (nothing imports the pg schema yet). Commit: `feat(api): pg app schema, regenerated better-auth block, pg migrations`

### Task 7: THE CUTOVER — boot, test harness, AppDb flip

**Files:** Modify `packages/api/src/providers/node.ts`, `src/lib/drizzle.ts` (AppDb → pg type per spec decision 8), `src/integration/_setup.ts`, `packages/api/src/schema/index.ts` (pg version swapped in; sqlite schema deleted), Create `packages/api/src/test-helpers/pg-test-db.ts` (shared PGlite helper: fresh in-memory instance + both migration sets + returns `{ pgdb, appDb, cleanup }`).

`buildNodeProviders`: `DATABASE_URL` → `pgDbFromPool`; else PGlite at `VALET_PG_DATA_DIR` (default `~/.valet/pg/`) — honoring Task 0's verdict. Both drizzle instances (`drizzle-orm/node-postgres` / `drizzle-orm/pglite`) over the same connection source; stores swap to `PgSessionStore`/`PgEventStream` (workflow/credential stores flip in Tasks 8-9 within this same wave — see ordering note). `bootTestApi` uses the shared helper.

**Ordering note for the controller:** Tasks 7–11 are one cutover wave; the repo compiles but the FULL suite is only required green again at the end of Task 10. Each task still runs its own scoped tests green.

- [ ] Boot smoke: stub-mode dev boot on PGlite; api integration `_setup`-based suites compiling and the auth e2e green on PGlite.
- [ ] Commit: `feat(api): boot cutover to postgres — DATABASE_URL pool or PGlite`

### Task 8: PgWorkflowStore + PgCredentialStore + error mapping

**Files:** Create `packages/api/src/workflows/pg-store.ts` (delete `sqlite-store.ts`), rewrite `packages/api/src/plugins/credential-store.ts` as `PgCredentialStore`; extract a credential-store contract test (`packages/api/src/plugins/credential-store-contract.ts`) from the existing suite; fix `services/teams.ts` `SqliteError` → `isPgUniqueViolation`.

PgWorkflowStore: port CAS transitions into `transaction(fn)` + `FOR UPDATE` on the run row; `ON CONFLICT ... DO UPDATE` targets verified against pg syntax. All four workflow conformance suites (`describeCheckpointContract`, `describeSignalContract`, `describeOwnershipContract`, `describeRunHostContract`) green on PGlite + docker-pg. Credential store keeps AES-GCM crypto byte-identical (existing ciphertexts irrelevant — fresh dbs — but the format stays `v1:{iv}:{tag}:{ct}`).

- [ ] Suites green; commit: `feat(api): pg workflow + credential stores, pg error mapping`

### Task 9: Memory service port — tsvector search

**Files:** Modify `packages/api/src/services/memory.ts` (+ its tests). Create `packages/api/src/services/memory-search-contract.ts` if extraction is cleaner.

Pin the contract FIRST (from the existing sqlite tests' behavior — they're in git history if needed): round-trips, owner scoping incl. `team:{id}/` virtual prefixes, expiry (`expires > Date.now()` numeric), result shape with `rank`, invalid-query → `ValidationError`, relative-ordering pairs (title-vs-content AND path-vs-content). Then: delete the manual rowid FTS sync entirely; `searchFiles` becomes `websearch_to_tsquery` + `ts_rank_cd DESC` joined against the generated column; invalid-query mapping via pg error codes. `updatedAtMs`/`expiresMs` stay numbers (bigint columns).

- [ ] Contract green on PGlite; memory-routes integration green. Commit: `feat(api): memory search on tsvector, manual FTS sync deleted`

### Task 10: Test-fleet port — the ~21 direct-sqlite test files + engine kill tests

**Files:** Every test file constructing `new Database(...)` (enumerate by grep at task time; spec decision 12 lists the clusters: `auth/*.test.ts`, `plugins/*.test.ts`, `services/*.test.ts`, `schema/*.test.ts`, workflows, `_setup.ts` already done) → the shared `pg-test-db` helper. `packages/engine/package.json` dep flips `@valet/store-sqlite` → `@valet/store-postgres`; the 5 engine kill/durability tests (`test/kill-*.ts`, `await-result.test.ts`) boot PGlite-backed stores (file-based data dir — they kill processes, so in-memory won't do; reuse Task 0's spike learnings).

- [ ] **FULL fleet green**: api, engine, workflow, web (unchanged but run it), + `make test-pg` conformance. Only the 2 known `messages.abort` failures allowed.
- [ ] Commit: `test: fleet on PGlite; engine kill tests on store-postgres`

### Task 11: Delete sqlite + docs + final gates

**Files:** Delete `packages/store-sqlite/` (root tsconfig + workspace refs), remove `better-sqlite3` + sqlite drizzle imports repo-wide (`grep` sweep must come back empty outside git history), delete sqlite migration files. Update CLAUDE.md (sqlite3 inspection tip → psql/PGlite equivalent; better-sqlite3 rebuild advice removed; migration policy wording → pg paths; dev reset → `rm -rf ~/.valet/pg`). Update spec status → Implemented. Update `valet_test_env_quirks` guidance implications in CLAUDE.md text only (memory file is the controller's job).

- [ ] Gates: full fleet + typechecks (root AND packages/web) + `make test-pg` + a real-boot smoke (stub-mode PGlite boot: signup→/api/me; and if `TEST_DATABASE_URL` available, the same against docker-pg).
- [ ] Commit: `feat!: retire sqlite — postgres everywhere`

## Self-Review

- Spec coverage: decisions 1-13 → Tasks: spike (0), interface/transaction (1), engine store/stream/fencing (2-5), schema/better-auth/timestamps (6), boot/AppDb (7), workflow/credential/error-map (8), FTS (9), ripple/tests (10), retirement/docs (11). Concurrency tests (spec Testing) → Task 5. Cloudflare/Hyperdrive → non-goal, no task (correct).
- Ordering hazard acknowledged in Task 7's note: 7-10 are one wave; green-repo invariant is per-scoped-tests during the wave, full-fleet at wave end (Task 10) — the controller enforces this explicitly in briefs.
- Types: `PgDb`/`PgQueryable` (Task 1) consumed by 2,3,4,8; `pg-test-db` helper (7) consumed by 9,10.
