import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { runConcurrencyContract } from "@valet/engine/test-helpers";
import type { MessageEntry, QueueItem } from "@valet/engine";
import { isPgDeadlock, pgDbFromPglite, pgDbFromPool, type PgDb } from "../src/db.js";
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

/**
 * Builds a `factory()` for `runConcurrencyContract` that reuses ONE
 * underlying `PgDb` across every test in the describe block (decision 11 +
 * the Task 0 finding that PGlite's wasm heap isn't reliably released on
 * `close()` — matches `pg-store.test.ts`/`pg-event-stream.test.ts`).
 * Migrations run once; every subsequent `factory()` call truncates data
 * tables, giving each contract test the same blank-slate guarantee a fresh
 * `:memory:` sqlite db gave.
 */
function makeHarness(db: PgDb): {
  factory: () => Promise<{ store: PgSessionStore; stream: PgEventStream }>;
} {
  let migrated = false;
  return {
    factory: async () => {
      if (!migrated) {
        await applyEngineMigrations(db);
        migrated = true;
      } else {
        await truncateAll(db);
      }
      return { store: new PgSessionStore(db), stream: new PgEventStream(db) };
    },
  };
}

describe("Concurrency contract (PGlite)", () => {
  const pglite = new PGlite();
  const db = pgDbFromPglite(pglite);
  const { factory } = makeHarness(db);

  afterAll(async () => {
    await db.close();
  });

  // PGlite is single-connection: its `transaction()` serializes whole
  // transactions against that one connection (decision 4), so two
  // concurrent store/stream calls never truly interleave here — this run
  // proves sequential correctness of the seq/fencing logic (a fast smoke
  // test), not that the row-locking actually defeats a race. Still worth
  // running: it catches outright breakage cheaply, every `pnpm test` run,
  // with no Docker dependency.
  runConcurrencyContract("PgStore+PgEventStream (PGlite)", { factory });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("Concurrency contract (docker-pg)", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = pgDbFromPool(pool);
  const { factory } = makeHarness(db);

  afterAll(async () => {
    await db.close();
  });

  // Real pooled connections: this is the actual regression net for decision
  // 6's row-locking claims — the only backend where these races can
  // genuinely manifest.
  runConcurrencyContract("PgStore+PgEventStream (docker-pg)", { factory });

  function baseSession(id: string) {
    const now = Date.now();
    return {
      id,
      owner: { type: "user" as const, id: "u1" },
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      purpose: "interactive" as const,
      status: "running" as const,
      createdAt: now,
      updatedAt: now,
    };
  }

  function baseThread(sessionId: string, id: string) {
    const now = Date.now();
    return {
      id,
      sessionId,
      // engine_threads carries UNIQUE(session_id, key) — derive from the id.
      key: `web:${id}`,
      status: "active" as const,
      queueMode: "followup" as const,
      createdAt: now,
      updatedAt: now,
    };
  }

  function makeItem(id: string, threadId: string, createdAt: number): QueueItem {
    return {
      id,
      threadId,
      content: "hello",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: createdAt + 3_600_000,
      createdAt,
      updatedAt: createdAt,
    };
  }

  // Task-3-review finding: appendEntries (locks the fenced queue-item row,
  // then touches engine_threads) and admitSubmission with steer:true (locks
  // engine_threads, then touches the queue-item rows it supersedes) take
  // their two lock roots in opposite order. When a steer admission
  // supersedes the exact item another writer has fenced, the two can form a
  // real ABBA cycle. Postgres detects and aborts one side with 40P01; the
  // fix (packages/store-postgres/src/db.ts `pgDbFromPool.transaction`)
  // retries that side's transaction once. This test provokes the cycle
  // directly (not just "eventually races enough to maybe hit it") and
  // asserts neither call ever surfaces a raw 40P01 to its caller.
  it(
    "appendEntries<->admitSubmission ABBA deadlock is retried transparently, never escapes as raw 40P01",
    async () => {
      const { store, stream } = await factory();
      const sessionId = "abba-sess";
      await store.saveSession(baseSession(sessionId));

      const iterations = 20;
      // Fresh thread per iteration: a steer item left queued by iteration i
      // would otherwise become the thread's FIFO head and block iteration
      // i+1's claim. The deadlock geometry is per-thread anyway (item row vs
      // that thread's engine_threads row), so isolation loses nothing.
      for (let i = 0; i < iterations; i++) {
        const now = Date.now();
        const threadId = `abba-thread-${i}`;
        const itemId = `abba-item-${i}`;
        const attemptId = `abba-att-${i}`;
        await store.saveThread(sessionId, baseThread(sessionId, threadId));
        await store.admitSubmission(sessionId, threadId, makeItem(itemId, threadId, now));
        const claimed = await store.claimSubmission({
          sessionId,
          threadId,
          itemId,
          attemptId,
          ownerId: "owner-1",
        });
        if (!claimed) throw new Error(`iteration ${i}: failed to claim ${itemId}`);

        const entry: MessageEntry = {
          id: `abba-entry-${i}`,
          sessionId,
          threadId,
          parentId: null,
          type: "message",
          role: "user",
          content: `entry ${i}`,
          createdAt: now,
          queueItemId: itemId,
        };

        // Tx A: locks itemId (FOR UPDATE via the fence check), then updates
        // the engine_threads row.
        const appendPromise = store.appendEntries(sessionId, threadId, [entry], { itemId, attemptId });
        // Tx B: locks the engine_threads row first, then (steer) updates
        // itemId's superseded_by_item_id — the opposite lock order.
        const steerItem = makeItem(`abba-steer-${i}`, threadId, now + 1);
        const admitPromise = store.admitSubmission(sessionId, threadId, steerItem, { steer: true });

        const [appendResult, admitResult] = await Promise.allSettled([appendPromise, admitPromise]);

        for (const [label, outcome] of [
          ["appendEntries", appendResult],
          ["admitSubmission", admitResult],
        ] as const) {
          if (outcome.status === "rejected") {
            expect(
              isPgDeadlock(outcome.reason),
              `iteration ${i}: ${label} rejected with a raw, unretried deadlock: ${String(outcome.reason)}`,
            ).toBe(false);
            throw outcome.reason;
          }
        }
      }

      // Sanity: every iteration's entry actually landed (appendEntries never
      // silently dropped a write while "succeeding").
      for (let i = 0; i < iterations; i++) {
        const entries = await store.getEntries(sessionId, `abba-thread-${i}`);
        expect(entries.map((e) => e.id), `iteration ${i}`).toEqual([`abba-entry-${i}`]);
      }
      // And the event stream (sharing the same db handle) is still usable —
      // the deadlock loop didn't leave the connection/pool in a broken state.
      await stream.append(
        {
          sessionId,
          threadId: "abba-thread-0",
          event: { type: "turn_end", threadId: "abba-thread-0", reason: "end_turn" },
          timestamp: Date.now(),
        },
        "abba-final-key",
      );
    },
    60_000,
  );

  // Task-3-review finding: admitSubmission's per-thread lock (engine_threads
  // WHERE id = threadId) doesn't serialize a dispatchId dedup check across
  // *different* threads of the same session — only the
  // (session_id, dispatch_id) partial unique index actually arbitrates that
  // race. Two admissions on different threads racing the same dispatchId
  // can both pass the in-transaction pre-check and both attempt the insert;
  // the loser must dedup against the winner's row (23505 caught via
  // isPgUniqueViolation), not propagate a raw constraint violation.
  it("admitSubmission dedups a same-dispatchId race across two different threads instead of throwing", async () => {
    const { store } = await factory();
    const sessionId = "dedup-race-sess";
    const threadA = "dedup-race-thread-a";
    const threadB = "dedup-race-thread-b";
    await store.saveSession(baseSession(sessionId));
    await store.saveThread(sessionId, baseThread(sessionId, threadA));
    await store.saveThread(sessionId, baseThread(sessionId, threadB));

    const now = Date.now();
    const dispatchId = "dedup-race-dispatch";
    const content = "raced content";

    const results = await Promise.allSettled([
      store.admitSubmission(sessionId, threadA, {
        ...makeItem("dedup-race-item-a", threadA, now),
        dispatchId,
        content,
      }),
      store.admitSubmission(sessionId, threadB, {
        ...makeItem("dedup-race-item-b", threadB, now),
        dispatchId,
        content,
      }),
    ]);

    // Both calls must resolve — one admits, the other dedups against it.
    // Neither may reject with a raw unique-violation.
    for (const [i, outcome] of results.entries()) {
      expect(outcome.status, `admission ${i} rejected: ${outcome.status === "rejected" ? String(outcome.reason) : ""}`).toBe(
        "fulfilled",
      );
    }
    const values = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    const admittedCount = values.filter((v) => v?.admitted).length;
    const dedupedCount = values.filter((v) => v && !v.admitted).length;
    expect(admittedCount).toBe(1);
    expect(dedupedCount).toBe(1);
    // Both calls agree on the same underlying item id.
    const ids = new Set(values.map((v) => v?.item.id));
    expect(ids.size).toBe(1);
  });
});
