/**
 * Shared PGlite test-db helper (Task 7 of the postgres-backend plan, decision
 * 11 of docs/specs/2026-07-15-postgres-backend-design.md).
 *
 * Task 0's durability spike found PGlite's wasm heap isn't reliably released
 * on `close()` (see `pg-schema.test.ts`'s comment), so every caller in this
 * process shares ONE `PGlite` instance rather than constructing a fresh one
 * per test/boot.
 *
 * Isolation between boots comes from an empty-the-tables reset, not from a
 * new instance and not from a new schema. The migrations run ONCE per
 * process; each later boot issues one `TRUNCATE` over every table. The api
 * suite boots an app more than a thousand times, and a schema rebuild costs
 * about 145 ms against this schema while this reset costs about 25 ms, so
 * the migrations are the larger part of the suite's cost.
 *
 * `engine_meta` is emptied with the other tables and its one migration-seeded
 * row (`schema_version`) is written again immediately. It is a general
 * key/value table, so a row a test writes there must not reach the next boot.
 *
 * Two tables stay out of the truncate: `__valet_app_migrations` and
 * `__valet_engine_migrations` record which migration files ran. An empty
 * tracker makes the next migration run re-create tables that already exist,
 * and the fallback path in `freshTestPgDb` depends on the trackers.
 *
 * A test can also change the SHAPE of the schema — the templates suite adds a
 * constraint, the provisioning suite drops a table. The old schema rebuild
 * removed such a change on the next boot for free. The truncate cannot, so
 * `freshTestPgDb` compares a catalog fingerprint before each reset and
 * rebuilds the schema when it moved. See `readFingerprint`.
 */
import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite, ENGINE_SCHEMA_VERSION, type PgDb } from "@valet/store-postgres";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";

let sharedPglite: PGlite | undefined;
let sharedPgDb: PgDb | undefined;
/** Cached `TRUNCATE` over every resettable table, built after the migrations. */
let truncateSql: string | undefined;
/** Catalog fingerprint of the schema the cached statement was built against. */
let schemaFingerprint: string | undefined;

/**
 * Tables the reset must leave alone. See the module doc comment for why the
 * migration trackers are unrecoverable after a truncate.
 */
const PRESERVED_TABLES = new Set(["__valet_app_migrations", "__valet_engine_migrations"]);

/** The one row the migrations insert. `assertSchemaVersion()` reads it. */
const SEED_ENGINE_META_SQL =
  "INSERT INTO engine_meta (\"key\", \"value\") VALUES ('schema_version', $1)";

/**
 * Three counts that move when the shape of the `public` schema moves:
 * `pg_class` for tables, views, indexes and sequences; `pg_constraint` for
 * constraints; `pg_attribute` for live columns (Postgres keeps the row of a
 * dropped column, so the count must skip `attisdropped`).
 *
 * The counts see a table, index, constraint or column that a test adds or
 * removes. They do not see a change that keeps the count — a rename, or a new
 * type on a column. A rename makes the cached `TRUNCATE` fail, which the
 * caller also treats as drift; a changed column type does not, and no api
 * test does that today.
 */
const FINGERPRINT_SQL = `SELECT
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace)::text
  || ':' || (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace)::text
  || ':' || (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
             WHERE c.relnamespace = 'public'::regnamespace AND NOT a.attisdropped)::text
  AS fingerprint`;

function sharedInstance(): { pglite: PGlite; pgdb: PgDb } {
  if (!sharedPglite) {
    sharedPglite = new PGlite();
    sharedPgDb = pgDbFromPglite(sharedPglite);
  }
  // sharedPgDb is always set alongside sharedPglite above.
  return { pglite: sharedPglite, pgdb: sharedPgDb as PgDb };
}

/**
 * One catalog read, about 1 ms against this schema. A shape that cannot be
 * read is reported as drift, because a rebuild is always safe and this helper
 * must not trust a schema it did not see.
 */
async function readFingerprint(pgdb: PgDb): Promise<string> {
  try {
    const result = await pgdb.query(FINGERPRINT_SQL);
    const value = result.rows[0]?.fingerprint;
    return typeof value === "string" ? value : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * Reads the table list from the live schema so a new migration needs no edit
 * here. `pg_tables` lists tables only, so the `cost_entries` view cannot
 * reach the statement — `TRUNCATE` rejects a view.
 *
 * `RESTART IDENTITY` keeps the identity column on `workflow_signals` counting
 * from 1 on every boot, which is what the schema rebuild did.
 */
async function buildTruncateSql(pgdb: PgDb): Promise<string | undefined> {
  const result = await pgdb.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  const quoted: string[] = [];
  for (const row of result.rows) {
    const name = row.tablename;
    // `user` is a reserved word, so every name needs quotes.
    if (typeof name === "string" && !PRESERVED_TABLES.has(name))
      quoted.push(`"${name}"`);
  }
  if (quoted.length === 0) return undefined;
  return `TRUNCATE ${quoted.join(", ")} RESTART IDENTITY CASCADE`;
}

/** Rebuilds the schema from the migrations and refreshes the cached state. */
async function replaySchema(pgdb: PgDb): Promise<void> {
  await pgdb.query("DROP SCHEMA public CASCADE");
  await pgdb.query("CREATE SCHEMA public");
  // `applyAppMigrations` applies the engine set first — see its doc comment.
  await applyAppMigrations(pgdb);
  truncateSql = await buildTruncateSql(pgdb);
  schemaFingerprint = await readFingerprint(pgdb);
}

/** Empties every resettable table and writes the seeded row again. */
async function truncateAll(pgdb: PgDb, statement: string): Promise<void> {
  await pgdb.query(statement);
  await pgdb.query(SEED_ENGINE_META_SQL, [ENGINE_SCHEMA_VERSION]);
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
 * Empties every table of the shared PGlite instance and returns handles over
 * it. Call once per test boot in place of constructing a fresh `:memory:`
 * sqlite handle.
 *
 * The first call in the process applies both migration sets. Every later call
 * reads the catalog fingerprint and, while the shape holds, issues one cached
 * `TRUNCATE`. A different fingerprint means a test changed the schema (added
 * a constraint, dropped a table, added a column), and a `TRUNCATE` that fails
 * means a table it names is gone or renamed. Both rebuild the schema from the
 * migrations, which is the only source of truth for the shape. So one broken
 * test cannot leave a changed schema to the tests after it, which matters
 * more here than elsewhere because `vitest.config.ts` sets `isolate: false`
 * and the instance is shared across the files of a worker.
 *
 * WARNING (single-live-app trap): because every caller in the process shares
 * one PGlite instance, calling this while a previously-booted app/store in
 * the same process is still live empties that app's tables under it. One live
 * boot per process at a time — tear down (cleanup/close the app) before
 * booting the next. Vitest's per-file process isolation makes this safe across
 * files; within a file, boot sequentially.
 */
export async function freshTestPgDb(): Promise<TestPgDb> {
  const { pglite, pgdb } = sharedInstance();

  if (truncateSql === undefined) {
    await replaySchema(pgdb);
  } else if ((await readFingerprint(pgdb)) !== schemaFingerprint) {
    await replaySchema(pgdb);
  } else {
    try {
      await truncateAll(pgdb, truncateSql);
    } catch {
      // A table the statement names is gone or has a new name. The cached
      // statement is stale, so rebuild from the migrations.
      await replaySchema(pgdb);
    }
  }

  const appDb = buildAppDb(pglite);

  return {
    pgdb,
    appDb,
    async cleanup() {
      // Deliberate no-op — see module doc comment.
    },
  };
}
