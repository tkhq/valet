import type Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Bumped whenever the engine schema (0000_lonely_lizard.sql) changes shape.
 * Stamped into `engine_meta` by the migration itself; checked fail-loud on
 * every open so a stale/foreign db file is rejected instead of silently
 * misbehaving. Pre-1.0: there is only ever one schema generation, so any
 * mismatch (including "older") means the db predates this migration set —
 * delete `~/.valet/app.db` and let it recreate.
 */
export const ENGINE_SCHEMA_VERSION = "2";

/**
 * Apply this package's sqlite migrations to an open better-sqlite3 connection.
 *
 * Tracks applied migrations in `__valet_engine_migrations` so re-runs across
 * restarts are no-ops. Backfills the tracker if engine schema tables are
 * present but the tracker is empty (db pre-dates this change).
 */
export function applyEngineMigrations(sqlite: Database.Database): void {
  // Durability-premised subsystem (submission fencing/leases): FULL fsyncs on
  // every commit. See packages/store-sqlite/experiments/FINDINGS-fencing.md.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = FULL");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __valet_engine_migrations (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const migrationsDir = join(__dirname, "..", "migrations", "sqlite");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Backfill bootstrap: if engine_sessions already exists but the tracker is
  // empty, assume every migration has been applied. One-time, harmless.
  const trackerRows = sqlite
    .prepare("SELECT COUNT(*) as n FROM __valet_engine_migrations")
    .get() as { n: number };
  if (trackerRows.n === 0) {
    const schemaSeed = sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_sessions'",
      )
      .get();
    if (schemaSeed) {
      const seed = sqlite.prepare<[string, number]>(
        "INSERT OR IGNORE INTO __valet_engine_migrations (filename, applied_at) VALUES (?, ?)",
      );
      const now = Date.now();
      for (const file of files) seed.run(file, now);
    }
  }

  const isApplied = sqlite.prepare<[string]>(
    "SELECT 1 FROM __valet_engine_migrations WHERE filename = ?",
  );
  const recordApplied = sqlite.prepare<[string, number]>(
    "INSERT INTO __valet_engine_migrations (filename, applied_at) VALUES (?, ?)",
  );

  for (const file of files) {
    if (isApplied.get(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const statements = sql.split(/-->\s*statement-breakpoint/);

    const runMigration = sqlite.transaction(() => {
      for (const stmt of statements) {
        const trimmed = stmt.trim();
        if (trimmed) sqlite.exec(trimmed);
      }
      recordApplied.run(file, Date.now());
    });
    runMigration();
  }

  assertSchemaVersion(sqlite);
}

/**
 * Fail loud rather than let a stale/foreign db file silently misbehave under
 * the new CAS submission lifecycle. The backfill path above can mark
 * migrations "applied" without actually running them (legacy db that
 * predates `engine_meta`) — in that case the version row is simply absent,
 * which this treats the same as a mismatch.
 */
function assertSchemaVersion(sqlite: Database.Database): void {
  const metaTable = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_meta'")
    .get();
  if (!metaTable) {
    throw new Error(
      "engine_meta table missing after migration — this db predates the submission-lifecycle schema. " +
        "Pre-1.0: delete the db file (rm ~/.valet/app.db) and let it recreate.",
    );
  }
  const row = sqlite
    .prepare("SELECT value FROM engine_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  if (!row || row.value !== ENGINE_SCHEMA_VERSION) {
    throw new Error(
      `engine schema_version mismatch: found ${row?.value ?? "none"}, expected ${ENGINE_SCHEMA_VERSION}. ` +
        "Pre-1.0: delete the db file (rm ~/.valet/app.db) and let it recreate.",
    );
  }
}
