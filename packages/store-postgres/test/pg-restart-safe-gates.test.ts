import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { afterAll, describe } from "vitest";
import { runRestartSafeGatesContract } from "@valet/engine/test-helpers";
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
 * Same one-instance-per-describe-block pattern as `pg-store.test.ts` /
 * `pg-event-stream.test.ts` (decision 11 + the Task 0 finding that PGlite's
 * wasm heap isn't reliably released on `close()`).
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

describe("PgSessionStore restart-safe gates (PGlite)", () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  const factory = makeFactory(db);

  afterAll(async () => {
    await db.close();
  });

  runRestartSafeGatesContract("PgSessionStore (PGlite)", factory);
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("PgSessionStore restart-safe gates (docker-pg)", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = pgDbFromPool(pool);
  const factory = makeFactory(db);

  afterAll(async () => {
    await db.close();
  });

  runRestartSafeGatesContract("PgSessionStore (docker-pg)", factory);
});
