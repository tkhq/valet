import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CommandResultEntry } from "@valet/engine";
import { pgDbFromPglite, pgDbFromPool, type PgDb } from "../src/db.js";
import { applyEngineMigrations } from "../src/migrate.js";
import { PgSessionStore } from "../src/store.js";

/**
 * Test that command_result entries round-trip through PgSessionStore
 * with full fidelity — output text, command, source, and ok fields
 * survive serialization and retrieval.
 *
 * This is a regression guard for the known pattern: entry round-trip
 * bugs surface as "empty output" in the UI on reload (shape mismatch).
 */

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

function runCommandResultSuite(label: string, getDb: () => PgDb) {
  describe(`command_result entry round trip: ${label}`, () => {
    let store: PgSessionStore;
    const factory = makeFactory(getDb());

    beforeEach(async () => {
      store = await factory();
    });

    it("round-trips command_result entries with full field fidelity", async () => {
      // Set up session and thread
      await store.saveSession({
        id: "sess-1",
        owner: { type: "user", id: "u1" },
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        purpose: "interactive",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      });

      await store.saveThread("sess-1", {
        id: "th-1",
        sessionId: "sess-1",
        key: "web:default",
        status: "active",
        queueMode: "followup",
        createdAt: 1,
        updatedAt: 1,
      });

      // Create the command_result entry fixture
      const fixture: CommandResultEntry = {
        id: "e-cmd-1",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "command_result",
        command: "/status",
        source: "builtin",
        ok: true,
        output: "**idle** — queue 0",
        createdAt: 1000,
      };

      // Append the entry
      await store.appendEntries("sess-1", "th-1", [fixture]);

      // Retrieve and verify
      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(1);

      const retrieved = loaded[0];
      expect(retrieved.type).toBe("command_result");
      expect(retrieved).toMatchObject({
        id: "e-cmd-1",
        type: "command_result",
        createdAt: 1000,
      });

      // Type-guard and verify all fields
      if (retrieved.type !== "command_result") {
        throw new Error("expected command_result entry");
      }
      expect(retrieved.output).toBe("**idle** — queue 0");
      expect(retrieved.command).toBe("/status");
      expect(retrieved.source).toBe("builtin");
      expect(retrieved.ok).toBe(true);
    });

    it("preserves output text exactly, including markdown formatting", async () => {
      await store.saveSession({
        id: "sess-2",
        owner: { type: "user", id: "u2" },
        userId: "u2",
        orgId: "o2",
        workspace: "/",
        purpose: "interactive",
        status: "running",
        createdAt: 2,
        updatedAt: 2,
      });

      await store.saveThread("sess-2", {
        id: "th-2",
        sessionId: "sess-2",
        key: "web:default",
        status: "active",
        queueMode: "followup",
        createdAt: 2,
        updatedAt: 2,
      });

      const complexOutput = "# Build Failed\n\n```\nError: ENOENT: no such file or directory\n```\n\n**Action:** Check the path.";
      const entry: CommandResultEntry = {
        id: "e-cmd-2",
        sessionId: "sess-2",
        threadId: "th-2",
        parentId: null,
        type: "command_result",
        command: "/build",
        source: "skill",
        ok: false,
        output: complexOutput,
        createdAt: 2000,
      };

      await store.appendEntries("sess-2", "th-2", [entry]);

      const loaded = await store.getEntries("sess-2", "th-2");
      const retrieved = loaded[0];

      if (retrieved.type !== "command_result") {
        throw new Error("expected command_result entry");
      }
      expect(retrieved.output).toBe(complexOutput);
    });

    it("supports all CommandSource values: builtin, skill, template, plugin", async () => {
      await store.saveSession({
        id: "sess-3",
        owner: { type: "user", id: "u3" },
        userId: "u3",
        orgId: "o3",
        workspace: "/",
        purpose: "interactive",
        status: "running",
        createdAt: 3,
        updatedAt: 3,
      });

      await store.saveThread("sess-3", {
        id: "th-3",
        sessionId: "sess-3",
        key: "web:default",
        status: "active",
        queueMode: "followup",
        createdAt: 3,
        updatedAt: 3,
      });

      const sources: Array<{ source: CommandResultEntry["source"]; desc: string }> = [
        { source: "builtin", desc: "built-in" },
        { source: "skill", desc: "skill" },
        { source: "template", desc: "template" },
        { source: "plugin", desc: "plugin" },
      ];

      const entries: CommandResultEntry[] = sources.map((s, i) => ({
        id: `e-cmd-src-${i}`,
        sessionId: "sess-3",
        threadId: "th-3",
        parentId: null,
        type: "command_result",
        command: "/test",
        source: s.source,
        ok: true,
        output: `Output from ${s.desc} command`,
        createdAt: 3000 + i,
      }));

      await store.appendEntries("sess-3", "th-3", entries);

      const loaded = await store.getEntries("sess-3", "th-3");
      expect(loaded).toHaveLength(4);

      sources.forEach((s, i) => {
        const retrieved = loaded[i];
        if (retrieved.type !== "command_result") {
          throw new Error(`expected command_result at index ${i}`);
        }
        expect(retrieved.source).toBe(s.source);
        expect(retrieved.output).toBe(`Output from ${s.desc} command`);
      });
    });

    it("preserves system fields (command/source/ok) even when metadata contains same keys", async () => {
      // Regression test: user metadata spread BEFORE system fields to prevent
      // accidental override of canonical values by user-supplied metadata.
      await store.saveSession({
        id: "sess-4",
        owner: { type: "user", id: "u4" },
        userId: "u4",
        orgId: "o4",
        workspace: "/",
        purpose: "interactive",
        status: "running",
        createdAt: 4,
        updatedAt: 4,
      });

      await store.saveThread("sess-4", {
        id: "th-4",
        sessionId: "sess-4",
        key: "web:default",
        status: "active",
        queueMode: "followup",
        createdAt: 4,
        updatedAt: 4,
      });

      // Create entry with user metadata that shadows system field names.
      // System values: command="/status", source="builtin", ok=true
      // User metadata: { command: "user-value", source: "wrong", ok: false, note: "keep-me" }
      // Expected: system values unchanged, user note preserved, shadowed keys dropped.
      const entry: CommandResultEntry = {
        id: "e-cmd-4",
        sessionId: "sess-4",
        threadId: "th-4",
        parentId: null,
        type: "command_result",
        command: "/status",
        source: "builtin",
        ok: true,
        output: "session idle",
        metadata: {
          command: "user-value",
          source: "wrong",
          ok: false,
          note: "keep-me",
        },
        createdAt: 4000,
      };

      await store.appendEntries("sess-4", "th-4", [entry]);

      const loaded = await store.getEntries("sess-4", "th-4");
      expect(loaded).toHaveLength(1);

      const retrieved = loaded[0];
      if (retrieved.type !== "command_result") {
        throw new Error("expected command_result entry");
      }

      // Verify system fields are canonical (not overridden by user metadata).
      expect(retrieved.command).toBe("/status");
      expect(retrieved.source).toBe("builtin");
      expect(retrieved.ok).toBe(true);

      // Verify other metadata preserved (user-metadata keys that don't shadow system fields).
      expect(retrieved.metadata?.note).toBe("keep-me");

      // Note: command/source/ok in user metadata may be dropped during roundtrip
      // (the rowToEntry decomposition filters them out). This is the current behavior
      // — if a user supplies these keys, they are ignored in favor of the system values.
      // This test asserts that behavior explicitly.
    });
  });
}

describe("PGlite command_result", () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);

  afterAll(async () => {
    await db.close();
  });

  runCommandResultSuite("PGlite", () => db);
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("docker-pg command_result", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = pgDbFromPool(pool);

  afterAll(async () => {
    await db.close();
  });

  runCommandResultSuite("docker-pg", () => db);
});
