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
import { applyEngineMigrations, pgDbFromPglite, pgDbFromPool, type PgDb } from "@valet/store-postgres";
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
 * Add columns that a pre-1.0 edit put into an ALREADY-APPLIED migration.
 *
 * Before 1.0 this repo edits `0000_app.sql` in place instead of adding a
 * numbered migration. A fresh database therefore gets the edit, but an
 * existing one never does: the tracker sees `0000_app.sql` recorded and
 * skips the file. The documented remedy is to delete the data directory,
 * which is acceptable for a scratch database and not acceptable for one
 * holding work somebody wants to keep.
 *
 * Each statement here is idempotent, so it costs one catalog lookup per
 * boot after the first. Add a line when an in-place edit adds a NULLABLE
 * (or DEFAULT-backfilled) column or a whole new table; a column that needs
 * a computed value cannot be repaired this way and does need a real
 * migration.
 *
 * Delete this function at 1.0, when numbered migrations take over.
 */
async function addColumnsMissingFromAppliedMigrations(db: PgDb): Promise<void> {
  // Records which person's GitHub credential a team skill source may use.
  // Null on every row written before the column existed, which the sync
  // reads as "no credential" rather than climbing to the org's App.
  await db.query('ALTER TABLE "skill_sources" ADD COLUMN IF NOT EXISTS "created_by" text');

  // The per-group team-sync allowlist. Null on every row written before the
  // column existed, which the sync and Settings read as "never set" —
  // fail-closed, same as an empty list.
  await db.query('ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "sso_team_groups" jsonb');

  // Artifact-sharing opt-in (artifacts design). The DEFAULT backfills every
  // pre-existing org row to `false` — anonymous sharing stays off until an
  // admin opts in, the same fail-closed answer a fresh database gets.
  await db.query(
    'ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "allow_public_artifacts" boolean NOT NULL DEFAULT false',
  );

  // The artifacts table itself (artifacts design) — a whole-table sibling of
  // the column repairs above, for the same reason: the tracker sees
  // `0000_app.sql` applied and never replays the in-place edit that added
  // this table. Keep the definition in lockstep with `0000_app.sql`.
  await db.query(`
    CREATE TABLE IF NOT EXISTS "artifacts" (
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
    )
  `);
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_token_unique" ON "artifacts" ("token")');
  await db.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_owner_path_unique" ON "artifacts" ("owner_type","owner_id","source_memory_path")',
  );

  // Hibernated-sandbox reaper bookkeeping. Null on rows hibernated before
  // the columns existed — the reaper falls back to a derived handle for
  // those (engine/hibernation-reaper.ts).
  await db.query('ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "hibernated_sandbox_id" text');
  await db.query('ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "sandbox_reclaimed_at" bigint');

  // Settled-run sandbox reclaim bookkeeping (workflows/sandbox-reclaim.ts).
  // Null on every run settled before the column existed — exactly the rows
  // the reclaim sweep must pick up.
  await db.query('ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "sandbox_reclaimed_at" bigint');

  // Valet Design (2026-08-23 design spec): which authoring surface a session
  // drives. The DEFAULT backfills every pre-existing session to 'code' —
  // the same answer a fresh database gets.
  await db.query(`ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'code'`);
  await db.query('ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "template" text');

  // Design artifact tables (Valet Design) — whole-table siblings of the
  // artifacts repair above. Keep the definitions in lockstep with
  // `0000_app.sql`.
  await db.query(`
    CREATE TABLE IF NOT EXISTS "design_artifacts" (
      "id" text PRIMARY KEY NOT NULL,
      "session_id" text NOT NULL,
      "current_revision" text NOT NULL,
      "size_bytes" bigint NOT NULL,
      "created_at" bigint NOT NULL,
      "updated_at" bigint NOT NULL
    )
  `);
  await db.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS "design_artifacts_session_unique" ON "design_artifacts" ("session_id")',
  );
  // Design scratchpad (Claude Design parity): the agent's persistent
  // working memory for a design project. DEFAULT '' backfills old rows.
  await db.query(
    `ALTER TABLE "design_artifacts" ADD COLUMN IF NOT EXISTS "scratchpad" text NOT NULL DEFAULT ''`,
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS "design_artifact_revisions" (
      "id" text PRIMARY KEY NOT NULL,
      "artifact_id" text NOT NULL,
      "revision" text NOT NULL,
      "turn_id" text,
      "summary" text DEFAULT '' NOT NULL,
      "content" text NOT NULL,
      "created_at" bigint NOT NULL
    )
  `);
  await db.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS "design_artifact_revisions_unique" ON "design_artifact_revisions" ("artifact_id","revision")',
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS "design_comments" (
      "id" text PRIMARY KEY NOT NULL,
      "artifact_id" text NOT NULL,
      "revision" text NOT NULL,
      "vdid" text NOT NULL,
      "body" text NOT NULL,
      "author_user_id" text NOT NULL,
      "resolved_at" bigint,
      "created_at" bigint NOT NULL
    )
  `);
  await db.query(
    'CREATE INDEX IF NOT EXISTS "design_comments_artifact" ON "design_comments" ("artifact_id")',
  );
}
