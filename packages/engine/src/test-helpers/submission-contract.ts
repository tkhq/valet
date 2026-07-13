import { describe, it, expect, beforeEach } from "vitest";
import { ConflictError, StaleAttemptError } from "../errors.js";
import type {
  MessageEntry,
  QueueItem,
  SessionData,
  SessionStore,
  SuspendedTurnState,
  ThreadData,
  WriteFence,
} from "../types.js";
import type { StoreContractContext } from "./store-contract.js";

const SESSION_ID = "sess-1";
const THREAD_ID = "th-1";

let nextId = 1;
function uid(prefix: string): string {
  return `${prefix}-${(nextId++).toString(36)}`;
}

export function runSubmissionLifecycleContract(name: string, ctx: StoreContractContext): void {
  describe(`submission lifecycle contract: ${name}`, () => {
    let store: SessionStore;

    function newSession(overrides: Partial<SessionData> = {}): SessionData {
      return {
        id: SESSION_ID,
        owner: { type: "user", id: "u1" },
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        purpose: "interactive",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      };
    }

    function newThread(id = THREAD_ID, key = "web:default"): ThreadData {
      return {
        id,
        sessionId: SESSION_ID,
        key,
        status: "active",
        queueMode: "followup",
        createdAt: 1,
        updatedAt: 1,
      };
    }

    function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
      const now = overrides.createdAt ?? Date.now();
      return {
        id: uid("q"),
        threadId: THREAD_ID,
        content: "hello",
        status: "queued",
        attemptCount: 0,
        maxAttempts: 10,
        timeoutAt: now + 3_600_000,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
    }

    beforeEach(async () => {
      store = await ctx.factory();
      await store.saveSession(newSession());
      await store.saveThread(SESSION_ID, newThread());
    });

    // --- Admission ---

    it("admits and reads back a submission", async () => {
      const item = makeItem();
      const result = await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      expect(result.admitted).toBe(true);
      expect(result.supersededItemIds).toEqual([]);
      expect(result.item).toEqual(item);
      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded).toEqual(item);
    });

    it("same dispatchId + same content returns the original item, admitted=false", async () => {
      const item = makeItem({ dispatchId: "dispatch-1", content: "same text" });
      const first = await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      expect(first.admitted).toBe(true);

      const dup = makeItem({ dispatchId: "dispatch-1", content: "same text" });
      const second = await store.admitSubmission(SESSION_ID, THREAD_ID, dup);
      expect(second.admitted).toBe(false);
      expect(second.item).toEqual(first.item);
    });

    it("same dispatchId + different content throws ConflictError", async () => {
      const item = makeItem({ dispatchId: "dispatch-2", content: "text A" });
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);

      const different = makeItem({ dispatchId: "dispatch-2", content: "text B" });
      await expect(store.admitSubmission(SESSION_ID, THREAD_ID, different)).rejects.toThrow(
        ConflictError,
      );
    });

    it("mutating an admitted item's returned copy does not leak into store state", async () => {
      const item = makeItem({ dispatchId: "dispatch-alias", content: "alias check" });
      const admitted = await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      expect(admitted.admitted).toBe(true);
      admitted.item.status = "settled"; // mutate the returned object
      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("queued");

      // Same check on the admitted:false dedup path's returned item.
      const dup = makeItem({ dispatchId: "dispatch-alias", content: "alias check" });
      const deduped = await store.admitSubmission(SESSION_ID, THREAD_ID, dup);
      expect(deduped.admitted).toBe(false);
      deduped.item.status = "settled";
      const reloaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(reloaded?.status).toBe("queued");
    });

    it("items without dispatchId always admit", async () => {
      const a = makeItem({ content: "same text" });
      const b = makeItem({ content: "same text" });
      const resA = await store.admitSubmission(SESSION_ID, THREAD_ID, a);
      const resB = await store.admitSubmission(SESSION_ID, THREAD_ID, b);
      expect(resA.admitted).toBe(true);
      expect(resB.admitted).toBe(true);
      expect(resA.item.id).not.toBe(resB.item.id);
    });

    it("empty-string dispatchId is treated as absent: both admit, no dedup", async () => {
      // SQLite's partial unique index would treat "" as a present value; the
      // in-memory guard would treat it as absent. Both backends must normalize
      // "" to "no idempotency key" so a second "" admission never dedups.
      const a = makeItem({ dispatchId: "", content: "same text" });
      const b = makeItem({ dispatchId: "", content: "same text" });
      const resA = await store.admitSubmission(SESSION_ID, THREAD_ID, a);
      const resB = await store.admitSubmission(SESSION_ID, THREAD_ID, b);
      expect(resA.admitted).toBe(true);
      expect(resB.admitted).toBe(true);
      expect(resA.item.id).not.toBe(resB.item.id);
    });

    // --- Claim (CAS + FIFO head) ---

    it("claims the head: queued→running with attemptId/ownerId/lease, attemptCount=1", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "owner-1",
      });
      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe("running");
      expect(claimed?.attemptId).toBe("att-1");
      expect(claimed?.ownerId).toBe("owner-1");
      expect(claimed?.attemptCount).toBe(1);
      expect(claimed?.leaseExpiresAt).toBeGreaterThan(Date.now());
    });

    it("second concurrent claim for the same item returns null", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claim = { sessionId: SESSION_ID, threadId: THREAD_ID, itemId: item.id, ownerId: "o" };
      const first = await store.claimSubmission({ ...claim, attemptId: "att-a" });
      const second = await store.claimSubmission({ ...claim, attemptId: "att-b" });
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it("cannot claim a non-head item (FIFO gating)", async () => {
      const a = makeItem({ createdAt: 100, updatedAt: 100 });
      const b = makeItem({ createdAt: 200, updatedAt: 200 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, a);
      await store.admitSubmission(SESSION_ID, THREAD_ID, b);

      const claimB = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: b.id,
        attemptId: "att-b",
        ownerId: "o",
      });
      expect(claimB).toBeNull();

      const claimA = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: a.id,
        attemptId: "att-a",
        ownerId: "o",
      });
      expect(claimA).not.toBeNull();
      expect(claimA?.id).toBe(a.id);
    });

    it("same-createdAt items claim in id order (lexicographic tiebreaker), independent of insertion order", async () => {
      // Insertion order (b then a) deliberately differs from id order (a < b) so
      // a pure insertion/Map-order scan would pick the wrong head. Both backends
      // must break the createdAt tie on id (SQLite: ORDER BY created_at, id).
      const later = makeItem({ id: "q-zzz", createdAt: 500, updatedAt: 500 });
      const earlier = makeItem({ id: "q-aaa", createdAt: 500, updatedAt: 500 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, later);
      await store.admitSubmission(SESSION_ID, THREAD_ID, earlier);

      // The larger id is not the head — its claim is refused.
      const claimLater = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: later.id,
        attemptId: "att-z",
        ownerId: "o",
      });
      expect(claimLater).toBeNull();

      // The smaller id is the head — it claims.
      const claimEarlier = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: earlier.id,
        attemptId: "att-a",
        ownerId: "o",
      });
      expect(claimEarlier).not.toBeNull();
      expect(claimEarlier?.id).toBe(earlier.id);
    });

    it("a superseded queued item is skipped for head selection", async () => {
      const a = makeItem({ createdAt: 100, updatedAt: 100 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, a);
      const s = makeItem({ createdAt: 200, updatedAt: 200 });
      const admitS = await store.admitSubmission(SESSION_ID, THREAD_ID, s, { steer: true });
      expect(admitS.supersededItemIds).toContain(a.id);

      const claimS = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: s.id,
        attemptId: "att-s",
        ownerId: "o",
      });
      expect(claimS).not.toBeNull();
      expect(claimS?.id).toBe(s.id);
    });

    it("collecting items do not block head-claim", async () => {
      const c = makeItem({ status: "collecting", createdAt: 100, updatedAt: 100 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, c);
      const b = makeItem({ createdAt: 200, updatedAt: 200 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, b);

      const claimB = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: b.id,
        attemptId: "att-b",
        ownerId: "o",
      });
      expect(claimB).not.toBeNull();
      expect(claimB?.id).toBe(b.id);
    });

    it("cannot claim the next item while the head is running", async () => {
      const a = makeItem({ createdAt: 100, updatedAt: 100 });
      const b = makeItem({ createdAt: 200, updatedAt: 200 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, a);
      await store.admitSubmission(SESSION_ID, THREAD_ID, b);

      const claimedA = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: a.id,
        attemptId: "att-a",
        ownerId: "o",
      });
      expect(claimedA?.status).toBe("running");

      const claimB = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: b.id,
        attemptId: "att-b",
        ownerId: "o2",
      });
      expect(claimB).toBeNull();
      expect((await store.getQueueItem(SESSION_ID, b.id))?.status).toBe("queued");
    });

    it("cannot claim while the head is blocked_on_decision_gate", async () => {
      const a = makeItem({ createdAt: 100, updatedAt: 100 });
      const b = makeItem({ createdAt: 200, updatedAt: 200 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, a);

      const claimedA = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: a.id,
        attemptId: "att-a",
        ownerId: "o",
      });
      const fence: WriteFence = { itemId: a.id, attemptId: claimedA!.attemptId! };
      await store.setSubmissionBlocked(SESSION_ID, THREAD_ID, a.id, true, fence);
      expect((await store.getQueueItem(SESSION_ID, a.id))?.status).toBe(
        "blocked_on_decision_gate",
      );

      await store.admitSubmission(SESSION_ID, THREAD_ID, b);
      const claimB = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: b.id,
        attemptId: "att-b",
        ownerId: "o2",
      });
      expect(claimB).toBeNull();
      expect((await store.getQueueItem(SESSION_ID, b.id))?.status).toBe("queued");
    });

    it("cannot claim while the head is terminalizing", async () => {
      const a = makeItem({ createdAt: 100, updatedAt: 100 });
      const b = makeItem({ createdAt: 200, updatedAt: 200 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, a);

      const claimedA = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: a.id,
        attemptId: "att-a",
        ownerId: "o",
      });
      const fence: WriteFence = { itemId: a.id, attemptId: claimedA!.attemptId! };
      await store.reserveSettlement(SESSION_ID, THREAD_ID, a.id, { outcome: "completed" }, fence);
      expect((await store.getQueueItem(SESSION_ID, a.id))?.status).toBe("terminalizing");

      await store.admitSubmission(SESSION_ID, THREAD_ID, b);
      const claimB = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: b.id,
        attemptId: "att-b",
        ownerId: "o2",
      });
      expect(claimB).toBeNull();
      expect((await store.getQueueItem(SESSION_ID, b.id))?.status).toBe("queued");

      await store.finalizeSettlement(SESSION_ID, THREAD_ID, a.id, fence);
      expect((await store.getQueueItem(SESSION_ID, a.id))?.status).toBe("settled");

      const claimBAfter = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: b.id,
        attemptId: "att-b2",
        ownerId: "o3",
      });
      expect(claimBAfter).not.toBeNull();
      expect(claimBAfter?.id).toBe(b.id);
      expect(claimBAfter?.status).toBe("running");
    });

    // --- Steer supersession (atomic) ---

    it("steer admission stamps supersededByItemId on prior unsettled items and returns their ids", async () => {
      const a = makeItem({ createdAt: 100, updatedAt: 100 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, a);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: a.id,
        attemptId: "att-a",
        ownerId: "o",
      });
      const b = makeItem({ createdAt: 200, updatedAt: 200 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, b);

      const s = makeItem({ createdAt: 300, updatedAt: 300 });
      const admitS = await store.admitSubmission(SESSION_ID, THREAD_ID, s, { steer: true });
      expect(admitS.supersededItemIds.sort()).toEqual([a.id, b.id].sort());

      const loadedA = await store.getQueueItem(SESSION_ID, a.id);
      const loadedB = await store.getQueueItem(SESSION_ID, b.id);
      const loadedS = await store.getQueueItem(SESSION_ID, s.id);
      expect(loadedA?.supersededByItemId).toBe(s.id);
      expect(loadedB?.supersededByItemId).toBe(s.id);
      expect(loadedS?.supersededByItemId).toBeUndefined();
    });

    it("steer does not stamp settled items or items admitted after it", async () => {
      const settled = makeItem({ createdAt: 100, updatedAt: 100 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, settled);
      const settleOk = await store.settleUnclaimed(SESSION_ID, THREAD_ID, settled.id, {
        outcome: "aborted",
      });
      expect(settleOk).toBe(true);

      const s = makeItem({ createdAt: 200, updatedAt: 200 });
      const admitS = await store.admitSubmission(SESSION_ID, THREAD_ID, s, { steer: true });
      expect(admitS.supersededItemIds).not.toContain(settled.id);

      const after = makeItem({ createdAt: 300, updatedAt: 300 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, after);
      const loadedAfter = await store.getQueueItem(SESSION_ID, after.id);
      expect(loadedAfter?.supersededByItemId).toBeUndefined();
    });

    // --- Fencing ---

    it("appendEntries with the current attempt's fence succeeds; entry round-trips queueItemId", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      const fence: WriteFence = { itemId: item.id, attemptId: claimed!.attemptId! };
      const entry: MessageEntry = {
        id: uid("e"),
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        parentId: null,
        type: "message",
        role: "user",
        content: "hi",
        createdAt: Date.now(),
        queueItemId: item.id,
      };
      await store.appendEntries(SESSION_ID, THREAD_ID, [entry], fence);
      const entries = await store.getEntries(SESSION_ID, THREAD_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].queueItemId).toBe(item.id);
    });

    it("appendEntries with a stale fence throws StaleAttemptError and writes nothing", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      await store.replaceSubmissionAttempt(
        SESSION_ID,
        THREAD_ID,
        item.id,
        { sessionId: SESSION_ID, threadId: THREAD_ID, itemId: item.id, attemptId: "att-2", ownerId: "o" },
        { expectedAttemptId: "att-1" },
      );
      const staleFence: WriteFence = { itemId: item.id, attemptId: "att-1" };
      const entry: MessageEntry = {
        id: uid("e"),
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        parentId: null,
        type: "message",
        role: "user",
        content: "hi",
        createdAt: Date.now(),
        queueItemId: item.id,
      };
      await expect(
        store.appendEntries(SESSION_ID, THREAD_ID, [entry], staleFence),
      ).rejects.toThrow(StaleAttemptError);
      const entries = await store.getEntries(SESSION_ID, THREAD_ID);
      expect(entries).toHaveLength(0);
    });

    it("updateEntry / saveSuspendedTurn / clearSuspendedTurn reject stale fences the same way", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      const validFence: WriteFence = { itemId: item.id, attemptId: claimed!.attemptId! };
      const entry: MessageEntry = {
        id: uid("e"),
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        parentId: null,
        type: "message",
        role: "user",
        content: "hi",
        createdAt: Date.now(),
      };
      await store.appendEntries(SESSION_ID, THREAD_ID, [entry], validFence);

      await store.replaceSubmissionAttempt(
        SESSION_ID,
        THREAD_ID,
        item.id,
        { sessionId: SESSION_ID, threadId: THREAD_ID, itemId: item.id, attemptId: "att-2", ownerId: "o" },
        { expectedAttemptId: "att-1" },
      );
      const staleFence: WriteFence = { itemId: item.id, attemptId: "att-1" };

      await expect(
        store.updateEntry(SESSION_ID, THREAD_ID, { ...entry, content: "changed" }, staleFence),
      ).rejects.toThrow(StaleAttemptError);

      const suspended: SuspendedTurnState = {
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        queueItemId: item.id,
        gateId: "gate-1",
        model: "faux/faux-1",
        toolCallId: "tc-1",
        toolName: "do_thing",
        toolArgs: {},
        resumeKey: "do_thing",
        ordinal: 0,
        attempt: 1,
        createdAt: Date.now(),
      };
      await expect(
        store.saveSuspendedTurn(SESSION_ID, THREAD_ID, suspended, staleFence),
      ).rejects.toThrow(StaleAttemptError);
      await expect(
        store.clearSuspendedTurn(SESSION_ID, THREAD_ID, staleFence),
      ).rejects.toThrow(StaleAttemptError);
    });

    it("reserveSettlement with a stale fence throws StaleAttemptError; item stays running", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      const staleFence: WriteFence = { itemId: item.id, attemptId: "wrong-attempt" };
      await expect(
        store.reserveSettlement(SESSION_ID, THREAD_ID, item.id, { outcome: "completed" }, staleFence),
      ).rejects.toThrow(StaleAttemptError);
      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("running");
    });

    // --- Leases, markers, attempt replacement ---

    it("renewLeases extends leaseExpiresAt for owned items and skips replaced ones", async () => {
      // b lives on a separate thread so claiming it isn't gated by a's
      // running status (per-thread FIFO gating only applies within a thread).
      const otherThreadId = "th-lease";
      await store.saveThread(SESSION_ID, newThread(otherThreadId, "web:lease"));
      const a = makeItem();
      const b = makeItem({ threadId: otherThreadId });
      await store.admitSubmission(SESSION_ID, THREAD_ID, a);
      await store.admitSubmission(SESSION_ID, otherThreadId, b);
      const claimedA = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: a.id,
        attemptId: "att-a",
        ownerId: "owner-1",
        leaseDurationMs: 1000,
      });
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: otherThreadId,
        itemId: b.id,
        attemptId: "att-b",
        ownerId: "owner-2",
      });
      // Reclaim b's attempt away from owner-2 so owner-2's renew should skip it.
      await store.replaceSubmissionAttempt(
        SESSION_ID,
        otherThreadId,
        b.id,
        { sessionId: SESSION_ID, threadId: otherThreadId, itemId: b.id, attemptId: "att-b2", ownerId: "owner-3" },
        { expectedAttemptId: "att-b" },
      );

      const before = claimedA!.leaseExpiresAt!;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.renewLeases("owner-1", [a.id]);
      await store.renewLeases("owner-2", [b.id]);

      const loadedA = await store.getQueueItem(SESSION_ID, a.id);
      const loadedB = await store.getQueueItem(SESSION_ID, b.id);
      expect(loadedA!.leaseExpiresAt!).toBeGreaterThan(before);
      expect(loadedB!.ownerId).toBe("owner-3"); // untouched by owner-2's renew
    });

    it("listExpiredSubmissions returns running items whose lease passed, not live ones", async () => {
      // live lives on a separate thread so it can actually be claimed and
      // running concurrently with expired (per-thread FIFO gating would
      // otherwise block it while expired sits running-but-unrenewed).
      const otherThreadId = "th-expiry";
      await store.saveThread(SESSION_ID, newThread(otherThreadId, "web:expiry"));
      const expired = makeItem();
      const live = makeItem({ threadId: otherThreadId });
      await store.admitSubmission(SESSION_ID, THREAD_ID, expired);
      await store.admitSubmission(SESSION_ID, otherThreadId, live);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: expired.id,
        attemptId: "att-1",
        ownerId: "o",
        leaseDurationMs: -1000, // already expired
      });
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: otherThreadId,
        itemId: live.id,
        attemptId: "att-2",
        ownerId: "o",
        leaseDurationMs: 60_000,
      });

      const result = await store.listExpiredSubmissions(Date.now());
      expect(result.map((i) => i.id)).toEqual([expired.id]);
    });

    it("replaceSubmissionAttempt CAS: succeeds with matching expectedAttemptId on expired lease; increments attemptCount", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "owner-1",
        leaseDurationMs: -1000,
      });
      const replaced = await store.replaceSubmissionAttempt(
        SESSION_ID,
        THREAD_ID,
        item.id,
        {
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
          itemId: item.id,
          attemptId: "att-2",
          ownerId: "owner-2",
        },
        { expectedAttemptId: "att-1" },
      );
      expect(replaced).not.toBeNull();
      expect(replaced?.attemptId).toBe("att-2");
      expect(replaced?.ownerId).toBe("owner-2");
      expect(replaced?.attemptCount).toBe(2);
    });

    it("replaceSubmissionAttempt loses when expectedAttemptId is stale (double-reclaim race)", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "owner-1",
        leaseDurationMs: -1000,
      });
      const winner = await store.replaceSubmissionAttempt(
        SESSION_ID,
        THREAD_ID,
        item.id,
        {
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
          itemId: item.id,
          attemptId: "att-2",
          ownerId: "owner-2",
        },
        { expectedAttemptId: "att-1" },
      );
      expect(winner).not.toBeNull();

      const loser = await store.replaceSubmissionAttempt(
        SESSION_ID,
        THREAD_ID,
        item.id,
        {
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
          itemId: item.id,
          attemptId: "att-3",
          ownerId: "owner-3",
        },
        { expectedAttemptId: "att-1" }, // stale — att-1 is no longer current
      );
      expect(loser).toBeNull();
    });

    it("attempt markers insert/delete round-trip and hasAttemptMarker reads them", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      // Never-inserted pair reads false.
      expect(await store.hasAttemptMarker(item.id, "att-1")).toBe(false);
      await expect(store.insertAttemptMarker(item.id, "att-1")).resolves.toBeUndefined();
      expect(await store.hasAttemptMarker(item.id, "att-1")).toBe(true);
      // A different (item, attempt) pair is still false.
      expect(await store.hasAttemptMarker(item.id, "att-other")).toBe(false);
      await expect(store.deleteAttemptMarker(item.id, "att-1")).resolves.toBeUndefined();
      expect(await store.hasAttemptMarker(item.id, "att-1")).toBe(false);
      // Delete is idempotent.
      await expect(store.deleteAttemptMarker(item.id, "att-1")).resolves.toBeUndefined();
    });

    // --- Two-phase settlement ---

    it("reserveSettlement records the outcome durably (status terminalizing), finalize settles it", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      const fence: WriteFence = { itemId: item.id, attemptId: claimed!.attemptId! };
      await store.reserveSettlement(SESSION_ID, THREAD_ID, item.id, { outcome: "completed" }, fence);
      const reserved = await store.getQueueItem(SESSION_ID, item.id);
      expect(reserved?.status).toBe("terminalizing");
      expect(reserved?.outcome).toEqual({ outcome: "completed" });

      await store.finalizeSettlement(SESSION_ID, THREAD_ID, item.id, fence);
      const settled = await store.getQueueItem(SESSION_ID, item.id);
      expect(settled?.status).toBe("settled");
      expect(settled?.outcome).toEqual({ outcome: "completed" });
    });

    it("finalizeSettlement is idempotent: re-running after settled is a no-op", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      const fence: WriteFence = { itemId: item.id, attemptId: claimed!.attemptId! };
      await store.reserveSettlement(SESSION_ID, THREAD_ID, item.id, { outcome: "completed" }, fence);
      await store.finalizeSettlement(SESSION_ID, THREAD_ID, item.id, fence);
      await expect(
        store.finalizeSettlement(SESSION_ID, THREAD_ID, item.id, fence),
      ).resolves.toBeUndefined();
      const settled = await store.getQueueItem(SESSION_ID, item.id);
      expect(settled?.status).toBe("settled");
    });

    it("a second reserveSettlement with a different outcome throws ConflictError (first terminal write wins)", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      const fence: WriteFence = { itemId: item.id, attemptId: claimed!.attemptId! };
      await store.reserveSettlement(SESSION_ID, THREAD_ID, item.id, { outcome: "completed" }, fence);
      await expect(
        store.reserveSettlement(SESSION_ID, THREAD_ID, item.id, { outcome: "failed", error: "x" }, fence),
      ).rejects.toThrow(ConflictError);
    });

    it("re-reserving with the same outcome after terminalizing is an idempotent no-op", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      const fence: WriteFence = { itemId: item.id, attemptId: claimed!.attemptId! };
      await store.reserveSettlement(SESSION_ID, THREAD_ID, item.id, { outcome: "completed" }, fence);
      await expect(
        store.reserveSettlement(SESSION_ID, THREAD_ID, item.id, { outcome: "completed" }, fence),
      ).resolves.toBeUndefined();
      const reserved = await store.getQueueItem(SESSION_ID, item.id);
      expect(reserved?.status).toBe("terminalizing");
      expect(reserved?.outcome).toEqual({ outcome: "completed" });

      await store.finalizeSettlement(SESSION_ID, THREAD_ID, item.id, fence);
      const settled = await store.getQueueItem(SESSION_ID, item.id);
      expect(settled?.status).toBe("settled");
      expect(settled?.outcome).toEqual({ outcome: "completed" });
    });

    it("settled items are excluded from listUnsettledSubmissions", async () => {
      const a = makeItem();
      const b = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, a);
      await store.admitSubmission(SESSION_ID, THREAD_ID, b);
      await store.settleUnclaimed(SESSION_ID, THREAD_ID, a.id, { outcome: "superseded" });

      const unsettled = await store.listUnsettledSubmissions(SESSION_ID);
      expect(unsettled.map((i) => i.id)).toEqual([b.id]);
    });

    // --- settleUnclaimed ---

    it("settles a queued item 'superseded' without a claim", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const ok = await store.settleUnclaimed(SESSION_ID, THREAD_ID, item.id, {
        outcome: "superseded",
      });
      expect(ok).toBe(true);
      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("settled");
      expect(loaded?.outcome).toEqual({ outcome: "superseded" });
    });

    it("settles a collecting item 'merged' stamping mergedIntoItemId", async () => {
      const item = makeItem({ status: "collecting" });
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const ok = await store.settleUnclaimed(
        SESSION_ID,
        THREAD_ID,
        item.id,
        { outcome: "merged" },
        { mergedIntoItemId: "merged-item-1" },
      );
      expect(ok).toBe(true);
      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("settled");
      expect(loaded?.mergedIntoItemId).toBe("merged-item-1");
    });

    it("refuses to settle a running item (returns false)", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      const ok = await store.settleUnclaimed(SESSION_ID, THREAD_ID, item.id, {
        outcome: "aborted",
      });
      expect(ok).toBe(false);
      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("running");
    });

    // --- Abort + blocked ---

    it("requestAbort stamps abortRequestedAt on unsettled items in scope only; first write wins", async () => {
      const otherThreadId = "th-2";
      await store.saveThread(SESSION_ID, newThread(otherThreadId, "web:other"));
      const a = makeItem();
      const settled = makeItem();
      const otherThread = makeItem({ threadId: otherThreadId });
      await store.admitSubmission(SESSION_ID, THREAD_ID, a);
      await store.admitSubmission(SESSION_ID, THREAD_ID, settled);
      await store.admitSubmission(SESSION_ID, otherThreadId, otherThread);
      await store.settleUnclaimed(SESSION_ID, THREAD_ID, settled.id, { outcome: "aborted" });

      await store.requestAbort(SESSION_ID, THREAD_ID);
      const loadedA = await store.getQueueItem(SESSION_ID, a.id);
      const firstStamp = loadedA?.abortRequestedAt;
      expect(firstStamp).toBeDefined();

      const loadedOther = await store.getQueueItem(SESSION_ID, otherThread.id);
      expect(loadedOther?.abortRequestedAt).toBeUndefined();

      const loadedSettled = await store.getQueueItem(SESSION_ID, settled.id);
      expect(loadedSettled?.abortRequestedAt).toBeUndefined();

      // First write wins: calling again does not move the stamp forward.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.requestAbort(SESSION_ID, THREAD_ID);
      const loadedAAgain = await store.getQueueItem(SESSION_ID, a.id);
      expect(loadedAAgain?.abortRequestedAt).toBe(firstStamp);
    });

    it("setSubmissionBlocked toggles running↔blocked_on_decision_gate under the current fence", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      const fence: WriteFence = { itemId: item.id, attemptId: claimed!.attemptId! };

      await store.setSubmissionBlocked(SESSION_ID, THREAD_ID, item.id, true, fence);
      expect((await store.getQueueItem(SESSION_ID, item.id))?.status).toBe(
        "blocked_on_decision_gate",
      );

      await store.setSubmissionBlocked(SESSION_ID, THREAD_ID, item.id, false, fence);
      expect((await store.getQueueItem(SESSION_ID, item.id))?.status).toBe("running");
    });

    it("setSubmissionBlocked refuses to resurrect a settled item (ConflictError)", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      const fence: WriteFence = { itemId: item.id, attemptId: claimed!.attemptId! };
      await store.reserveSettlement(SESSION_ID, THREAD_ID, item.id, { outcome: "completed" }, fence);
      await store.finalizeSettlement(SESSION_ID, THREAD_ID, item.id, fence);

      // The fence still names the settling attempt, but the item is settled:
      // a late blocked-toggle must not bring it back to a live status.
      await expect(
        store.setSubmissionBlocked(SESSION_ID, THREAD_ID, item.id, true, fence),
      ).rejects.toThrow(ConflictError);
      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("settled");
      expect(loaded?.outcome).toEqual({ outcome: "completed" });
    });

    // --- Cross-session + retention listings ---

    it("listSessionIdsWithUnsettledSubmissions returns only sessions with an unsettled item", async () => {
      const OTHER = "sess-2";
      const OTHER_THREAD = "th-other-1";
      await store.saveSession(newSession({ id: OTHER }));
      await store.saveThread(OTHER, {
        ...newThread(OTHER_THREAD, "web:default"),
        sessionId: OTHER,
      });

      const keepUnsettled = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, keepUnsettled);

      const settleFully = makeItem({ threadId: OTHER_THREAD });
      await store.admitSubmission(OTHER, OTHER_THREAD, settleFully);
      const ok = await store.settleUnclaimed(OTHER, OTHER_THREAD, settleFully.id, {
        outcome: "completed",
      });
      expect(ok).toBe(true);

      const ids = await store.listSessionIdsWithUnsettledSubmissions();
      expect(ids).toContain(SESSION_ID);
      expect(ids).not.toContain(OTHER);
    });

    it("listSettledSubmissionsBefore returns only settled items older than the cutoff", async () => {
      const settled = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, settled);
      const ok = await store.settleUnclaimed(SESSION_ID, THREAD_ID, settled.id, {
        outcome: "completed",
      });
      expect(ok).toBe(true);

      const unsettled = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, unsettled);

      const future = Date.now() + 10_000;
      const past = Date.now() - 10_000;

      const beforeFuture = await store.listSettledSubmissionsBefore(SESSION_ID, future);
      expect(beforeFuture.map((i) => i.id)).toEqual([settled.id]);

      const beforePast = await store.listSettledSubmissionsBefore(SESSION_ID, past);
      expect(beforePast).toEqual([]);
    });
  });
}
