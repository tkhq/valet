import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { MessageEntry } from "@valet/engine";
import { pgDbFromPglite, pgDbFromPool, type PgDb } from "../src/db.js";
import { applyEngineMigrations } from "../src/migrate.js";
import { PgSessionStore } from "../src/store.js";

/**
 * Test that user message attachments round-trip through PgSessionStore.
 *
 * Regression guard: attachments were once dropped by the entry row mappers,
 * so image thumbnails vanished from the UI after a reload — the wire's
 * `Message.attachments` projection read `undefined` for every persisted entry.
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

function runAttachmentSuite(label: string, getDb: () => PgDb) {
  describe(`message attachments round trip: ${label}`, () => {
    let store: PgSessionStore;
    const factory = makeFactory(getDb());

    beforeEach(async () => {
      store = await factory();
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
    });

    it("round-trips url-form image attachments on a user message", async () => {
      const entry: MessageEntry = {
        id: "e-msg-1",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "user",
        content: "look at this",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,iVBORw0KGgo=",
            mimeType: "image/png",
            name: "shot.png",
          },
        ],
        createdAt: 1000,
      };

      await store.appendEntries("sess-1", "th-1", [entry]);

      const loaded = await store.getEntries("sess-1", "th-1");
      expect(loaded).toHaveLength(1);
      const retrieved = loaded[0];
      if (retrieved.type !== "message") throw new Error("expected message entry");
      expect(retrieved.attachments).toEqual([
        {
          type: "image",
          url: "data:image/png;base64,iVBORw0KGgo=",
          mimeType: "image/png",
          name: "shot.png",
        },
      ]);
    });

    it("normalizes byte-backed attachments to a data: URL on persist", async () => {
      const bytes = new Uint8Array([137, 80, 78, 71]);
      const entry: MessageEntry = {
        id: "e-msg-2",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "user",
        content: "raw bytes",
        attachments: [{ type: "image", data: bytes, mimeType: "image/png", name: "raw.png" }],
        createdAt: 2000,
      };

      await store.appendEntries("sess-1", "th-1", [entry]);

      const loaded = await store.getEntries("sess-1", "th-1");
      const retrieved = loaded[0];
      if (retrieved.type !== "message") throw new Error("expected message entry");
      expect(retrieved.attachments).toHaveLength(1);
      const att = retrieved.attachments?.[0];
      // The discriminant must survive: a guard alone would silently skip
      // the round-trip assertions if persistence mangled the type.
      expect(att?.type).toBe("image");
      if (att?.type === "image") {
        expect(att.url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
        // The raw bytes do not survive JSON persistence; the data: URL replaces them.
        expect(att.data).toBeUndefined();
      }
    });

    it("leaves messages without attachments untouched", async () => {
      const entry: MessageEntry = {
        id: "e-msg-3",
        sessionId: "sess-1",
        threadId: "th-1",
        parentId: null,
        type: "message",
        role: "user",
        content: "plain",
        createdAt: 3000,
      };

      await store.appendEntries("sess-1", "th-1", [entry]);

      const loaded = await store.getEntries("sess-1", "th-1");
      const retrieved = loaded[0];
      if (retrieved.type !== "message") throw new Error("expected message entry");
      expect(retrieved.attachments).toBeUndefined();
    });
  });
}

describe("PGlite message attachments", () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);

  afterAll(async () => {
    await db.close();
  });

  runAttachmentSuite("PGlite", () => db);
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("docker-pg message attachments", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = pgDbFromPool(pool);

  afterAll(async () => {
    await db.close();
  });

  runAttachmentSuite("docker-pg", () => db);
});
