# Postgres Backend Design — one dialect everywhere (sub-project A)

**Date:** 2026-07-15
**Status:** Approved for planning
**Scope:** Move the entire v2 stack (`packages/api`, `packages/engine` stores, `packages/workflow` store) from SQLite/better-sqlite3 to a single Postgres dialect. Dev and tests run embedded **PGlite**; k8s/production run real Postgres via `DATABASE_URL`; a future Cloudflare deployment reaches the same stores through Hyperdrive+Neon. SQLite and better-sqlite3 **retire from the repo** at the end of this pass.
**Sequencing:** Sub-project A of the deployment arc. Sub-project B (`docs/specs/2026-07-15-kubernetes-deployment-design.md`) consumes this. Specs are written together; execution is A then B.

## Decisions (locked)

1. **One dialect: Postgres.** No dual sqlite/pg support (evaluated and rejected: Drizzle schemas are dialect-specific, so dual support means a parallel 34-table schema plus dialect-generic service plumbing — a permanent tax on every future change). Cloudflare-via-D1 is deliberately closed in favor of Cloudflare-via-Hyperdrive+Neon, which reuses this pass's stores unchanged.
2. **Dev/test backend: PGlite** (`@electric-sql/pglite`, in-process WASM Postgres). Tests use ephemeral in-memory instances; `make dev-local` uses a data dir under `~/.valet/pg/`. Zero external dependencies preserved.
3. **Task 0 is a durability spike with a defined fallback.** The engine's crash-safety story (SIGKILL mid-write → clean restart, proven on SQLite `synchronous=FULL` in Phase 0) must be re-proven on PGlite: kill -9 a writer process mid-transaction repeatedly, reopen the data dir, assert no corruption and no torn writes surviving as committed state. If PGlite fails, the fallback is: dev (`make dev-local`) uses a dockerized `postgres:17` (Rancher Desktop's daemon is always available) and PGlite remains for unit tests only — or exits entirely if it also proves unstable there. The spike's verdict is recorded in the plan before dependent tasks run.
4. **Driver strategy: one thin query interface, two drivers — with `transaction(fn)` as a first-class primitive.** All raw-SQL stores (`store-postgres`, `PgWorkflowStore`, `PgCredentialStore`) are written against a minimal injected interface:
   ```ts
   interface PgQueryable {
     query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
   }
   interface PgDb extends PgQueryable {
     transaction<T>(fn: (tx: PgQueryable) => Promise<T>): Promise<T>;
   }
   ```
   `rowCount` is normalized (node-postgres `rowCount`; PGlite `affectedRows` — the drivers disagree, and every CAS check reads it). **`transaction(fn)` has deliberately divergent implementations**: PGlite → its built-in `transaction()` (which serializes against the single connection); node-postgres → `pool.connect()` with every statement in `fn` bound to that one checked-out client. **Routing `BEGIN`/`COMMIT` through the shared `query()` is forbidden** — adversarial review demonstrated it loses updates on PGlite (interleaved async callers share the connection, so `FOR UPDATE` provides no isolation across `query()` calls) and is meaningless on `pg.Pool` (statements land on different pooled connections). Every multi-statement store method runs inside `transaction(fn)`, never as loose `query()` calls. Drizzle layers use `drizzle-orm/node-postgres` and `drizzle-orm/pglite` respectively over the same schema. Backend selection at boot: `DATABASE_URL` set → node-postgres Pool; unset → PGlite at `VALET_PG_DATA_DIR` (default `~/.valet/pg/`).
5. **`packages/store-sqlite` → `packages/store-postgres`.** New package implementing `SessionStore` + `EventStream`; correctness pinned by re-running the engine's exported conformance suites (`runSessionStoreContract`, `runEventStreamContract`) plus the restart-safe-gates suite. `store-sqlite` is deleted at the end of the pass (its conformance tests move with the contract, which lives in `packages/engine`).
6. **Fencing/CAS semantics translate as follows — and this is the hardest part of the pass, not a mechanical one.** SQLite gave every write a whole-database lock (`BEGIN IMMEDIATE`); Postgres gives row-level MVCC, so each pattern is translated deliberately:
   - **True single-statement CAS** (`claimSubmission`, `replaceSubmissionAttempt`, `settleUnclaimed`, `requestAbort`, `renewLeases`): direct translation — `UPDATE ... WHERE <fence predicate>`, `@named` → `$n`, success read from normalized `rowCount`.
   - **Fenced read-then-write transactions** (`appendEntries`, `updateEntry`, `saveSuspendedTurn`, `reserveSettlement`, `finalizeSettlement`, `setSubmissionBlocked`, `admitSubmission`, `forceSettle`, `deleteSession` — the majority, not the exception): run inside `transaction(fn)` (decision 4) with `SELECT ... FOR UPDATE` on the fenced queue-item row before the fence check, so a concurrent `claimSubmission`/`replaceAttempt` serializes against them.
   - **Event-stream `seq` allocation**: SQLite's correctness came from the whole-DB lock; a queue-item row lock does NOT cover it (appends can be fence-less — the admin routes pass no fence — and a session can hold multiple queue items, so two appends could lock different rows and race on `MAX(seq)+1`; the race is masked on single-connection PGlite and fires only on pooled real Postgres). The translation: inside `transaction(fn)`, `SELECT ... FOR UPDATE` on the **`engine_sessions` row** for the session (one row that always exists, per-session serialization independent of queue items), then `INSERT ... SELECT COALESCE(MAX(seq),0)+1`. Belt-and-suspenders: the `(session_id, seq)` PK means a missed serialization surfaces as `23505`, which the append retries once — never silently.
   - No advisory locks (they don't compose with PGlite's single-connection mode and row locks suffice).
   The conformance suites contain **no concurrency tests today** — decision 11 adds one (concurrent same-session appends, fence-less and cross-queue-item) that runs against docker-pg specifically, because PGlite structurally cannot exhibit the race.
7. **App schema: regenerate, don't transliterate — and timestamps convert selectively, not blanket.** `packages/api/src/schema/index.ts` is rewritten in `pg-core`. **Columns that services do numeric millisecond arithmetic on stay integer ms (`bigint`, read as number)** — memory `expires`/`updated_at` (the service's `expiresMs`/`updatedAtMs` contract), every engine-store time field (`timeout_at`, `lease_expires_at`, `created_at`, `updated_at`, event `timestamp` — the conformance suites assert numeric ms round-trips), and any app column compared against `Date.now()`. Only columns consumed as `Date` become `timestamp with time zone` — chiefly the regenerated better-auth block, whose shapes come from the CLI, not from us. Per-column disposition is enumerated in the plan. Boolean-as-integer → `boolean`, JSON-as-text → `jsonb` where the column is read as JSON (messages parts, workflow definitions, features, preferences — enumerate at plan time), `AUTOINCREMENT` → `generated always as identity`, `unixepoch('subsecond')` defaults → `now()` (better-auth block) / caller-supplied ms (everything else, as today). The better-auth block is **regenerated** via `npx -y @better-auth/cli generate` against `provider: "pg"` and transcribed verbatim (same rule as auth v2). The migration becomes `packages/api/migrations/pg/0000_*.sql`; pre-1.0 edit-in-place policy carries over.
8. **The `AppDb` type flips once.** `AppDb` aliases drizzle's `PgDatabase` common base (verified by adversarial review: both `drizzle-orm/node-postgres` and `drizzle-orm/pglite` instances are assignable to it in 0.45.2). The alias must use concrete schema-typed generic parameters — `PgDatabase<any, any, any>` would violate the no-`any` rule; if the query-result generic can't be named cleanly, `AppDb` aliases the node-postgres instance type with the PGlite instance bridged once in the boot path (documented), never per-service casts. Services keep using the query builder per auth-v2 decision 12 — the discipline that makes this flip mechanical. Every `.get()`/`.all()`/`.run()` sqlite-ism in services becomes standard awaited pg equivalents.
9. **Memory search: FTS5 → tsvector, contract-first.** Before porting, the current behavior is pinned as a backend-agnostic contract test (write/patch/remove → search round-trips, owner scoping, expiry filtering, result shape `{ path, title, description, type, rank }`, invalid-query → `ValidationError`). The PG implementation: a `search_vector tsvector` **generated column** on `memory_files` weighting `title` (A), `description` (B), `path`+`tags` (C), `content` (D) — fts5's bm25 weights were title 10, description 8, tags 6, **path 5**, content 1; path must NOT collapse into the lowest class with content or a path-term match ranks like a body mention (adversarial-review catch). GIN index; `websearch_to_tsquery` for query parsing (forgiving of user syntax); `ts_rank_cd` ordering (descending — note bm25 orders ascending; the contract asserts relative ordering of obvious relevance pairs — title-vs-content AND path-vs-content — not absolute scores). The manual rowid-based FTS sync code is **deleted** — generated columns make sync automatic. Ranking parity with bm25 is explicitly NOT a goal; "the obviously-more-relevant doc ranks first" is.
10. **Migration runners generalize.** `applyAppMigrations`/`applyEngineMigrations` become async, take the query interface, track in the same `__valet_*_migrations` tables, and probe `information_schema.tables` instead of `sqlite_master`. The sqlite backfill paths (for pre-tracker dev DBs) are deleted — there are no pg databases predating the tracker. Pragmas (`WAL`, `synchronous`, `busy_timeout`, `foreign_keys`) are deleted; durability is Postgres's job (and the spike's, for PGlite).
11. **Test harness: PGlite in-memory per boot.** `bootTestApi` and the store/workflow test setups construct a fresh in-memory PGlite per test file (matching today's `:memory:` isolation). The engine/store conformance suites additionally run against a real dockerized `postgres:17` in a `make test-pg` target (and CI later) — PGlite for speed, real PG for truth; both must pass. Store contract translation note: better-sqlite3 was synchronous; all store internals become genuinely async — the conformance suites already `await` everything, so they apply unchanged.
12. **What retires — full ripple, enumerated (adversarial-review catch: this is wider than the architecture list).** `packages/store-sqlite` (replaced) — including **`packages/engine`'s own workspace dependency on it**: the engine's kill/durability tests (`test/kill-child.ts`, `kill-mid-turn.ts`, `kill-mid-gate.ts`, `kill-gate-child.ts`, `await-result.test.ts`) boot real sqlite stores and must port to `store-postgres`+PGlite. `better-sqlite3` + drizzle sqlite imports across the repo. `services/teams.ts`'s `SqliteError` unique-violation check (→ `isPgUniqueViolation`). **~21 test files** that construct `new Database(":memory:")` or inline sqlite directly (`auth/*.test.ts`, `plugins/*.test.ts`, `services/*.test.ts`, `schema/*.test.ts`, `workflows/sqlite-store.test.ts`, `integration/_setup.ts`, the engine kill tests) — each rewritten onto a shared PGlite test-db helper. The sqlite migration files. The `rm ~/.valet/app.db` dev ritual (becomes `rm -rf ~/.valet/pg`) and the NODE_MODULE_VERSION/`pnpm rebuild better-sqlite3` class of env pain. **CLAUDE.md sections that document sqlite mechanics** (the `sqlite3 ~/.valet/app.db` inspection tip, the better-sqlite3 rebuild advice, the migration-policy wording) update in the same pass. `@valet/store-sqlite`'s package name is not reused. This is a multi-week pass; the store rewrites are conformance-pinned but the fencing translation (decision 6), per-column timestamp audit (decision 7), and test-harness cascade are genuine design-and-verify work, not transcription.
13. **Cloudflare note (non-goal, recorded):** a future Workers deployment uses these exact stores over Neon through Hyperdrive (node-postgres works on Workers with `nodejs_compat`). No CF code ships in this pass.

## Architecture

```
packages/store-postgres/          # NEW — replaces store-sqlite
├── src/db.ts                     # PgQueryable interface + pool/pglite constructors
├── src/store.ts                  # PgSessionStore (SessionStore)
├── src/event-stream.ts           # PgEventStream (EventStream, fenced appendOnce)
├── src/migrate.ts                # applyEngineMigrations (async, information_schema)
├── migrations/pg/0000_*.sql      # engine tables, pg dialect
└── test/                         # conformance suites vs PGlite + docker-pg

packages/api/
├── src/schema/index.ts           # rewritten in pg-core (34 tables + regenerated better-auth block)
├── migrations/pg/0000_*.sql      # app tables incl. tsvector generated column + GIN index
├── src/lib/drizzle.ts            # AppDb = pg Drizzle type; async applyAppMigrations
├── src/providers/node.ts         # buildNodeProviders: DATABASE_URL ? Pool : PGlite(dataDir)
├── src/workflows/pg-store.ts     # PgWorkflowStore (replaces sqlite-store.ts)
├── src/plugins/credential-store.ts  # PgCredentialStore (same AES-GCM crypto, pg upserts)
└── src/services/memory.ts        # tsvector search; manual FTS sync deleted
```

Boot: `buildNodeProviders` constructs ONE connection source (Pool or PGlite), runs both migration sets against it (engine + app tables coexist in one database, same as the one-sqlite-file design), and hands the query interface + Drizzle instance to the four stores and all services. PGlite is single-connection: the api is a single process and the Pool path covers anything concurrent, so this is acceptable by design — but the spike must confirm the engine's concurrent-ish access patterns (event stream appends during store writes) behave on PGlite.

## Error mapping

`SqliteError` handling (memory search's invalid-query path; any unique-violation checks) maps to pg error codes: `23505` unique_violation, `42601`/`42804` for query syntax where surfaced. A small `isPgUniqueViolation(err)` helper in the query-interface module; no better-sqlite3 error types survive.

## Testing

- Task 0 spike: SIGKILL durability harness (spawn writer child, kill at random offsets, reopen, invariant checks) — pass/fail gate recorded before dependent work.
- Conformance: `runSessionStoreContract` + `runEventStreamContract` + restart-safe-gates against PgSessionStore/PgEventStream (PGlite AND docker-pg); `describeCheckpointContract`/`describeSignalContract`/`describeOwnershipContract`/`describeRunHostContract` against PgWorkflowStore (both backends).
- **NEW concurrency contract tests (docker-pg only — PGlite's single connection structurally masks these races):** N concurrent same-session event appends (fence-less and across distinct queue items) produce gapless unique seqs; concurrent fenced writes vs claim/replaceAttempt preserve fencing. These are additions to the engine's exported suites so future backends inherit them.
- New credential-store contract test (extracted from the existing ad-hoc suite so PG and any future impl share it).
- Memory contract test (decision 9) green on pg.
- Full existing fleet: every `packages/api`, `packages/engine`, `packages/web` test green on PGlite with no environment variables required (the ~21 sqlite-constructing test files are rewritten onto the shared PGlite helper — decision 12). The known `messages.abort.test.ts` pair remains allowed.
- `make test-pg`: conformance + api integration against dockerized postgres:17.
- E2E: the auth e2e and workflow kill/restart e2e re-run unchanged (they exercise the stores through real boots).

## Non-goals

- Cloudflare Workers deployment (recorded path: Hyperdrive+Neon; own pass).
- Multi-replica api / horizontal scaling (PG enables it later; the engine singleton is the constraint, not the db).
- Data migration from existing sqlite dev DBs (pre-1.0: discard).
- pgvector / semantic memory search (tsvector only this pass).
- Connection-pool tuning, read replicas, PgBouncer.
