import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { afterAll, describe } from "vitest";
import { runSessionStoreContract, runSubmissionLifecycleContract } from "@valet/engine/test-helpers";
import { pgDbFromPglite, pgDbFromPool, type PgDb } from "../src/db.js";
import { applyEngineMigrations } from "../src/migrate.js";
import { PgSessionStore } from "../src/store.js";

// Tables the store touches, in FK-safe truncate order. engine_meta and
// __valet_engine_migrations are deliberately excluded — they track schema
// state, not session data, and must survive across tests in the same file.
const DATA_TABLES = [
  "engine_decision_gate_refs",
  "engine_decision_gates",
  "engine_entries",
  "engine_suspended_turns",
  "engine_attempt_markers",
  "engine_queue_items",
  "engine_events",
  "engine_threads",
  "engine_sessions",
];

async function truncateAll(db: PgDb): Promise<void> {
  await db.query(`TRUNCATE ${DATA_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

/**
 * Builds a `factory()` for the engine's conformance suites that reuses ONE
 * underlying PgDb across every test in the describe block (decision 11 of
 * docs/specs/2026-07-15-postgres-backend-design.md: "PGlite in-memory per
 * boot" — plus the Task 0 finding that PGlite's wasm heap isn't reliably
 * released on close(), so this file must not spin up a fresh PGlite per
 * test). Migrations run once; every subsequent factory() call truncates
 * data tables instead, giving each contract test the same blank-slate
 * guarantee a fresh `:memory:` sqlite db gave.
 */
function makeFactory(db: PgDb): () => Promise<PgSessionStore> {
  let migrated = false;
  return async () => {
    if (!migrated) {
      await applyEngineMigrations(db);
      migrated = true;
    } else {
      await truncateAll(db);
    }
    return new PgSessionStore(db);
  };
}

describe("PgSessionStore (PGlite)", () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  const factory = makeFactory(db);

  afterAll(async () => {
    await db.close();
  });

  runSessionStoreContract("PgSessionStore (PGlite)", { factory });
  runSubmissionLifecycleContract("PgSessionStore (PGlite)", { factory });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("PgSessionStore (docker-pg)", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = pgDbFromPool(pool);
  const factory = makeFactory(db);

  afterAll(async () => {
    await db.close();
  });

  runSessionStoreContract("PgSessionStore (docker-pg)", { factory });
  runSubmissionLifecycleContract("PgSessionStore (docker-pg)", { factory });
});
