import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDbFromPglite, type PgDb } from "../src/db.js";
import { applyEngineMigrations, assertSchemaVersion, ENGINE_SCHEMA_VERSION } from "../src/migrate.js";

const ENGINE_TABLES = [
  "engine_decision_gate_refs",
  "engine_decision_gates",
  "engine_entries",
  "engine_queue_items",
  "engine_attempt_markers",
  "engine_meta",
  "engine_events",
  "engine_sessions",
  "engine_suspended_turns",
  "engine_threads",
];

async function tableExists(db: PgDb, table: string): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1",
    [table],
  );
  return result.rows.length > 0;
}

describe("applyEngineMigrations", () => {
  // Task 0 finding: PGlite's wasm heap is not reliably released on close(),
  // so this file shares ONE instance across all its tests.
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);

  beforeAll(async () => {
    await applyEngineMigrations(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("creates all 10 engine_* tables", async () => {
    for (const table of ENGINE_TABLES) {
      expect(await tableExists(db, table), `expected table ${table} to exist`).toBe(true);
    }
  });

  it("creates the partial created_at index cost attribution scans", async () => {
    const result = await db.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'engine_entries' AND indexname = $1",
      ["engine_entries_usage_window"],
    );
    expect(result.rows).toHaveLength(1);
    // Partial: only entries that carry usage, which is one per assistant turn.
    expect(String(result.rows[0]?.indexdef)).toMatch(/WHERE \(?usage IS NOT NULL\)?/);
  });

  it("seeds the engine_meta schema_version row", async () => {
    const result = await db.query("SELECT value FROM engine_meta WHERE key = 'schema_version'");
    expect(result.rows[0]?.value).toBe(ENGINE_SCHEMA_VERSION);
  });

  it("tracks the applied migration in __valet_engine_migrations", async () => {
    const result = await db.query(
      "SELECT filename FROM __valet_engine_migrations WHERE filename = $1",
      ["0000_engine.sql"],
    );
    expect(result.rows).toHaveLength(1);
  });

  it("is idempotent on re-run", async () => {
    await expect(applyEngineMigrations(db)).resolves.toBeUndefined();
    const result = await db.query(
      "SELECT filename FROM __valet_engine_migrations WHERE filename = $1",
      ["0000_engine.sql"],
    );
    expect(result.rows).toHaveLength(1);

    // Re-running must not attempt to re-create tables that already exist.
    for (const table of ENGINE_TABLES) {
      expect(await tableExists(db, table)).toBe(true);
    }
  });

  it("assertSchemaVersion passes for a freshly migrated db", async () => {
    await expect(assertSchemaVersion(db)).resolves.toBeUndefined();
  });

  it("assertSchemaVersion throws when engine_meta version mismatches", async () => {
    await db.query("UPDATE engine_meta SET value = $1 WHERE key = 'schema_version'", ["999"]);
    try {
      await expect(assertSchemaVersion(db)).rejects.toThrow(/schema_version mismatch/);
    } finally {
      await db.query("UPDATE engine_meta SET value = $1 WHERE key = 'schema_version'", [
        ENGINE_SCHEMA_VERSION,
      ]);
    }
  });

  it("assertSchemaVersion throws when engine_meta table is missing", async () => {
    const isolated = new PGlite();
    const isolatedDb = pgDbFromPglite(isolated);
    try {
      await expect(assertSchemaVersion(isolatedDb)).rejects.toThrow(/engine_meta table missing/);
    } finally {
      await isolatedDb.close();
    }
  });

  describe("smoke insert/select through each table's PK shape", () => {
    it("engine_sessions (single-column text PK)", async () => {
      await db.query(
        `INSERT INTO engine_sessions (id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        ["sess-1", "user", "user-1", "user-1", "org-1", "ws-1", "chat", "active", 1000, 1000],
      );
      const result = await db.query("SELECT id FROM engine_sessions WHERE id = $1", ["sess-1"]);
      expect(result.rows).toEqual([{ id: "sess-1" }]);
    });

    it("engine_threads (single-column text PK + unique session_id,key index)", async () => {
      await db.query(
        `INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        ["thread-1", "sess-1", "main", "active", "fifo", 1000, 1000],
      );
      const result = await db.query("SELECT id FROM engine_threads WHERE id = $1", ["thread-1"]);
      expect(result.rows).toEqual([{ id: "thread-1" }]);

      await expect(
        db.query(
          `INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          ["thread-2", "sess-1", "main", "active", "fifo", 1000, 1000],
        ),
      ).rejects.toThrow();
    });

    it("engine_entries (single-column text PK)", async () => {
      await db.query(
        `INSERT INTO engine_entries (id, session_id, thread_id, entry_type, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        ["entry-1", "sess-1", "thread-1", "message", 1000],
      );
      const result = await db.query("SELECT id FROM engine_entries WHERE id = $1", ["entry-1"]);
      expect(result.rows).toEqual([{ id: "entry-1" }]);
    });

    it("engine_queue_items (single-column text PK)", async () => {
      await db.query(
        `INSERT INTO engine_queue_items (id, session_id, thread_id, status, content, attempt_count, max_attempts, timeout_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        ["item-1", "sess-1", "thread-1", "queued", "{}", 0, 3, 5000, 1000, 1000],
      );
      const result = await db.query("SELECT id FROM engine_queue_items WHERE id = $1", ["item-1"]);
      expect(result.rows).toEqual([{ id: "item-1" }]);
    });

    it("engine_attempt_markers (composite PK item_id,attempt_id)", async () => {
      await db.query(
        `INSERT INTO engine_attempt_markers (item_id, attempt_id, created_at) VALUES ($1,$2,$3)`,
        ["item-1", "attempt-1", 1000],
      );
      await expect(
        db.query(`INSERT INTO engine_attempt_markers (item_id, attempt_id, created_at) VALUES ($1,$2,$3)`, [
          "item-1",
          "attempt-1",
          2000,
        ]),
      ).rejects.toThrow();
    });

    it("engine_decision_gates (single-column text PK)", async () => {
      await db.query(
        `INSERT INTO engine_decision_gates (id, session_id, thread_id, queue_item_id, resume_key, ordinal, type, status, title, actions, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        ["gate-1", "sess-1", "thread-1", "item-1", "resume-1", 0, "confirm", "pending", "Confirm?", "[]", 1000, 1000],
      );
      const result = await db.query("SELECT id FROM engine_decision_gates WHERE id = $1", ["gate-1"]);
      expect(result.rows).toEqual([{ id: "gate-1" }]);
    });

    it("engine_decision_gate_refs (single-column text PK)", async () => {
      await db.query(
        `INSERT INTO engine_decision_gate_refs (id, gate_id, channel_type, ref, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        ["ref-1", "gate-1", "slack", "C123", 1000, 1000],
      );
      const result = await db.query("SELECT id FROM engine_decision_gate_refs WHERE id = $1", ["ref-1"]);
      expect(result.rows).toEqual([{ id: "ref-1" }]);
    });

    it("engine_suspended_turns (composite PK session_id,thread_id)", async () => {
      await db.query(
        `INSERT INTO engine_suspended_turns
           (session_id, thread_id, queue_item_id, gate_id, model, tool_call_id, tool_name, tool_args, resume_key, ordinal, attempt, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        ["sess-1", "thread-1", "item-1", "gate-1", "claude", "call-1", "run", "{}", "resume-1", 0, 0, 1000],
      );
      const result = await db.query(
        "SELECT session_id, thread_id FROM engine_suspended_turns WHERE session_id = $1 AND thread_id = $2",
        ["sess-1", "thread-1"],
      );
      expect(result.rows).toEqual([{ session_id: "sess-1", thread_id: "thread-1" }]);

      await expect(
        db.query(
          `INSERT INTO engine_suspended_turns
             (session_id, thread_id, queue_item_id, gate_id, model, tool_call_id, tool_name, tool_args, resume_key, ordinal, attempt, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          ["sess-1", "thread-1", "item-2", "gate-2", "claude", "call-2", "run", "{}", "resume-2", 0, 0, 2000],
        ),
      ).rejects.toThrow();
    });

    it("engine_events (composite PK session_id,seq)", async () => {
      await db.query(
        `INSERT INTO engine_events (session_id, seq, event_key, event_type, payload, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        ["sess-1", 1, "key-1", "message.created", "{}", 1000],
      );
      const result = await db.query(
        "SELECT session_id, seq FROM engine_events WHERE session_id = $1 AND seq = $2",
        ["sess-1", 1],
      );
      expect(result.rows).toEqual([{ session_id: "sess-1", seq: 1 }]);

      await expect(
        db.query(
          `INSERT INTO engine_events (session_id, seq, event_key, event_type, payload, timestamp)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          ["sess-1", 1, "key-2", "message.created", "{}", 2000],
        ),
      ).rejects.toThrow();
    });
  });
});
