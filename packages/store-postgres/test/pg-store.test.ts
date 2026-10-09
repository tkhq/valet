import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
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
  "engine_wakeups",
  "engine_leases",
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
 * test). Migrations run once; every factory() call, including the first,
 * truncates data tables. Each contract test gets the same blank-slate
 * guarantee a fresh `:memory:` sqlite db gave.
 */
function makeFactory(db: PgDb): () => Promise<PgSessionStore> {
  let migrated = false;
  return async () => {
    if (!migrated) {
      await applyEngineMigrations(db);
      migrated = true;
    }
    // The shared Postgres database can contain data from a previous test file.
    await truncateAll(db);
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

  it("skips an unreadable wakeup or lease row instead of failing the whole read (fix wave 2, M5)", async () => {
    const store = await factory();
    const base = {
      sessionId: "s", threadId: "t", status: "running" as const, reason: "r", command: "c", execId: "job-1",
      logOffset: 0, logTail: "", eventCount: 0, createdAt: 1, updatedAt: 1,
    };
    await store.createWakeup({ ...base, id: "wk_good", kind: "process" });
    await store.createWakeup({ ...base, id: "wk_bad", kind: "process", createdAt: 0 });
    await db.query(`UPDATE engine_wakeups SET cause = 'bogus' WHERE id = 'wk_bad'`);
    await store.createLease({ id: "ls_good", sessionId: "s", ownerKind: "hold", reason: "r", createdAt: 1, deadlineAt: 9 });
    await store.createLease({ id: "ls_bad", sessionId: "s", ownerKind: "hold", reason: "r", createdAt: 0, deadlineAt: 9 });
    await db.query(`UPDATE engine_leases SET owner_kind = 'bogus' WHERE id = 'ls_bad'`);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await store.listDueWakeups(10, 10)).map((w) => w.id)).toEqual(["wk_good"]);
      expect((await store.listAllActiveLeases()).map((l) => l.id)).toEqual(["ls_good"]);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("wk_bad"), expect.anything());
    } finally {
      errors.mockRestore();
    }
  });

  it("bounds recent history in the database after excluding compactions", async () => {
    const store = await factory();
    await store.saveSession({ id: "bounded", userId: "u1", orgId: "o1", owner: { type: "user", id: "u1" }, workspace: "/", purpose: "interactive", status: "running", createdAt: 1, updatedAt: 1 });
    await store.saveThread("bounded", { id: "history", sessionId: "bounded", key: "web", status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
    const base = { sessionId: "bounded", threadId: "history", parentId: null, createdAt: 1 };
    await store.appendEntries("bounded", "history", [
      { ...base, id: "old", type: "message", role: "user", content: "old" },
      { ...base, id: "recent-a", type: "message", role: "user", content: "a" },
      { ...base, id: "recent-b", type: "message", role: "user", content: "b" },
      { ...base, id: "compacted", type: "compaction", summary: "summary", coveredEntryIds: ["old"], tokenCountBefore: 10, tokenCountAfter: 1 },
    ]);
    const query = vi.spyOn(db, "query");
    try {
      const entries = await store.getEntries("bounded", "history", { limit: 2, includeCompacted: false });
      expect(entries.map((entry) => entry.id)).toEqual(["recent-a", "recent-b"]);
      expect(query).toHaveBeenCalledTimes(1);
      // Verify the driver returns only the requested tail, not all history.
      expect((await query.mock.results[0].value).rows).toHaveLength(2);
      expect((await store.getEntries("bounded", "history", { limit: 2 })).map((entry) => entry.id)).toEqual(["recent-b", "compacted"]);
      expect((await store.getEntries("bounded", "history", { includeCompacted: false })).map((entry) => entry.id)).toEqual(["old", "recent-a", "recent-b"]);
      expect((await store.getEntries("bounded", "history", { limit: 0 })).map((entry) => entry.id)).toEqual(["old", "recent-a", "recent-b", "compacted"]);
    } finally {
      query.mockRestore();
    }
  });
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
