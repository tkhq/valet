/**
 * Application Drizzle handle, backed by either `drizzle-orm/node-postgres`
 * or `drizzle-orm/pglite` — both are structurally assignable to
 * `PgDatabase<PgQueryResultHKT, typeof schema>` in the installed
 * drizzle-orm 0.45.2 (their `NodePgQueryResultHKT`/`PgliteQueryResultHKT`
 * both extend the shared `PgQueryResultHKT`), so `AppDb` uses the real
 * common base rather than `PgDatabase<any, any, any>` (forbidden by the
 * no-`any` rule — decision 8 of docs/specs/2026-07-15-postgres-backend-design.md).
 *
 * Mirrors `packages/store-postgres/src/migrate.ts`'s conventions
 * (`information_schema` probe, `__valet_*_migrations` tracker, one
 * transaction per migration file, `import.meta.url` dir resolution): async
 * throughout, `--> statement-breakpoint`-delimited multi-statement files, no
 * sqlite-style backfill path (decision 10: no pg database predates the
 * tracker).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { applyEngineMigrations, isPgLockTimeout, pgDbFromPglite, pgDbFromPool, type PgDb } from "@valet/store-postgres";
import { readFileSync } from "node:fs";
import * as schema from "../schema/index.js";

/** Application Drizzle handle. The engine's session store has its own
 * Drizzle handle over the same connection source — both reach the same
 * pg database. */
export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * The transaction handle Drizzle's pg drivers pass to
 * `db.transaction(tx => ...)` callbacks. Derived from `AppDb["transaction"]`
 * (rather than importing internal driver-specific transaction class names)
 * so services that need to run reads + writes atomically can type their
 * helpers to accept either `AppDb` or this transaction handle without a
 * type assertion.
 */
export type AppTx = Parameters<AppDb["transaction"]>[0] extends (tx: infer T) => unknown ? T : never;

/** Either a top-level `AppDb` handle or an in-flight transaction on one. */
export type AppQueryable = AppDb | AppTx;

/**
 * Builds the app Drizzle instance over either connection source. `source`
 * is the raw driver object (a `pg.Pool` or an `@electric-sql/pglite`
 * `PGlite` instance) — NOT the `PgDb` query wrapper, since each drizzle
 * driver needs its own native client, not the normalized `PgQueryable`
 * surface `PgDb` exposes (`buildAppQueryable` below wraps the SAME
 * underlying object separately, for the raw-SQL stores that share a
 * connection source with this Drizzle instance).
 */
export function buildAppDb(source: Pool | PGlite): AppDb {
  if (source instanceof PGlite) {
    return drizzlePglite(source, { schema, casing: "snake_case" });
  }
  return drizzleNodePg(source, { schema, casing: "snake_case" });
}

/** Wraps a raw connection source in the shared `PgDb` query interface
 * (decision 4) — the same source `buildAppDb` above builds a Drizzle
 * instance over, so raw-SQL call sites (migrations, the memory service's
 * tsvector queries) and Drizzle call sites share one physical connection. */
export function buildAppQueryable(source: Pool | PGlite): PgDb {
  return source instanceof PGlite ? pgDbFromPglite(source) : pgDbFromPool(source);
}

/**
 * The one pre-1.0 app migration. CLAUDE.md rule: we edit `0000` in place,
 * never add `0001`/`0002`, so this is an explicit single-file read rather than
 * a directory scan. Read via `new URL(..., import.meta.url)` so the asset
 * resolves relative to this module (the seam a later bundling step relies on).
 */
const APP_MIGRATION_FILES = ["0000_app.sql"] as const;

const migrationSql: Record<(typeof APP_MIGRATION_FILES)[number], () => string> = {
  "0000_app.sql": () =>
    readFileSync(new URL("../../migrations/pg/0000_app.sql", import.meta.url), "utf8"),
};

/**
 * Apply this package's postgres migrations to an open `PgDb`.
 *
 * Tracks applied migrations in `__valet_app_migrations` (filename + timestamp)
 * so re-runs across server restarts are no-ops. Each migration runs in a
 * transaction — partial application leaves the tracker untouched.
 *
 * The app schema now spans both migration sets: the `cost_entries` view reads
 * `engine_entries` (engine schema) alongside `agent_sessions`/`workflow_runs`/
 * `workflow_definitions`. So this function applies the engine schema FIRST.
 * `applyEngineMigrations` is idempotent and tracks itself separately, so a
 * caller that also applies it explicitly (`providers/node.ts`) is unaffected.
 * The dependency only runs this way: the engine schema never reads app tables.
 */
export async function applyAppMigrations(db: PgDb): Promise<void> {
  await applyEngineMigrations(db);

  await db.query(`
    CREATE TABLE IF NOT EXISTS __valet_app_migrations (
      filename text PRIMARY KEY,
      applied_at bigint NOT NULL
    )
  `);

  for (const file of APP_MIGRATION_FILES) {
    const applied = await db.query("SELECT 1 FROM __valet_app_migrations WHERE filename = $1", [file]);
    if (applied.rows.length > 0) continue;

    const sql = migrationSql[file]();
    const statements = sql
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    await db.transaction(async (tx) => {
      for (const stmt of statements) {
        await tx.query(stmt);
      }
      await tx.query("INSERT INTO __valet_app_migrations (filename, applied_at) VALUES ($1, $2)", [
        file,
        Date.now(),
      ]);
    });
  }

  await addColumnsMissingFromAppliedMigrations(db);
}

/**
 * One schema element that a pre-1.0 in-place edit added to an
 * ALREADY-APPLIED `0000_app.sql`, plus the catalog probe that tells whether
 * this database still lacks it. The probe is the point (TKAI-244): a no-op
 * `ALTER TABLE ... IF NOT EXISTS` still takes an ACCESS EXCLUSIVE lock, and
 * during a rolling update that lock queues behind the old api pod's open
 * transactions — the new pod hangs, the queued lock blocks the old pod's
 * reads, and the deploy deadlocks. Probing the catalog first means a boot
 * where nothing is missing issues no DDL at all.
 */
interface SchemaRepair {
  /** Names the element in logs and errors, e.g. "orgs.sso_team_groups column". */
  describe: string;
  probe:
    | { kind: "column"; table: string; column: string }
    | { kind: "table"; table: string }
    | { kind: "index"; index: string };
  sql: string;
}

/**
 * The pre-1.0 in-place-edit repair list. Add an entry when an edit to
 * `0000_app.sql` adds a NULLABLE (or DEFAULT-backfilled) column, a table,
 * or an index; a column that needs a computed value cannot be repaired this
 * way and does need a real migration. Keep each `sql` in lockstep with
 * `0000_app.sql`. Delete this list at 1.0, when numbered migrations take
 * over.
 */
const SCHEMA_REPAIRS: SchemaRepair[] = [
  {
    // Records which person's GitHub credential a team skill source may use.
    // Null on every row written before the column existed, which the sync
    // reads as "no credential" rather than climbing to the org's App.
    describe: "skill_sources.created_by column",
    probe: { kind: "column", table: "skill_sources", column: "created_by" },
    sql: 'ALTER TABLE "skill_sources" ADD COLUMN IF NOT EXISTS "created_by" text',
  },
  {
    // The per-group team-sync allowlist. Null on every row written before
    // the column existed, which the sync and Settings read as "never set" —
    // fail-closed, same as an empty list.
    describe: "orgs.sso_team_groups column",
    probe: { kind: "column", table: "orgs", column: "sso_team_groups" },
    sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "sso_team_groups" jsonb',
  },
  {
    // Artifact-sharing opt-in (artifacts design). The DEFAULT backfills
    // every pre-existing org row to `false` — anonymous sharing stays off
    // until an admin opts in, the same answer a fresh database gets.
    describe: "orgs.allow_public_artifacts column",
    probe: { kind: "column", table: "orgs", column: "allow_public_artifacts" },
    sql: 'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "allow_public_artifacts" boolean NOT NULL DEFAULT false',
  },
  {
    // The artifacts table itself (artifacts design) — a whole-table sibling
    // of the column repairs, for the same reason.
    describe: "artifacts table",
    probe: { kind: "table", table: "artifacts" },
    sql: `CREATE TABLE IF NOT EXISTS "artifacts" (
      "id" text PRIMARY KEY NOT NULL,
      "token" text NOT NULL,
      "owner_type" text NOT NULL,
      "owner_id" text NOT NULL,
      "org_id" text NOT NULL,
      "actor_user_id" text NOT NULL,
      "source_session_id" text DEFAULT '' NOT NULL,
      "source_memory_path" text NOT NULL,
      "title" text DEFAULT '' NOT NULL,
      "content" text NOT NULL,
      "visibility" text DEFAULT 'org' NOT NULL,
      "public_by" text,
      "created_at" bigint NOT NULL,
      "updated_at" bigint NOT NULL,
      "revoked_at" bigint
    )`,
  },
  {
    describe: "artifacts_token_unique index",
    probe: { kind: "index", index: "artifacts_token_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_token_unique" ON "artifacts" ("token")',
  },
  {
    describe: "artifacts_owner_path_unique index",
    probe: { kind: "index", index: "artifacts_owner_path_unique" },
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_owner_path_unique" ON "artifacts" ("owner_type","owner_id","source_memory_path")',
  },
  {
    // Hibernated-sandbox reaper bookkeeping. Null on rows hibernated before
    // the columns existed — the reaper falls back to a derived handle for
    // those (engine/hibernation-reaper.ts).
    describe: "agent_sessions.hibernated_sandbox_id column",
    probe: { kind: "column", table: "agent_sessions", column: "hibernated_sandbox_id" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "hibernated_sandbox_id" text',
  },
  {
    describe: "agent_sessions.sandbox_reclaimed_at column",
    probe: { kind: "column", table: "agent_sessions", column: "sandbox_reclaimed_at" },
    sql: 'ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "sandbox_reclaimed_at" bigint',
  },
  {
    // Settled-run sandbox reclaim bookkeeping (workflows/sandbox-reclaim.ts).
    // Null on every run settled before the column existed — exactly the rows
    // the reclaim sweep must pick up.
    describe: "workflow_runs.sandbox_reclaimed_at column",
    probe: { kind: "column", table: "workflow_runs", column: "sandbox_reclaimed_at" },
    sql: 'ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "sandbox_reclaimed_at" bigint',
  },
  {
    // The RFC 7591 scope set an MCP OAuth client was registered with
    // (integration-oauth.ts, TKAI-243). Null on rows registered before
    // scopes support, which the compare reads as "no scopes" — a declared
    // scope set then re-registers the client.
    describe: "mcp_oauth_clients.registered_scopes column",
    probe: { kind: "column", table: "mcp_oauth_clients", column: "registered_scopes" },
    sql: 'ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "registered_scopes" jsonb',
  },
  {
    // The server's advertised scopes_supported, captured at registration or
    // lazily backfilled (integration-oauth.ts). Null on rows from before the
    // column existed — exactly the rows the backfill fills in.
    describe: "mcp_oauth_clients.scopes_supported column",
    probe: { kind: "column", table: "mcp_oauth_clients", column: "scopes_supported" },
    sql: 'ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "scopes_supported" jsonb',
  },
];

/** The repairs this database still lacks, by catalog probe — one query per
 * probe kind (3 round-trips), not one per repair. Exported for the schema
 * tests: steady state must return [] — that is the no-locks contract.
 * The probe lists ride as JSON strings so both drivers (node-postgres,
 * PGlite) bind them identically. */
export async function missingSchemaRepairs(db: PgDb): Promise<SchemaRepair[]> {
  const columnTables = new Set<string>();
  const tableNames: string[] = [];
  const indexNames: string[] = [];
  for (const { probe } of SCHEMA_REPAIRS) {
    if (probe.kind === "column") columnTables.add(probe.table);
    else if (probe.kind === "table") tableNames.push(probe.table);
    else indexNames.push(probe.index);
  }

  const present = new Set<string>();
  const collect = async (sql: string, names: string[], toKey: (row: Record<string, unknown>) => string) => {
    if (names.length === 0) return;
    const result = await db.query(sql, [JSON.stringify(names)]);
    for (const row of result.rows) present.add(toKey(row));
  };
  await collect(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    [...columnTables],
    (row) => `column:${String(row["table_name"])}.${String(row["column_name"])}`,
  );
  await collect(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    tableNames,
    (row) => `table:${String(row["table_name"])}`,
  );
  await collect(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname IN (SELECT jsonb_array_elements_text($1::jsonb))`,
    indexNames,
    (row) => `index:${String(row["indexname"])}`,
  );

  return SCHEMA_REPAIRS.filter(({ probe: p }) => {
    const key = p.kind === "column" ? `column:${p.table}.${p.column}` : p.kind === "table" ? `table:${p.table}` : `index:${p.index}`;
    return !present.has(key);
  });
}

const REPAIR_LOCK_TIMEOUT = "5s";
const REPAIR_ATTEMPTS = 3;

/**
 * Repair the schema gaps that in-place `0000_app.sql` edits leave in an
 * already-migrated database. Steady state (nothing missing) runs catalog
 * probes only — no DDL, no exclusive locks (TKAI-244). A repair that must
 * run does so under `lock_timeout`, retries briefly, and then fails naming
 * the wait — a hung boot with nothing in the log is the failure mode this
 * replaces.
 */
async function addColumnsMissingFromAppliedMigrations(db: PgDb): Promise<void> {
  for (const repair of await missingSchemaRepairs(db)) {
    await runSchemaRepair(db, repair);
  }
}

async function runSchemaRepair(db: PgDb, repair: SchemaRepair): Promise<void> {
  for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
    try {
      await db.transaction(async (tx) => {
        // SET LOCAL scopes the timeout to this transaction. Without it the
        // ALTER waits forever behind any open transaction on the table —
        // during a rolling update, the previous api pod's.
        await tx.query(`SET LOCAL lock_timeout = '${REPAIR_LOCK_TIMEOUT}'`);
        await tx.query(repair.sql);
      });
      console.log(`schema repair: added ${repair.describe}`);
      return;
    } catch (err) {
      if (!isPgLockTimeout(err)) throw err;
      if (attempt < REPAIR_ATTEMPTS) {
        console.warn(
          `schema repair: ${repair.describe} waited ${REPAIR_LOCK_TIMEOUT} for a table lock (attempt ${attempt}/${REPAIR_ATTEMPTS}); retrying`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        continue;
      }
      throw new Error(
        `schema repair: ${repair.describe} could not get a table lock after ${REPAIR_ATTEMPTS} attempts of ${REPAIR_LOCK_TIMEOUT}. ` +
          `Another connection holds a conflicting lock — usually an open transaction from a previous api process. ` +
          `End that process (or its transaction in pg_stat_activity), then restart the api.`,
      );
    }
  }
}
