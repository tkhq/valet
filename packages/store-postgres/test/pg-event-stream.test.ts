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

  return { factory, fenceFixture: { seed } };
}

describe("PgEventStream (PGlite)", () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  const { factory, fenceFixture } = makeHarness(db);

  afterAll(async () => {
    await db.close();
  });

  runEventStreamContract("PgEventStream (PGlite)", { factory, fenceFixture });

  it("rejects a non-numeric fromOffset with ValidationError", async () => {
    const stream = await factory();
    await expect(stream.read("some-session", { fromOffset: "not-a-number" })).rejects.toThrow(ValidationError);
  });

  // The dense-gapless-sequence-under-concurrent-appends case (both
  // fence-less and cross-queue-item-fenced) is now covered by
  // `runConcurrencyContract` in `concurrency.pg.test.ts`, which promotes it
  // into the engine's exported suites (decision 6/11) so every backend
  // inherits it instead of each store re-deriving its own ad hoc version.
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("PgEventStream (docker-pg)", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = pgDbFromPool(pool);
  const { factory, fenceFixture } = makeHarness(db);

  afterAll(async () => {
    await db.close();
  });

  runEventStreamContract("PgEventStream (docker-pg)", { factory, fenceFixture });

  it("rejects a non-numeric fromOffset with ValidationError", async () => {
    const stream = await factory();
    await expect(stream.read("some-session", { fromOffset: "not-a-number" })).rejects.toThrow(ValidationError);
  });
});
