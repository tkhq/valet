# Postgres Backend Design — one dialect everywhere (sub-project A)

**Date:** 2026-07-15
**Status:** Approved for planning
**Scope:** Move the entire v2 stack (`packages/api`, `packages/engine` stores, `packages/workflow` store) from SQLite/better-sqlite3 to a single Postgres dialect. Dev and tests run embedded **PGlite**; k8s/production run real Postgres via `DATABASE_URL`; a future Cloudflare deployment reaches the same stores through Hyperdrive+Neon. SQLite and better-sqlite3 **retire from the repo** at the end of this pass.
**Sequencing:** Sub-project A of the deployment arc. Sub-project B (`docs/specs/2026-07-15-kubernetes-deployment-design.md`) consumes this. Specs are written together; execution is A then B.

## Decisions (locked)

1. **One dialect: Postgres.** No dual sqlite/pg support (evaluated and rejected: Drizzle schemas are dialect-specific, so dual support means a parallel 34-table schema plus dialect-generic service plumbing — a permanent tax on every future change). Cloudflare-via-D1 is deliberately closed in favor of Cloudflare-via-Hyperdrive+Neon, which reuses this pass's stores unchanged.
2. **Dev/test backend: PGlite** (`@electric-sql/pglite`, in-process WASM Postgres). Tests use ephemeral in-memory instances; `make dev-local` uses a data dir under `~/.valet/pg/`. Zero external dependencies preserved.
3. **Task 0 is a durability spike with a defined fallback.** The engine's crash-safety story (SIGKILL mid-write → clean restart, proven on SQLite `synchronous=FULL` in Phase 0) must be re-proven on PGlite: kill -9 a writer process mid-transaction repeatedly, reopen the data dir, assert no corruption and no torn writes surviving as committed state. If PGlite fails, the fallback is: dev (`make dev-local`) uses a dockerized `postgres:17` (Rancher Desktop's daemon is always available) and PGlite remains for unit tests only — or exits entirely if it also proves unstable there. The spike's verdict is recorded in the plan before dependent tasks run.
4. **Driver strategy: one thin query interface, two drivers.** All raw-SQL stores (`store-postgres`, `PgWorkflowStore`, `PgCredentialStore`) are written against a minimal injected interface — `{ query(text, params): Promise<{ rows }>, plus transaction helpers }` — implemented over both `pg.Pool` (node-postgres) and PGlite, which expose compatible `query(text, params)` shapes. Drizzle layers use `drizzle-orm/node-postgres` and `drizzle-orm/pglite` respectively over the same schema. Backend selection at boot: `DATABASE_URL` set → node-postgres Pool; unset → PGlite at `VALET_PG_DATA_DIR` (default `~/.valet/pg/`).
5. **`packages/store-sqlite` → `packages/store-postgres`.** New package implementing `SessionStore` + `EventStream`; correctness pinned by re-running the engine's exported conformance suites (`runSessionStoreContract`, `runEventStreamContract`) plus the restart-safe-gates suite. `store-sqlite` is deleted at the end of the pass (its conformance tests move with the contract, which lives in `packages/engine`).
6. **Fencing/CAS semantics translate as follows.** SQLite `BEGIN IMMEDIATE` + single-statement CAS becomes: single-statement `UPDATE ... WHERE <fence predicate>` (already the dominant pattern — needs only `@named` → `$n` param translation), and the few genuinely multi-statement transactions become explicit `BEGIN`/`COMMIT` with `SELECT ... FOR UPDATE` row locks on the fenced row. The event stream's per-session `seq` (`COALESCE(MAX(seq),0)+1` under IMMEDIATE) becomes `INSERT ... SELECT COALESCE(MAX(seq),0)+1 ... FROM engine_events WHERE session_id=$1` inside a transaction holding `SELECT ... FOR UPDATE` on the session's queue-item row (the same row the fence check reads — one lock, both guarantees). No advisory locks (they don't compose with PGlite's single-connection mode and are unnecessary given row locks).
7. **App schema: regenerate, don't transliterate.** `packages/api/src/schema/index.ts` is rewritten in `pg-core`: `integer timestamp_ms` → `timestamp with time zone` (Drizzle `timestamp(..., { withTimezone: true, mode: "date" })`), boolean-as-integer → `boolean`, JSON-as-text → `jsonb` where the column is read as JSON (messages parts, workflow definitions, features, preferences — enumerate at plan time), `AUTOINCREMENT` → `generated always as identity`, `unixepoch('subsecond')` defaults → `now()`. The better-auth block is **regenerated** via `npx -y @better-auth/cli generate` against `provider: "pg"` and transcribed verbatim (same rule as auth v2). The migration becomes `packages/api/migrations/pg/0000_*.sql`; pre-1.0 edit-in-place policy carries over.
8. **The `AppDb` type flips once.** `AppDb = PgDatabase` alias (the common base of node-postgres and PGlite Drizzle instances — verified at plan time; if no common base types cleanly, `AppDb` aliases the node-postgres type and the PGlite instance satisfies it structurally, with a single documented bridge in the boot path, not per-service casts). Services keep using the query builder per auth-v2 decision 12 — the discipline that makes this flip mechanical. Every `.get()`/`.all()`/`.run()` sqlite-ism in services becomes standard awaited pg equivalents.
9. **Memory search: FTS5 → tsvector, contract-first.** Before porting, the current behavior is pinned as a backend-agnostic contract test (write/patch/remove → search round-trips, owner scoping, expiry filtering, result shape `{ path, title, description, type, rank }`, invalid-query → `ValidationError`). The PG implementation: a `search_vector tsvector` **generated column** on `memory_files` weighting `title` (A), `description` (B), `tags` (C), `path`+`content` (D) — approximating fts5's bm25 column weights (10/8/6/5/1) with PG's four weight classes; GIN index; `websearch_to_tsquery` for query parsing (forgiving of user syntax); `ts_rank_cd` ordering (descending — note bm25 orders ascending; the contract asserts relative ordering of an obvious relevance pair, not absolute scores). The manual rowid-based FTS sync code is **deleted** — generated columns make sync automatic. Ranking parity with bm25 is explicitly NOT a goal; "the obviously-more-relevant doc ranks first" is.
10. **Migration runners generalize.** `applyAppMigrations`/`applyEngineMigrations` become async, take the query interface, track in the same `__valet_*_migrations` tables, and probe `information_schema.tables` instead of `sqlite_master`. The sqlite backfill paths (for pre-tracker dev DBs) are deleted — there are no pg databases predating the tracker. Pragmas (`WAL`, `synchronous`, `busy_timeout`, `foreign_keys`) are deleted; durability is Postgres's job (and the spike's, for PGlite).
11. **Test harness: PGlite in-memory per boot.** `bootTestApi` and the store/workflow test setups construct a fresh in-memory PGlite per test file (matching today's `:memory:` isolation). The engine/store conformance suites additionally run against a real dockerized `postgres:17` in a `make test-pg` target (and CI later) — PGlite for speed, real PG for truth; both must pass. Store contract translation note: better-sqlite3 was synchronous; all store internals become genuinely async — the conformance suites already `await` everything, so they apply unchanged.
12. **What retires:** `packages/store-sqlite` (replaced), `better-sqlite3` + `drizzle-orm` sqlite imports across the repo, the sqlite migration files, the `rm ~/.valet/app.db` dev ritual (becomes `rm -rf ~/.valet/pg`), and the NODE_MODULE_VERSION/`pnpm rebuild better-sqlite3` class of env pain. `@valet/store-sqlite`'s package name is not reused.
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
- New credential-store contract test (extracted from the existing ad-hoc suite so PG and any future impl share it).
- Memory contract test (decision 9) green on pg.
- Full existing fleet: every `packages/api`, `packages/engine`, `packages/web` test green on PGlite with no per-test env changes. The known `messages.abort.test.ts` pair remains allowed.
- `make test-pg`: conformance + api integration against dockerized postgres:17.
- E2E: the auth e2e and workflow kill/restart e2e re-run unchanged (they exercise the stores through real boots).

## Non-goals

- Cloudflare Workers deployment (recorded path: Hyperdrive+Neon; own pass).
- Multi-replica api / horizontal scaling (PG enables it later; the engine singleton is the constraint, not the db).
- Data migration from existing sqlite dev DBs (pre-1.0: discard).
- pgvector / semantic memory search (tsvector only this pass).
- Connection-pool tuning, read replicas, PgBouncer.
