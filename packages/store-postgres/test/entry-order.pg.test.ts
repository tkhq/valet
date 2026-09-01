import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MessageEntry } from "@valet/engine";
import { pgDbFromPool, type PgDb } from "../src/db.js";
import { applyEngineMigrations } from "../src/migrate.js";
import { PgSessionStore } from "../src/store.js";

/**
 * Deterministic reproduction of TKAI-303: getEntries returned same-millisecond
 * entries out of insertion order because created_at was the only sort key.
 *
 * The bug is a NON-guarantee, not a wrong answer: with only created_at in the
 * ORDER BY, Postgres MAY return a tie in any order, and on a small test table
 * the default index-scan plan happens to preserve insertion order — which is
 * why the shared store contract passes even against a real backend without the
 * fix. To expose the ambiguity every run, this suite pins the planner to a
 * sequential scan, then rewrites the first entry so its heap tuple physically
 * follows the second. Under a seqscan a created_at-only read then returns them
 * reversed. The seq tiebreaker restores insertion order regardless of plan.
 *
 * PGlite cannot host this: it preserves insertion order like the in-memory
 * store, so only the real-Postgres (docker-pg / CI remote-postgres) backend
 * earns the guarantee. The suite is skipped when TEST_DATABASE_URL is unset.
 *
 * The e2e test-pg run shares ONE Postgres across every store-postgres test
 * file, so this file must not collide with the others: it uses ids unique to
 * itself and never truncates. getEntries filters by session + thread, so rows
 * from other files never reach the assertions, and this file never wipes
 * theirs. seq is a global counter, but the pair is appended here in order, so
 * e-first keeps a lower seq than e-second no matter how other files interleave.
 */

const SESSION_ID = "sess-tkai303-order";
const THREAD_ID = "th-tkai303-order";

function msg(id: string, role: "user" | "assistant", content: string, createdAt: number): MessageEntry {
  return {
    id,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    parentId: null,
    type: "message",
    role,
    content,
    createdAt,
  };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("engine_entries same-millisecond order (docker-pg)", () => {
  // Force sequential scans for EVERY connection in the pool so the read plan
  // exposes heap order — the deterministic stand-in for the planner choices
  // and heap churn that trigger the tie in a long production thread.
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: "-c enable_indexscan=off -c enable_bitmapscan=off",
  });
  const db: PgDb = pgDbFromPool(pool);
  let store: PgSessionStore;

  beforeAll(async () => {
    await applyEngineMigrations(db);
    store = new PgSessionStore(db);
    await store.saveSession({
      id: SESSION_ID,
      owner: { type: "user", id: "u1" },
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      purpose: "interactive",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    });
    await store.saveThread(SESSION_ID, {
      id: THREAD_ID,
      sessionId: SESSION_ID,
      key: "web:default",
      status: "active",
      queueMode: "followup",
      createdAt: 1,
      updatedAt: 1,
    });
  });

  afterAll(async () => {
    await db.close();
  });

  it("returns a same-millisecond pair in insertion order after the first is rewritten", async () => {
    // A tool result and the assistant reply that follows it land in the same
    // millisecond. The assistant entry's parts are re-persisted after
    // message_end, which is an in-place update that rewrites created_at and so
    // moves the row's heap tuple. Under the pinned seqscan that move is what
    // reordered the read before the fix.
    await store.appendEntries(SESSION_ID, THREAD_ID, [
      msg("e-first", "user", "first", 1000),
      msg("e-second", "assistant", "second", 1000),
    ]);
    await store.updateEntry(SESSION_ID, THREAD_ID, msg("e-first", "user", "first (edited)", 1000));

    const loaded = await store.getEntries(SESSION_ID, THREAD_ID);
    expect(loaded.map((e) => e.id)).toEqual(["e-first", "e-second"]);
    expect(loaded[0]).toMatchObject({ id: "e-first", content: "first (edited)" });
  });
});
