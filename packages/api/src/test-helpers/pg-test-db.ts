/**
 * Shared PGlite test-db helper (Task 7 of the postgres-backend plan, decision
 * 11 of docs/specs/2026-07-15-postgres-backend-design.md).
 *
 * Task 0's durability spike found PGlite's wasm heap isn't reliably released
 * on `close()` (see `pg-schema.test.ts`'s comment), so every caller in this
 * process shares ONE `PGlite` instance rather than constructing a fresh one
 * per test/boot. Isolation between boots comes from a schema reset (`DROP
 * SCHEMA public CASCADE; CREATE SCHEMA public;`) followed by re-running both
 * migration sets, not from a new instance.
 */
import { PGlite } from "@electric-sql/pglite";
import { applyEngineMigrations } from "@valet/store-postgres";
import { pgDbFromPglite, type PgDb } from "@valet/store-postgres";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";

let sharedPglite: PGlite | undefined;
let sharedPgDb: PgDb | undefined;

function sharedInstance(): { pglite: PGlite; pgdb: PgDb } {
  if (!sharedPglite) {
    sharedPglite = new PGlite();
    sharedPgDb = pgDbFromPglite(sharedPglite);
  }
  // sharedPgDb is always set alongside sharedPglite above.
  return { pglite: sharedPglite, pgdb: sharedPgDb as PgDb };
}

export interface TestPgDb {
  /** Raw `PgDb` query interface — the same connection source `appDb` above
   * is built over. */
  pgdb: PgDb;
  /** App Drizzle handle over the same connection. */
  appDb: AppDb;
  /** No-op: the underlying PGlite instance is shared/reused across boots
   * (Task 0 wasm-heap finding) — nothing to tear down per-boot. Kept for
   * symmetry with other `cleanup()`-shaped test harnesses and so callers can
   * `finally: await cleanup()` without special-casing this helper. */
  cleanup(): Promise<void>;
}

/**
 * Resets the shared PGlite instance to a clean schema and re-applies both
 * migration sets (app + engine). Call once per test boot in place of
 * constructing a fresh `:memory:` sqlite handle.
 *
 * WARNING (single-live-app trap): because every caller in the process shares
 * one PGlite instance, calling this while a previously-booted app/store in
 * the same process is still live drops that app's schema out from under it.
 * One live boot per process at a time — tear down (cleanup/close the app)
 * before booting the next. Vitest's per-file process isolation makes this
 * safe across files; within a file, boot sequentially.
 */
export async function freshTestPgDb(): Promise<TestPgDb> {
  const { pglite, pgdb } = sharedInstance();

  await pgdb.query("DROP SCHEMA public CASCADE");
  await pgdb.query("CREATE SCHEMA public");

  await applyAppMigrations(pgdb);
  await applyEngineMigrations(pgdb);

  const appDb = buildAppDb(pglite);

  return {
    pgdb,
    appDb,
    async cleanup() {
      // Deliberate no-op — see module doc comment.
    },
  };
}
