import { describe, it, expect } from "vitest";
import { StaleAttemptError } from "../errors.js";
import type {
  EngineEvent,
  EventStream,
  MessageEntry,
  QueueItem,
  SessionData,
  SessionStore,
  ThreadData,
} from "../index.js";

export interface ConcurrencyContractContext {
  /**
   * Builds one fresh, isolated `SessionStore` + `EventStream` pair that
   * share the same underlying connection/db handle (so fencing state
   * written through `store` is visible to `stream`'s fence checks, and vice
   * versa) — mirrors how `PgSessionStore`/`PgEventStream` and
   * `SqliteSessionStore`/`SqliteEventStream` are actually wired in
   * production (one db handle, two facades).
   */
  factory: () => Promise<{ store: SessionStore; stream: EventStream }> | { store: SessionStore; stream: EventStream };
  /**
   * Whether the backend can exhibit genuine cross-connection races.
   * - `true` (default): the suite runs and its assertions hold regardless —
   *   they check outcomes (gapless/unique seqs, fencing preserved), not
   *   interleaving. On backends with real concurrency (docker-pg, pooled
   *   node-postgres) this is the actual regression net for decision 6. On
   *   backends that structurally serialize every call onto one connection
   *   (PGlite: single WASM connection; better-sqlite3: synchronous driver,
   *   so `Promise.all` callers still execute one at a time on the JS event
   *   loop) the same assertions still pass, but they can't prove the
   *   locking actually defeats a race — they only prove sequential
   *   correctness under promise-interleaved calls. Both are documented,
   *   both are worth running: the "trivial" backends give a fast smoke test
   *   and catch outright breakage in the fencing/seq logic; only docker-pg
   *   proves the row-locking claims of decision 6.
   * - `false`: the target genuinely cannot run this suite at all (no known
   *   case in this codebase today — PGlite and sqlite both still execute it
   *   validly, just without proving true interleaving). Skips with a
   *   `describe.skip` so CI output makes the omission visible rather than
   *   silently absent.
   */
  supportsConcurrency?: boolean;
}

const N = 25;

/**
 * N for the fence-less same-session append test (test (a) below) only.
 *
 * That test is the sole dedicated guard of `PgEventStream.append`'s
 * `engine_sessions ... FOR UPDATE` seq-serialization lock: remove the lock
 * and two concurrent appends can both compute the same `MAX(seq)+1`, but
 * `append`'s belt-and-suspenders retry-once-on-23505 silently converts a
 * *single* collision into eventual success. At the default node-postgres
 * pool size (10), N=25 only produces ~2-3 windows of real cross-connection
 * concurrency, which mutation testing showed catches the removed lock only
 * ~60% of the time — not a reliable guard. Raising to 60+ appends, all
 * released from a single start gate so they hit the pool at once rather
 * than trickling in as the synchronous `Array.from` loop constructs them,
 * produces ~6 contention windows instead of ~2-3: with the lock removed,
 * the odds that *some* window has 3+ transactions racing the same
 * `MAX(seq)+1` (so a retried loser collides a second time and its 23505
 * escapes) become overwhelming.
 */
const FENCELESS_N = 60;

function turnEndEvent(sessionId: string, threadId: string, key: number): {
  sessionId: string;
  threadId: string;
  event: EngineEvent;
  timestamp: number;
} {
  return {
    sessionId,
    threadId,
    event: { type: "turn_end", threadId, reason: "end_turn" } as EngineEvent,
    timestamp: key,
  };
}

function baseSession(id: string): SessionData {
  const now = Date.now();
  return {
    id,
    owner: { type: "user", id: "u1" },
    userId: "u1",
    orgId: "o1",
    workspace: "/",
    purpose: "interactive",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

function baseThread(sessionId: string, id: string): ThreadData {
  const now = Date.now();
  return {
    id,
    sessionId,
    // engine_threads carries a UNIQUE(session_id, key) constraint — derive
    // the key from the thread id so multi-thread fixtures don't collide.
    key: `web:${id}`,
    status: "active",
    queueMode: "followup",
    createdAt: now,
    updatedAt: now,
  };
}

function baseItem(id: string, threadId: string): QueueItem {
  const now = Date.now();
  return {
    id,
    threadId,
    content: "hello",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: now + 3_600_000,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Admits + claims a fresh queue item under (sessionId, threadId), returning
 * its id and the winning attempt id. Callers must have already
 * `saveSession`/`saveThread`'d.
 */
async function admitAndClaim(
  store: SessionStore,
  sessionId: string,
  threadId: string,
  itemId: string,
  attemptId: string,
): Promise<void> {
  await store.admitSubmission(sessionId, threadId, baseItem(itemId, threadId));
  const claimed = await store.claimSubmission({
    sessionId,
    threadId,
    itemId,
    attemptId,
    ownerId: "owner-1",
  });
  if (!claimed) throw new Error(`concurrency-contract: admitAndClaim(${itemId}) failed to claim`);
}

export function runConcurrencyContract(name: string, ctx: ConcurrencyContractContext): void {
  const supportsConcurrency = ctx.supportsConcurrency ?? true;
  const d = supportsConcurrency ? describe : describe.skip;

  d(`Concurrency contract: ${name}`, () => {
    it(`N=${FENCELESS_N} concurrent same-session fence-less appends yield gapless unique seqs 1..${FENCELESS_N}`, async () => {
      const { store, stream } = await ctx.factory();
      const sessionId = "conc-fenceless";
      await store.saveSession(baseSession(sessionId));
      await store.saveThread(sessionId, baseThread(sessionId, "th-1"));

      // Start gate: every appender awaits the same not-yet-resolved promise
      // before calling `append`, so all FENCELESS_N calls are genuinely
      // released at once (they queue on the pg pool together) instead of
      // trickling in as the `Array.from` callback runs synchronously.
      let release: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const appends = Array.from({ length: FENCELESS_N }, async (_, i) => {
        await gate;
        return stream.append(turnEndEvent(sessionId, "th-1", i), `key-${i}`);
      });
      release!();
      await Promise.all(appends);

      const { events } = await stream.read(sessionId, { limit: FENCELESS_N + 10 });
      const seqs = events.map((e) => Number(e.offset)).sort((x, y) => x - y);
      expect(seqs).toHaveLength(FENCELESS_N);
      expect(new Set(seqs).size).toBe(FENCELESS_N);
      expect(seqs[0]).toBe(1);
      expect(seqs[FENCELESS_N - 1]).toBe(FENCELESS_N);
    });

    it(`concurrent appends fenced on two different queue items of one session yield gapless unique seqs 1..${N}`, async () => {
      const { store, stream } = await ctx.factory();
      const sessionId = "conc-fenced-two-items";
      const threadId = "th-1";
      await store.saveSession(baseSession(sessionId));
      await store.saveThread(sessionId, baseThread(sessionId, threadId));
      await admitAndClaim(store, sessionId, threadId, "item-1", "att-1");
      // Second item can't be claimed while the thread's head (item-1) is
      // still running (per-thread FIFO gating) — put it on its own thread so
      // both items are simultaneously claimable and fenceable.
      const threadId2 = "th-2";
      await store.saveThread(sessionId, baseThread(sessionId, threadId2));
      await admitAndClaim(store, sessionId, threadId2, "item-2", "att-2");

      const half = Math.floor(N / 2);
      const appends: Promise<{ offset: string }>[] = [];
      for (let i = 0; i < half; i++) {
        appends.push(
          stream.append(turnEndEvent(sessionId, threadId, i), `item1-${i}`, { itemId: "item-1", attemptId: "att-1" }),
        );
      }
      for (let i = 0; i < N - half; i++) {
        appends.push(
          stream.append(turnEndEvent(sessionId, threadId2, i), `item2-${i}`, {
            itemId: "item-2",
            attemptId: "att-2",
          }),
        );
      }
      await Promise.all(appends);

      const { events } = await stream.read(sessionId, { limit: N + 10 });
      const seqs = events.map((e) => Number(e.offset)).sort((x, y) => x - y);
      expect(seqs).toHaveLength(N);
      expect(new Set(seqs).size).toBe(N);
      expect(seqs[0]).toBe(1);
      expect(seqs[N - 1]).toBe(N);
    });

    it("concurrent fenced updateEntry vs replaceSubmissionAttempt preserves fencing: stale writer gets StaleAttemptError, no partial write", async () => {
      const { store } = await ctx.factory();
      const sessionId = "conc-fence-race";
      await store.saveSession(baseSession(sessionId));

      // Run N independent trials concurrently: each trial races an
      // updateEntry fenced on the item's current attempt against a
      // replaceSubmissionAttempt that swaps that same attempt out from
      // under it. Whichever transaction's row lock wins determines the
      // outcome, but every trial must land in exactly one of two clean
      // states — never a torn mix of "content updated" + "attempt not
      // actually swapped" or vice versa.
      const trials = await Promise.all(
        Array.from({ length: N }, async (_, i) => {
          const threadId = `th-race-${i}`;
          const itemId = `item-race-${i}`;
          const entryId = `entry-race-${i}`;
          await store.saveThread(sessionId, baseThread(sessionId, threadId));
          await admitAndClaim(store, sessionId, threadId, itemId, "att-A");

          const before: MessageEntry = {
            id: entryId,
            sessionId,
            threadId,
            parentId: null,
            type: "message",
            role: "user",
            content: "before",
            createdAt: Date.now(),
            queueItemId: itemId,
          };
          await store.appendEntries(sessionId, threadId, [before], { itemId, attemptId: "att-A" });

          const after: MessageEntry = { ...before, content: "after" };

          const [updateOutcome, replaceOutcome] = await Promise.allSettled([
            store.updateEntry(sessionId, threadId, after, { itemId, attemptId: "att-A" }),
            store.replaceSubmissionAttempt(
              sessionId,
              threadId,
              itemId,
              { sessionId, threadId, itemId, attemptId: "att-B", ownerId: "owner-2" },
              { expectedAttemptId: "att-A" },
            ),
          ]);

          const entries = await store.getEntries(sessionId, threadId);
          const loadedEntry = entries.find((e) => e.id === entryId);
          if (!loadedEntry || loadedEntry.type !== "message") {
            throw new Error(`trial ${i}: entry ${entryId} missing or wrong type after race`);
          }

          return { i, updateOutcome, replaceOutcome, finalContent: loadedEntry.content };
        }),
      );

      for (const { i, updateOutcome, replaceOutcome, finalContent } of trials) {
        // replaceSubmissionAttempt is the sole writer of the attempt field
        // in each trial (no other concurrent claimant), so its CAS against
        // the correct expectedAttemptId must always win.
        expect(replaceOutcome.status, `trial ${i}: replaceSubmissionAttempt should not throw`).toBe("fulfilled");
        if (replaceOutcome.status === "fulfilled") {
          expect(replaceOutcome.value, `trial ${i}: replaceSubmissionAttempt should succeed (non-null)`).not.toBeNull();
        }

        if (updateOutcome.status === "fulfilled") {
          // updateEntry's fence check observed att-A still current (it
          // acquired the row lock before replaceSubmissionAttempt's CAS
          // committed) — the write must have taken effect.
          expect(finalContent, `trial ${i}: updateEntry fulfilled but content wasn't updated`).toBe("after");
        } else {
          // updateEntry lost the race: replaceSubmissionAttempt's CAS
          // committed first, so by the time updateEntry's fence check ran,
          // att-A was no longer current. It must fail with exactly
          // StaleAttemptError, and must not have written anything.
          expect(updateOutcome.reason, `trial ${i}: updateEntry should reject with StaleAttemptError`).toBeInstanceOf(
            StaleAttemptError,
          );
          expect(finalContent, `trial ${i}: updateEntry rejected but content changed anyway (partial write)`).toBe(
            "before",
          );
        }
      }
    });
  });
}
