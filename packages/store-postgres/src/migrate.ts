import { readFileSync } from "node:fs";
import type { PgDb } from "./db.js";

/**
 * Bumped whenever the engine schema (0000_engine.sql) changes shape.
 * Stamped into `engine_meta` by the migration itself; checked fail-loud on
 * every open so a stale/foreign db is rejected instead of silently
 * misbehaving. Pre-1.0: there is only ever one schema generation, so any
 * mismatch (including "older") means the db predates this migration set —
 * delete the pg data dir and let it recreate (`make dev-clean` under
 * `make dev-local`).
 */
export const ENGINE_SCHEMA_VERSION = "3";

/**
 * The one pre-1.0 engine migration. CLAUDE.md rule: we edit `0000` in place,
 * never add `0001`/`0002`, so this is an explicit single-file read rather than
 * a directory scan. Read via `new URL(..., import.meta.url)` so the asset
 * resolves relative to this module (the seam a later bundling step relies on).
 */
const ENGINE_MIGRATION_FILES = ["0000_engine.sql"] as const;

const migrationSql: Record<(typeof ENGINE_MIGRATION_FILES)[number], () => string> = {
  "0000_engine.sql": () =>
    readFileSync(new URL("../migrations/pg/0000_engine.sql", import.meta.url), "utf8"),
};

/**
 * Apply this package's postgres migrations to an open PgDb. Async — mirrors
 * store-sqlite's `applyEngineMigrations` but probes `information_schema`
 * instead of `sqlite_master` and has no backfill path: no pg database
 * predates the `__valet_engine_migrations` tracker (decision 10 of
 * docs/specs/2026-07-15-postgres-backend-design.md). No pragmas — durability
 * is Postgres's job.
 */
export async function applyEngineMigrations(db: PgDb, pgDataDir?: string): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS __valet_engine_migrations (
      filename text PRIMARY KEY,
      applied_at bigint NOT NULL
    )
  `);

  for (const file of ENGINE_MIGRATION_FILES) {
    const applied = await db.query(
      "SELECT 1 FROM __valet_engine_migrations WHERE filename = $1",
      [file],
    );
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
      await tx.query(
        "INSERT INTO __valet_engine_migrations (filename, applied_at) VALUES ($1, $2)",
        [file, Date.now()],
      );
    });
  }

  await assertSchemaVersion(db, pgDataDir);
}

/** The corrective action for a stale db. Names the exact PGlite dir when the
 * caller provided one; a caller on a real Postgres (`DATABASE_URL`) passes
 * none, and gets the dialect-neutral wording. */
function staleDbHint(pgDataDir?: string): string {
  return pgDataDir
    ? `Pre-1.0: delete the pg data dir (rm -rf ${pgDataDir}) and let it recreate.`
    : "Pre-1.0: wipe the database and let the migrations recreate it.";
}

/**
 * Fail loud rather than let a stale/foreign db silently misbehave under the
 * CAS submission lifecycle. Unlike store-sqlite, there is no backfill path
 * that can mark migrations "applied" without running them — so a missing
 * `engine_meta` table or version mismatch always means a genuinely foreign
 * or pre-tracker database.
 */
export async function assertSchemaVersion(db: PgDb, pgDataDir?: string): Promise<void> {
  const metaTable = await db.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'engine_meta'",
  );
  if (metaTable.rows.length === 0) {
    throw new Error(
      "engine_meta table missing after migration — this db predates the submission-lifecycle schema. " +
        staleDbHint(pgDataDir),
    );
  }
  const row = await db.query("SELECT value FROM engine_meta WHERE key = 'schema_version'");
  const value = row.rows[0]?.value;
  if (value !== ENGINE_SCHEMA_VERSION) {
    throw new Error(
      `engine schema_version mismatch: found ${value ?? "none"}, expected ${ENGINE_SCHEMA_VERSION}. ` +
        staleDbHint(pgDataDir),
    );
  }
}
