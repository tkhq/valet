import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runEventStreamContract } from "@valet/engine/test-helpers";
import { ValidationError } from "@valet/engine";
import type { QueueItem } from "@valet/engine";
import { pgDbFromPglite, pgDbFromPool, type PgDb } from "../src/db.js";
import { PgEventStream } from "../src/event-stream.js";
import { applyEngineMigrations } from "../src/migrate.js";
import { PgSessionStore } from "../src/store.js";

// Tables the store/stream touch, in FK-safe truncate order. engine_meta and
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

const FENCE_SESSION = "fence-sess";
const FENCE_THREAD = "fence-thread";

/**
 * Builds a `factory()` + `fenceFixture.seed()` pair for
 * `runEventStreamContract`, reusing ONE underlying `PgDb` across every test
 * in the describe block (decision 11: PGlite's wasm heap isn't reliably
 * released on `close()`, and matches how `pg-store.test.ts` shares a single
 * instance). Migrations run once; every subsequent `factory()` call
 * truncates data tables instead, giving each contract test the same
 * blank-slate guarantee a fresh `:memory:` sqlite db gave.
 */
function makeHarness(db: PgDb): {
  factory: () => Promise<PgEventStream>;
  fenceFixture: { seed: (itemId: string) => Promise<{ currentAttemptId: string }> };
  /**
   * Creates the `engine_sessions` row `append`'s seq-allocation lock
   * (`SELECT ... FOR UPDATE` on `engine_sessions`, decision 6) depends on
   * existing. Real callers always create the session via `saveSession`
   * before threads/queue items/events exist for it — a concurrency test
   * that skips this step gives `append` nothing to lock, so concurrent
   * inserts race unserialized and can hit Postgres's documented
   * concurrent-duplicate-key deadlock pattern on the `(session_id, seq)` PK.
   */
  seedSession: (sessionId: string) => Promise<void>;
} {
  let migrated = false;
  let currentStore: PgSessionStore | undefined;

  const factory = async (): Promise<PgEventStream> => {
    if (!migrated) {
      await applyEngineMigrations(db);
      migrated = true;
    } else {
      await truncateAll(db);
    }
    currentStore = new PgSessionStore(db);
    return new PgEventStream(db);
  };

  const seedSession = async (sessionId: string): Promise<void> => {
    const store = currentStore;
    if (!store) throw new Error("seedSession called before factory()");
    const now = Date.now();
    await store.saveSession({
      id: sessionId,
      owner: { type: "user", id: "u1" },
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      purpose: "interactive",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
  };

  const seed = async (itemId: string): Promise<{ currentAttemptId: string }> => {
    const store = currentStore;
    if (!store) throw new Error("fenceFixture.seed called before factory()");
    const now = Date.now();
    await store.saveSession({
      id: FENCE_SESSION,
      owner: { type: "user", id: "u1" },
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      purpose: "interactive",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    await store.saveThread(FENCE_SESSION, {
      id: FENCE_THREAD,
      sessionId: FENCE_SESSION,
      key: "web:default",
      status: "active",
      queueMode: "followup",
      createdAt: now,
      updatedAt: now,
    });
    const admitItem: QueueItem = {
      id: itemId,
      threadId: FENCE_THREAD,
      content: "seed submission",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: now + 3_600_000,
      createdAt: now,
      updatedAt: now,
    };
    await store.admitSubmission(FENCE_SESSION, FENCE_THREAD, admitItem);
    const attemptId = `att-${itemId}`;
    const claimed = await store.claimSubmission({
      sessionId: FENCE_SESSION,
      threadId: FENCE_THREAD,
      itemId,
      attemptId,
      ownerId: "owner-1",
    });
    if (!claimed) throw new Error("fenceFixture.seed: claim failed");
    return { currentAttemptId: attemptId };
  };

  return { factory, fenceFixture: { seed }, seedSession };
}

describe("PgEventStream (PGlite)", () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  const { factory, fenceFixture, seedSession } = makeHarness(db);

  afterAll(async () => {
    await db.close();
  });

  runEventStreamContract("PgEventStream (PGlite)", { factory, fenceFixture });

  it("rejects a non-numeric fromOffset with ValidationError", async () => {
    const stream = await factory();
    await expect(stream.read("some-session", { fromOffset: "not-a-number" })).rejects.toThrow(ValidationError);
  });

  it(
    "produces a dense gapless sequence under concurrent same-process appends",
    async () => {
      const stream = await factory();
      const sessionId = "concurrent-session";
      await seedSession(sessionId);

      const appends: Promise<{ offset: string }>[] = [];
      for (let i = 0; i < 50; i++) {
        appends.push(stream.append({ sessionId, threadId: "th-1", event: { type: "turn_end", threadId: "th-1", reason: "end_turn" }, timestamp: i }, `a-${i}`));
        appends.push(stream.append({ sessionId, threadId: "th-1", event: { type: "turn_end", threadId: "th-1", reason: "end_turn" }, timestamp: i }, `b-${i}`));
      }
      await Promise.all(appends);

      const { events } = await stream.read(sessionId, { limit: 500 });
      const seqs = events.map((e) => Number(e.offset)).sort((x, y) => x - y);
      expect(seqs).toHaveLength(100);
      expect(new Set(seqs).size).toBe(100);
      expect(seqs[0]).toBe(1);
      expect(seqs[99]).toBe(100);
    },
    30_000,
  );
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("PgEventStream (docker-pg)", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = pgDbFromPool(pool);
  const { factory, fenceFixture, seedSession } = makeHarness(db);

  afterAll(async () => {
    await db.close();
  });

  runEventStreamContract("PgEventStream (docker-pg)", { factory, fenceFixture });

  it("rejects a non-numeric fromOffset with ValidationError", async () => {
    const stream = await factory();
    await expect(stream.read("some-session", { fromOffset: "not-a-number" })).rejects.toThrow(ValidationError);
  });

  it(
    "produces a dense gapless sequence under concurrent appends from pooled connections",
    async () => {
      const stream = await factory();
      const sessionId = "concurrent-session-pool";
      await seedSession(sessionId);

      const appends: Promise<{ offset: string }>[] = [];
      for (let i = 0; i < 50; i++) {
        appends.push(stream.append({ sessionId, threadId: "th-1", event: { type: "turn_end", threadId: "th-1", reason: "end_turn" }, timestamp: i }, `a-${i}`));
        appends.push(stream.append({ sessionId, threadId: "th-1", event: { type: "turn_end", threadId: "th-1", reason: "end_turn" }, timestamp: i }, `b-${i}`));
      }
      await Promise.all(appends);

      const { events } = await stream.read(sessionId, { limit: 500 });
      const seqs = events.map((e) => Number(e.offset)).sort((x, y) => x - y);
      expect(seqs).toHaveLength(100);
      expect(new Set(seqs).size).toBe(100);
      expect(seqs[0]).toBe(1);
      expect(seqs[99]).toBe(100);
    },
    30_000,
  );
});
