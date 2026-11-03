import { describe, it, expect, beforeEach } from "vitest";
import { ConflictError, NotFoundError, PendingCapError, StaleAttemptError, ValidationError } from "../errors.js";
import { SUBMISSION_TIMEOUT_MS } from "../submission.js";
import { CONTINUATION_TOOL_SCOPE_KEY, INHERIT_TOOL_SCOPE_KEY, TOOL_SCOPE_KEY } from "@valet/shared";
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

    it.each([THREAD_ID, "other-thread"])("clamps continuation scope at claim using current metadata from %s", async (sourceThreadId) => {
      const item = makeItem({ metadata: { [INHERIT_TOOL_SCOPE_KEY]: true, [TOOL_SCOPE_KEY]: { actions: ["demo.echo"] } } });
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      // The scope changed after the driver's snapshot/admission, on either thread.
      await store.saveThread(SESSION_ID, { ...newThread(sourceThreadId, sourceThreadId), metadata: { [CONTINUATION_TOOL_SCOPE_KEY]: { tools: [], actions: [] } } });
      const claimed = await store.claimSubmission({ sessionId: SESSION_ID, threadId: THREAD_ID, itemId: item.id, attemptId: "a1", ownerId: "host" });
      expect(claimed?.metadata?.[TOOL_SCOPE_KEY]).toEqual({ tools: [], actions: [] });
      expect((await store.getQueueItem(SESSION_ID, item.id))?.metadata?.[TOOL_SCOPE_KEY]).toEqual({ tools: [], actions: [] });
    });

    it("leaves a new human task independent of the previous continuation ceiling", async () => {
      await store.saveThread(SESSION_ID, { ...newThread(), metadata: { [CONTINUATION_TOOL_SCOPE_KEY]: { tools: [], actions: [] } } });
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({ sessionId: SESSION_ID, threadId: THREAD_ID, itemId: item.id, attemptId: "a1", ownerId: "host" });
      expect(claimed?.metadata?.[TOOL_SCOPE_KEY]).toBeUndefined();
    });

    it("admits and reads back a submission", async () => {
      const item = makeItem();
      const result = await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      expect(result.admitted).toBe(true);
      expect(result.supersededItemIds).toEqual([]);
      expect(result.item).toEqual(item);
      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded).toEqual(item);
    });

    it("recovers a receipt by dispatch ID before and after settlement, scoped to the session", async () => {
      const item = makeItem({ dispatchId: "recover-receipt" });
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      expect(await store.getQueueItemByDispatchId(SESSION_ID, "recover-receipt")).toEqual(item);
      expect(await store.getQueueItemByDispatchId(SESSION_ID, "missing")).toBeNull();
      await store.saveSession(newSession({ id: "other-session", orgId: "other-org" }));
      expect(await store.getQueueItemByDispatchId("other-session", "recover-receipt")).toBeNull();
      await store.settleUnclaimed(SESSION_ID, THREAD_ID, item.id, { outcome: "completed" });
      expect(await store.getQueueItemByDispatchId(SESSION_ID, "recover-receipt")).toMatchObject({ id: item.id, status: "settled" });
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

    // --- Pending cap (opts.maxPending, enforced inside admitSubmission's transaction) ---

    it("admission at the cap throws PendingCapError; a slot below the cap admits", async () => {
      const a = await store.admitSubmission(SESSION_ID, THREAD_ID, makeItem(), { maxPending: 2 });
      expect(a.admitted).toBe(true);
      const b = await store.admitSubmission(SESSION_ID, THREAD_ID, makeItem(), { maxPending: 2 });
      expect(b.admitted).toBe(true);

      // Thread now holds 2 unsettled, non-superseded items == cap: rejected.
      await expect(
        store.admitSubmission(SESSION_ID, THREAD_ID, makeItem(), { maxPending: 2 }),
      ).rejects.toThrow(PendingCapError);

      // Settling one item frees a slot; the next admission under the cap succeeds.
      const ok = await store.settleUnclaimed(SESSION_ID, THREAD_ID, a.item.id, { outcome: "completed" });
      expect(ok).toBe(true);
      const c = await store.admitSubmission(SESSION_ID, THREAD_ID, makeItem(), { maxPending: 2 });
      expect(c.admitted).toBe(true);
    });

    it("superseded items don't count toward the pending cap", async () => {
      const a = await store.admitSubmission(SESSION_ID, THREAD_ID, makeItem({ createdAt: 100, updatedAt: 100 }));
      const b = await store.admitSubmission(SESSION_ID, THREAD_ID, makeItem({ createdAt: 200, updatedAt: 200 }));
      expect(a.admitted && b.admitted).toBe(true);

      // Steer supersedes both prior items in the same atomic admission.
      const s = await store.admitSubmission(
        SESSION_ID,
        THREAD_ID,
        makeItem({ createdAt: 300, updatedAt: 300 }),
        { steer: true },
      );
      expect(s.supersededItemIds.sort()).toEqual([a.item.id, b.item.id].sort());

      // Only `s` counts now (a and b are superseded) — two more admissions
      // fit under a cap of 3 before the cap trips.
      const d = await store.admitSubmission(SESSION_ID, THREAD_ID, makeItem(), { maxPending: 3 });
      expect(d.admitted).toBe(true);
      const e = await store.admitSubmission(SESSION_ID, THREAD_ID, makeItem(), { maxPending: 3 });
      expect(e.admitted).toBe(true);
      await expect(
        store.admitSubmission(SESSION_ID, THREAD_ID, makeItem(), { maxPending: 3 }),
      ).rejects.toThrow(PendingCapError);
    });

    it("promoteFromItemId refuses a claimed source and does not insert", async () => {
      const source = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, source);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: source.id,
        attemptId: "att-promo",
        ownerId: "o",
      });
      expect(claimed?.status).toBe("running");

      const clone = makeItem({ metadata: { promotedFromItemId: source.id } });
      await expect(
        store.admitSubmission(SESSION_ID, THREAD_ID, clone, {
          steer: true,
          promoteFromItemId: source.id,
        }),
      ).rejects.toThrow(ValidationError);

      expect(await store.getQueueItem(SESSION_ID, clone.id)).toBeNull();
      const still = await store.getQueueItem(SESSION_ID, source.id);
      expect(still?.status).toBe("running");
      expect(still?.supersededByItemId).toBeUndefined();
    });

    it("promoteFromItemId admits when the source is still queued", async () => {
      const source = makeItem({ createdAt: 100, updatedAt: 100 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, source);
      const clone = makeItem({
        createdAt: 200,
        updatedAt: 200,
        metadata: { promotedFromItemId: source.id },
      });
      const result = await store.admitSubmission(SESSION_ID, THREAD_ID, clone, {
        steer: true,
        promoteFromItemId: source.id,
      });
      expect(result.admitted).toBe(true);
      expect(result.supersededItemIds).toContain(source.id);
    });

    it("settleUnclaimed with onlyIfUnsuperseded refuses a promoted source and a claimed item", async () => {
      const source = makeItem({ createdAt: 100, updatedAt: 100 });
      const other = makeItem({ createdAt: 150, updatedAt: 150 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, source);
      await store.admitSubmission(SESSION_ID, THREAD_ID, other);
      await store.admitSubmission(SESSION_ID, THREAD_ID, makeItem({
        createdAt: 200, updatedAt: 200, metadata: { promotedFromItemId: source.id },
      }), { steer: true, promoteFromItemId: source.id });

      const cancel = (id: string) => store.settleUnclaimed(SESSION_ID, THREAD_ID, id, { outcome: "aborted" }, { onlyIfUnsuperseded: true });
      expect(await cancel(source.id)).toBe(false);
      expect((await store.getQueueItem(SESSION_ID, source.id))?.status).not.toBe("settled");

      await store.claimSubmission({ sessionId: SESSION_ID, threadId: THREAD_ID, itemId: other.id, attemptId: "att-o", ownerId: "o" });
      expect(await cancel(other.id)).toBe(false);

      const fresh = makeItem({ createdAt: 300, updatedAt: 300 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, fresh);
      expect(await cancel(fresh.id)).toBe(true);
      expect((await store.getQueueItem(SESSION_ID, fresh.id))?.outcome).toEqual({ outcome: "aborted" });
    });

    it("promotion steer preserves queued siblings and claims the promoted successor first", async () => {
      const active = makeItem({ createdAt: 100, updatedAt: 100 });
      const q1 = makeItem({ createdAt: 200, updatedAt: 200, content: "q1" });
      const q2 = makeItem({ createdAt: 300, updatedAt: 300, content: "q2" });
      const q3 = makeItem({ createdAt: 400, updatedAt: 400, content: "q3" });
      await store.admitSubmission(SESSION_ID, THREAD_ID, active);
      await store.admitSubmission(SESSION_ID, THREAD_ID, q1);
      await store.admitSubmission(SESSION_ID, THREAD_ID, q2);
      await store.admitSubmission(SESSION_ID, THREAD_ID, q3);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: active.id,
        attemptId: "att-active",
        ownerId: "o",
      });
      await store.setSubmissionBlocked(
        SESSION_ID,
        THREAD_ID,
        active.id,
        true,
        { itemId: active.id, attemptId: "att-active" },
      );

      const promoted = makeItem({
        createdAt: 500,
        updatedAt: 500,
        content: q2.content,
        metadata: { promotedFromItemId: q2.id },
      });
      const admitted = await store.admitSubmission(
        SESSION_ID,
        THREAD_ID,
        promoted,
        {
          steer: true,
          steerScope: "active-and-source",
          promoteFromItemId: q2.id,
        },
      );

      expect(admitted.supersededItemIds.sort()).toEqual([active.id, q2.id].sort());
      expect((await store.getQueueItem(SESSION_ID, q1.id))?.supersededByItemId).toBeUndefined();
      expect((await store.getQueueItem(SESSION_ID, q3.id))?.supersededByItemId).toBeUndefined();
      expect((await store.getQueueItem(SESSION_ID, q2.id))?.supersededByItemId).toBe(promoted.id);
      expect(admitted.item.createdAt).toBeLessThan(q1.createdAt);

      const claimPromoted = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: promoted.id,
        attemptId: "att-promoted",
        ownerId: "o",
      });
      expect(claimPromoted?.id).toBe(promoted.id);
      expect(
        await store.claimSubmission({
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
          itemId: q1.id,
          attemptId: "att-q1-too-soon",
          ownerId: "o",
        }),
      ).toBeNull();
      await store.reserveSettlement(
        SESSION_ID,
        THREAD_ID,
        promoted.id,
        { outcome: "completed" },
        { itemId: promoted.id, attemptId: "att-promoted" },
      );
      await store.finalizeSettlement(
        SESSION_ID,
        THREAD_ID,
        promoted.id,
        { itemId: promoted.id, attemptId: "att-promoted" },
      );

      const claimQ1 = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: q1.id,
        attemptId: "att-q1",
        ownerId: "o",
      });
      expect(claimQ1?.id).toBe(q1.id);
      await store.reserveSettlement(
        SESSION_ID,
        THREAD_ID,
        q1.id,
        { outcome: "completed" },
        { itemId: q1.id, attemptId: "att-q1" },
      );
      await store.finalizeSettlement(
        SESSION_ID,
        THREAD_ID,
        q1.id,
        { itemId: q1.id, attemptId: "att-q1" },
      );

      const claimQ3 = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: q3.id,
        attemptId: "att-q3",
        ownerId: "o",
      });
      expect(claimQ3?.id).toBe(q3.id);
      expect((await store.getQueueItem(SESSION_ID, q2.id))?.status).toBe("queued");
    });

    it("active steer supersedes only the running item and runs ahead of queued siblings", async () => {
      const active = makeItem({ createdAt: 100, updatedAt: 100 });
      const q1 = makeItem({ createdAt: 200, updatedAt: 200, content: "q1" });
      const q2 = makeItem({ createdAt: 300, updatedAt: 300, content: "q2" });
      await store.admitSubmission(SESSION_ID, THREAD_ID, active);
      await store.admitSubmission(SESSION_ID, THREAD_ID, q1);
      await store.admitSubmission(SESSION_ID, THREAD_ID, q2);
      await store.claimSubmission({
        sessionId: SESSION_ID, threadId: THREAD_ID, itemId: active.id, attemptId: "att-active", ownerId: "o",
      });

      const edit = makeItem({ createdAt: 400, updatedAt: 400, content: "edited" });
      const admitted = await store.admitSubmission(SESSION_ID, THREAD_ID, edit, { steer: true, steerScope: "active" });

      expect(admitted.supersededItemIds).toEqual([active.id]);
      expect((await store.getQueueItem(SESSION_ID, q1.id))?.supersededByItemId).toBeUndefined();
      expect((await store.getQueueItem(SESSION_ID, q2.id))?.supersededByItemId).toBeUndefined();
      expect(admitted.item.createdAt).toBeLessThan(q1.createdAt);

      await store.reserveSettlement(SESSION_ID, THREAD_ID, active.id, { outcome: "superseded" }, { itemId: active.id, attemptId: "att-active" });
      await store.finalizeSettlement(SESSION_ID, THREAD_ID, active.id, { itemId: active.id, attemptId: "att-active" });
      expect(await store.claimSubmission({
        sessionId: SESSION_ID, threadId: THREAD_ID, itemId: q1.id, attemptId: "att-q1", ownerId: "o",
      })).toBeNull();
      expect((await store.claimSubmission({
        sessionId: SESSION_ID, threadId: THREAD_ID, itemId: edit.id, attemptId: "att-edit", ownerId: "o",
      }))?.id).toBe(edit.id);
    });

    it.each(["same", "different-thread", "different-channel", "different-author", "no-origin", "not-entered"])("origin steering isolates %s conversations and keeps queued work", async (variant) => {
      const active = makeItem({ createdAt: 100, updatedAt: 100, content: {
        kind: "signal", signalType: "slack.message", body: "working", origin: { channelType: "slack", threadKey: "slack:D1:1", reply: "auto" },
      } });
      const queued = makeItem({ createdAt: 200, updatedAt: 200, content: "queued" });
      await store.admitSubmission(SESSION_ID, THREAD_ID, active);
      await store.admitSubmission(SESSION_ID, THREAD_ID, queued);
      await store.claimSubmission({ sessionId: SESSION_ID, threadId: THREAD_ID, itemId: active.id, attemptId: "origin-active", ownerId: "o" });
      if (variant !== "not-entered") await store.appendEntries(SESSION_ID, THREAD_ID, [{
        id: uid("e"), sessionId: SESSION_ID, threadId: THREAD_ID, parentId: null,
        type: "message", role: "user", content: "working", createdAt: 100, queueItemId: active.id,
      }], { itemId: active.id, attemptId: "origin-active" });
      const incoming = makeItem({ createdAt: 300, updatedAt: 300, ...(variant === "different-author" ? { author: { id: "someone-else" } } : {}), content: variant === "no-origin" ? "web message" : {
        kind: "signal", signalType: "slack.message", body: "reply", origin: {
          channelType: variant === "different-channel" ? "telegram" : "slack",
          threadKey: variant === "different-thread" ? "slack:D1:2" : "slack:D1:1", reply: "auto",
        },
      } });
      const receipt = await store.admitSubmission(SESSION_ID, THREAD_ID, incoming, { steer: true, steerScope: "active-origin" });
      expect(receipt.supersededItemIds).toEqual(variant === "same" ? [active.id] : []);
      expect((await store.getQueueItem(SESSION_ID, queued.id))?.supersededByItemId).toBeUndefined();
      expect(receipt.item.createdAt < queued.createdAt).toBe(variant === "same");
    });

    it.each([true, false])("origin correction carries queued requests atomically with matching active=%s", async (matchingActive) => {
      const content = (body: string, threadKey = "slack:C1:1") => ({
        kind: "signal" as const, signalType: "slack.message", body,
        origin: { channelType: "slack", threadKey, reply: "auto" as const },
      });
      const sender = { id: "sender" };
      const active = makeItem({ content: content("working", matchingActive ? "slack:C1:1" : "slack:C2:1"), createdAt: 100, author: sender });
      await store.admitSubmission(SESSION_ID, THREAD_ID, active);
      await store.claimSubmission({ sessionId: SESSION_ID, threadId: THREAD_ID, itemId: active.id, attemptId: "carry-active", ownerId: "o" });
      await store.appendEntries(SESSION_ID, THREAD_ID, [{ id: uid("e"), sessionId: SESSION_ID, threadId: THREAD_ID, parentId: null,
        type: "message", role: "user", content: "working", createdAt: 100, queueItemId: active.id,
      }], { itemId: active.id, attemptId: "carry-active" });
      const deploy = makeItem({ content: content("deploy"), createdAt: 200, dispatchId: "carry-deploy", author: sender, metadata: { [TOOL_SCOPE_KEY]: { actions: ["deploy"] } } });
      const unrelated = makeItem({ content: content("other work", "slack:C3:1"), createdAt: 210, author: sender });
      const otherSender = makeItem({ content: content("other request"), createdAt: 220, author: { id: "other" } });
      await store.admitSubmission(SESSION_ID, THREAD_ID, deploy);
      await store.admitSubmission(SESSION_ID, THREAD_ID, unrelated);
      await store.admitSubmission(SESSION_ID, THREAD_ID, otherSender);
      const stop = makeItem({ content: content("stop"), createdAt: 300, dispatchId: "carry-stop", author: sender });
      const opts = { steer: true, steerScope: "active-origin" as const, maxPending: 4 };
      const result = await store.admitSubmission(SESSION_ID, THREAD_ID, stop, opts);
      expect(result.item.metadata?.carriedInputIds).toEqual([deploy.id]);
      expect(result.item.author).toEqual(sender);
      expect(result.item.metadata?.[TOOL_SCOPE_KEY]).toBeUndefined();
      expect(await store.getQueueItem(SESSION_ID, deploy.id)).toMatchObject({ status: "settled", outcome: { outcome: "superseded" }, supersededByItemId: stop.id, author: sender });
      expect((await store.getQueueItem(SESSION_ID, unrelated.id))?.supersededByItemId).toBeUndefined();
      expect(await store.getQueueItem(SESSION_ID, otherSender.id)).toMatchObject({ status: "queued" });
      expect((await store.getQueueItem(SESSION_ID, otherSender.id))?.supersededByItemId).toBeUndefined();
      expect((await store.getQueueItem(SESSION_ID, active.id))?.supersededByItemId).toBe(matchingActive ? stop.id : undefined);
      expect(await store.claimSubmission({ sessionId: SESSION_ID, threadId: THREAD_ID, itemId: deploy.id, attemptId: "unsafe-deploy", ownerId: "o" })).toBeNull();
      const replay = await store.admitSubmission(SESSION_ID, THREAD_ID, stop, opts);
      expect(replay.admitted).toBe(false);
      expect(replay.item.metadata?.carriedInputIds).toEqual([deploy.id]);
      const newest = makeItem({ content: content("keep stopped"), createdAt: 400, author: sender });
      const next = await store.admitSubmission(SESSION_ID, THREAD_ID, newest, { steer: true, steerScope: "active-origin" });
      expect(next.item.metadata?.carriedInputIds).toEqual([deploy.id, stop.id]);
      expect(next.item.content).toEqual(newest.content);
    });

    it("enforces the cap after origin steering and dedups replays at capacity", async () => {
      const content = { kind: "signal" as const, signalType: "slack.message", body: "work", origin: { channelType: "slack", threadKey: "slack:D1:1", reply: "auto" as const } };
      const active = makeItem({ content });
      await store.admitSubmission(SESSION_ID, THREAD_ID, active);
      await store.claimSubmission({ sessionId: SESSION_ID, threadId: THREAD_ID, itemId: active.id, attemptId: "origin-cap", ownerId: "o" });
      await store.appendEntries(SESSION_ID, THREAD_ID, [{ id: uid("e"), sessionId: SESSION_ID, threadId: THREAD_ID, parentId: null, type: "message", role: "user", content: "work", createdAt: 100, queueItemId: active.id }], { itemId: active.id, attemptId: "origin-cap" });
      await store.admitSubmission(SESSION_ID, THREAD_ID, makeItem());
      const opts = { steer: true, steerScope: "active-origin" as const, maxPending: 2 };
      await expect(store.admitSubmission(SESSION_ID, THREAD_ID, makeItem(), opts)).rejects.toBeInstanceOf(PendingCapError);
      const reply = makeItem({ content, dispatchId: "origin-cap-reply" });
      expect((await store.admitSubmission(SESSION_ID, THREAD_ID, reply, opts)).supersededItemIds).toEqual([active.id]);
      expect((await store.admitSubmission(SESSION_ID, THREAD_ID, reply, { ...opts, maxPending: 0 })).admitted).toBe(false);
      expect((await store.admitSubmission(SESSION_ID, THREAD_ID, makeItem({ content }), opts)).item.metadata?.carriedInputIds).toEqual([reply.id]);
    });

    it.each(["manual", "unspecified", "bot", "unattended", "record-only", "other-thread", "other-session", "other-author"])("origin carry preserves %s queued inputs", async (variant) => {
      const content = { kind: "signal" as const, signalType: "slack.message", body: "older",
        origin: { channelType: "slack", threadKey: "slack:C1:1", reply: "auto" as const } };
      const incoming = makeItem({ content: { ...content, body: "correction" } });
      const older = makeItem({ content: variant === "manual" ? { ...content, origin: { ...content.origin, reply: "manual" } } :
        variant === "unspecified" ? { ...content, origin: { channelType: "slack", threadKey: "slack:C1:1" } } :
        variant === "bot" ? { ...content, attributes: { senderBot: "true" } } : content,
        metadata: variant === "unattended" ? { unattendedDelivery: true } : variant === "record-only" ? { recordOnly: true } : undefined,
        ...(variant === "other-author" ? { author: { id: "other" } } : {}) });
      let sessionId = SESSION_ID;
      let threadId = THREAD_ID;
      if (variant === "other-session") { sessionId = "other-session"; await store.saveSession(newSession({ id: sessionId })); }
      if (variant === "other-thread" || variant === "other-session") {
        threadId = "other-thread";
        await store.saveThread(sessionId, { ...newThread(threadId, threadId), sessionId });
      }
      older.threadId = threadId;
      await store.admitSubmission(sessionId, threadId, older);
      const result = await store.admitSubmission(SESSION_ID, THREAD_ID, incoming, { steer: true, steerScope: "active-origin" });
      expect(result.item.metadata?.carriedInputIds).toBeUndefined();
      expect(await store.getQueueItem(sessionId, older.id)).toMatchObject({ status: "queued" });
      expect(result.supersededItemIds).toEqual([]);
    });

    it("strips caller carry references before they can become transitive", async () => {
      const content = { kind: "signal" as const, signalType: "slack.message", body: "input", origin: { channelType: "slack", threadKey: "slack:C1:1", reply: "auto" as const } };
      const older = makeItem({ content, dispatchId: "forged-carry-replay", metadata: { carriedInputIds: ["forged-private-input"] } });
      const first = await store.admitSubmission(SESSION_ID, THREAD_ID, older);
      expect(first.item.metadata?.carriedInputIds).toBeUndefined();
      const correction = makeItem({ content: { ...content, body: "correction" }, metadata: { carriedInputIds: ["forged-other-input"] } });
      const next = await store.admitSubmission(SESSION_ID, THREAD_ID, correction, { steer: true, steerScope: "active-origin" });
      expect(next.item.metadata?.carriedInputIds).toEqual([older.id]);
      expect((await store.admitSubmission(SESSION_ID, THREAD_ID, older)).item.outcome?.outcome).toBe("superseded");
    });

    it("rejects a carry overflow without changing receipts or admitting the correction", async () => {
      const content = { kind: "signal" as const, signalType: "slack.message", body: "input", origin: { channelType: "slack", threadKey: "slack:C1:1", reply: "auto" as const } };
      const opts = { steer: true, steerScope: "active-origin" as const };
      let previous = makeItem({ content });
      await store.admitSubmission(SESSION_ID, THREAD_ID, previous);
      for (let i = 0; i < 128; i++) {
        const next = makeItem({ content: { ...content, body: `correction ${i}` } });
        await store.admitSubmission(SESSION_ID, THREAD_ID, next, opts);
        previous = next;
      }
      const overflow = makeItem({ content: { ...content, body: "overflow" } });
      await expect(store.admitSubmission(SESSION_ID, THREAD_ID, overflow, opts)).rejects.toThrow("Too many queued Slack inputs");
      expect(await store.getQueueItem(SESSION_ID, overflow.id)).toBeNull();
      expect(await store.getQueueItem(SESSION_ID, previous.id)).toMatchObject({ status: "queued" });
      expect((await store.getQueueItem(SESSION_ID, previous.id))?.supersededByItemId).toBeUndefined();
    });

    it("refuses an unsupported carried attachment without changing either receipt", async () => {
      const content = { kind: "signal" as const, signalType: "slack.message", body: "input", origin: { channelType: "slack", threadKey: "slack:C1:1", reply: "auto" as const } };
      const original = makeItem({ content: { ...content, attachments: [{ type: "image", mimeType: "image/png", name: "missing-image" }] } });
      await store.admitSubmission(SESSION_ID, THREAD_ID, original);
      const correction = makeItem({ content: { ...content, body: "correction" } });
      await expect(store.admitSubmission(SESSION_ID, THREAD_ID, correction, { steer: true, steerScope: "active-origin" })).rejects.toThrow("attachment cannot be carried");
      expect(await store.getQueueItem(SESSION_ID, correction.id)).toBeNull();
      expect(await store.getQueueItem(SESSION_ID, original.id)).toMatchObject({ status: "queued" });
      expect((await store.getQueueItem(SESSION_ID, original.id))?.supersededByItemId).toBeUndefined();
    });

    it("reconstructs promotion carry references from the locked source instead of caller metadata", async () => {
      const content = { kind: "signal" as const, signalType: "slack.message", body: "image", origin: { channelType: "slack", threadKey: "slack:C1:1", reply: "auto" as const } };
      const image = makeItem({ content: { ...content, attachments: [{ type: "image", mimeType: "image/png", data: new Uint8Array([1, 2, 3]) }] } });
      await store.admitSubmission(SESSION_ID, THREAD_ID, image);
      const correction = makeItem({ content: { ...content, body: "stop" } });
      await store.admitSubmission(SESSION_ID, THREAD_ID, correction, { steer: true, steerScope: "active-origin" });
      const promoted = makeItem({ content: correction.content, metadata: { carriedInputIds: ["forged"], carriedInputBridgeIds: ["forged-source"] } });
      const result = await store.admitSubmission(SESSION_ID, THREAD_ID, promoted, { steer: true, steerScope: "active-and-source", promoteFromItemId: correction.id });
      expect(result.item.metadata?.carriedInputIds).toEqual([image.id]);
      expect(result.item.metadata?.carriedInputBridgeIds).toEqual([correction.id]);
      expect((await store.getQueueItem(SESSION_ID, image.id))?.supersededByItemId).toBe(correction.id);
      expect((await store.getQueueItem(SESSION_ID, correction.id))?.supersededByItemId).toBe(promoted.id);
      expect((await store.getQueueItem(SESSION_ID, image.id))?.content).toEqual(image.content);
    });

    it("active steer on an idle thread keeps its admission time", async () => {
      const edit = makeItem({ createdAt: 400, updatedAt: 400 });
      const admitted = await store.admitSubmission(SESSION_ID, THREAD_ID, edit, { steer: true, steerScope: "active" });
      expect(admitted.supersededItemIds).toEqual([]);
      expect(admitted.item.createdAt).toBe(400);
      await expect(store.admitSubmission(SESSION_ID, THREAD_ID, makeItem(), { steerScope: "active" }))
        .rejects.toBeInstanceOf(ValidationError);
    });

    it("an idempotent replay at the cap dedups instead of throwing PendingCapError", async () => {
      const first = await store.admitSubmission(
        SESSION_ID,
        THREAD_ID,
        makeItem({ dispatchId: "d-cap", content: "same" }),
        { maxPending: 1 },
      );
      expect(first.admitted).toBe(true);

      // Thread is already at the cap (1 unsettled item); a fresh admission
      // would be rejected, but replaying the same dispatchId + content must
      // still dedup and return the existing item instead of throwing.
      const replay = await store.admitSubmission(
        SESSION_ID,
        THREAD_ID,
        makeItem({ dispatchId: "d-cap", content: "same" }),
        { maxPending: 1 },
      );
      expect(replay.admitted).toBe(false);
      expect(replay.item.id).toBe(first.item.id);
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

    it("starts the execution clock at a claim with attemptCount 0, not at admission", async () => {
      const admittedAt = Date.now() - 5 * SUBMISSION_TIMEOUT_MS;
      const item = makeItem({ createdAt: admittedAt, updatedAt: admittedAt });
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const before = Date.now();
      const claim = { sessionId: SESSION_ID, threadId: THREAD_ID, itemId: item.id, ownerId: "o" };
      const first = await store.claimSubmission({ ...claim, attemptId: "att-1" });
      const timeoutAt = first?.timeoutAt ?? 0;
      expect(timeoutAt).toBeGreaterThanOrEqual(before + SUBMISSION_TIMEOUT_MS);
      expect(timeoutAt).toBeLessThanOrEqual(Date.now() + SUBMISSION_TIMEOUT_MS);
      expect((await store.getQueueItem(SESSION_ID, item.id))?.timeoutAt).toBe(timeoutAt);

      // A plain release keeps attemptCount, so the next claim keeps the deadline.
      expect(await store.releaseSubmission(SESSION_ID, THREAD_ID, item.id, { itemId: item.id, attemptId: "att-1" })).toBe(true);
      const again = await store.claimSubmission({ ...claim, attemptId: "att-2" });
      expect(again?.attemptCount).toBe(2);
      expect(again?.timeoutAt).toBe(timeoutAt);
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

    // --- releaseSubmission (fenced running→queued, no settlement) ---

    it("releases a running item claimed by the caller's attempt back to queued + deletes the marker", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "owner-1",
      });
      expect(claimed?.status).toBe("running");
      await store.insertAttemptMarker(item.id, "att-1");

      const releasedAt = Date.now();
      const released = await store.releaseSubmission(
        SESSION_ID,
        THREAD_ID,
        item.id,
        { itemId: item.id, attemptId: "att-1" },
        { attempts: 1, lastReleaseAt: releasedAt },
      );
      expect(released).toBe(true);

      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("queued");
      expect(loaded?.attemptId).toBeUndefined();
      expect(loaded?.ownerId).toBeUndefined();
      expect(loaded?.leaseExpiresAt).toBeUndefined();
      // A released claim never consumed run budget: the release DECREMENTS
      // the claim's attempt_count increment (floor 0) in the same atomic
      // write — keyless release cycles must not trip the stuck-head signal
      // or exhaust the generic maxAttempts retry budget.
      expect(loaded?.attemptCount).toBe(0);
      // The DURABLE credential budget landed atomically with the release —
      // it must survive restart (a crash-looping keyless session stays
      // boundedly failing, never an infinite queued→running→queued cycle).
      expect(loaded?.credentialAttempts).toBe(1);
      expect(loaded?.lastCredentialReleaseAt).toBe(releasedAt);
      expect(await store.hasAttemptMarker(item.id, "att-1")).toBe(false);

      // Re-claimable after release.
      const reclaimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-2",
        ownerId: "owner-1",
      });
      expect(reclaimed?.status).toBe("running");
      expect(reclaimed?.attemptCount).toBe(1);
    });

    it("is a no-op on an attempt-id mismatch (a superseding attempt owns it now)", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-live",
        ownerId: "owner-1",
      });
      await store.insertAttemptMarker(item.id, "att-live");
      // A leftover marker for the STALE attempt (e.g. its own insert before it
      // lost the item) must survive too — the stale release is a full no-op.
      await store.insertAttemptMarker(item.id, "att-stale");

      // A stale attempt tries to release — must not touch the live claim.
      const released = await store.releaseSubmission(SESSION_ID, THREAD_ID, item.id, {
        itemId: item.id,
        attemptId: "att-stale",
      });
      expect(released).toBe(false);

      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("running");
      expect(loaded?.attemptId).toBe("att-live");
      // Refused CAS leaves attempt_count exactly as the live claim set it.
      expect(loaded?.attemptCount).toBe(1);
      expect(await store.hasAttemptMarker(item.id, "att-live")).toBe(true);
      // Full no-op: it deleted NEITHER its own stale marker NOR the live one.
      expect(await store.hasAttemptMarker(item.id, "att-stale")).toBe(true);
    });

    it("plain release (no credential payload) keeps the claim's attemptCount increment", async () => {
      // Reconciliation's fresh re-run of a crashed pre-stream attempt is a
      // PLAIN release: the attempt genuinely consumed run budget, and handing
      // it back would let a deterministically crash-looping item oscillate
      // attempt_count net-zero forever, never exhausting the generic
      // maxAttempts retry budget. Only credential releases (separately
      // bounded by the durable credential budget) decrement.
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "owner-1",
      });
      await store.insertAttemptMarker(item.id, "att-1");

      const released = await store.releaseSubmission(SESSION_ID, THREAD_ID, item.id, {
        itemId: item.id,
        attemptId: "att-1",
      });
      expect(released).toBe(true);

      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("queued");
      expect(loaded?.attemptId).toBeUndefined();
      expect(loaded?.attemptCount).toBe(1);
      expect(loaded?.credentialAttempts ?? 0).toBe(0);
      expect(loaded?.lastCredentialReleaseAt).toBeUndefined();
      expect(await store.hasAttemptMarker(item.id, "att-1")).toBe(false);
    });

    it("is a no-op when the item is not running (e.g. still queued)", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);

      const released = await store.releaseSubmission(SESSION_ID, THREAD_ID, item.id, {
        itemId: item.id,
        attemptId: "att-none",
      });
      expect(released).toBe(false);

      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("queued");
    });

    it("REFUSES to release a running item that has been superseded (returns false, no state change, markers untouched)", async () => {
      // TOCTOU pin: a supersession stamp landing between the caller's
      // getQueueItem snapshot and this CAS must make the release refuse —
      // releasing a superseded item to `queued` orphans it (skipped by the
      // claim head and unsettledHead; nothing would ever settle it).
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "owner-1",
      });
      await store.insertAttemptMarker(item.id, "att-1");

      // Steer admission stamps supersededByItemId on the running item.
      const steer = makeItem();
      const { supersededItemIds } = await store.admitSubmission(SESSION_ID, THREAD_ID, steer, {
        steer: true,
      });
      expect(supersededItemIds).toContain(item.id);

      const released = await store.releaseSubmission(
        SESSION_ID,
        THREAD_ID,
        item.id,
        { itemId: item.id, attemptId: "att-1" },
        { attempts: 5, lastReleaseAt: Date.now() },
      );
      expect(released).toBe(false);

      // Full no-op: still running under the same attempt, supersession stamp
      // intact, marker untouched, credential counters NOT written (they ride
      // the CAS — a refused release must not leak a partial counter write).
      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("running");
      expect(loaded?.attemptId).toBe("att-1");
      expect(loaded?.supersededByItemId).toBe(steer.id);
      expect(loaded?.credentialAttempts ?? 0).toBe(0);
      expect(loaded?.lastCredentialReleaseAt).toBeUndefined();
      expect(await store.hasAttemptMarker(item.id, "att-1")).toBe(true);
    });

    it("REFUSES to release a running item with abortRequestedAt stamped (settle aborted, never re-queue)", async () => {
      // An abort landing between the caller's guard check and the CAS must
      // refuse the release: the item settles `aborted` under the current
      // attempt instead of flickering running→queued→aborted.
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "owner-1",
      });
      await store.insertAttemptMarker(item.id, "att-1");
      await store.requestAbort(SESSION_ID, THREAD_ID);

      const released = await store.releaseSubmission(
        SESSION_ID,
        THREAD_ID,
        item.id,
        { itemId: item.id, attemptId: "att-1" },
        { attempts: 1, lastReleaseAt: Date.now() },
      );
      expect(released).toBe(false);

      // Full no-op: still running under the same attempt, abort stamp
      // intact, run budget and credential counters untouched, marker kept.
      const loaded = await store.getQueueItem(SESSION_ID, item.id);
      expect(loaded?.status).toBe("running");
      expect(loaded?.attemptId).toBe("att-1");
      expect(loaded?.abortRequestedAt).toBeDefined();
      expect(loaded?.attemptCount).toBe(1);
      expect(loaded?.credentialAttempts ?? 0).toBe(0);
      expect(await store.hasAttemptMarker(item.id, "att-1")).toBe(true);
    });

    // --- Abort + blocked ---

    it("requestAbort can target one item and rejects a different thread scope", async () => {
      const a = makeItem();
      const b = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, a);
      await store.admitSubmission(SESSION_ID, THREAD_ID, b);
      await store.requestAbort(SESSION_ID, "other-thread", a.id);
      expect((await store.getQueueItem(SESSION_ID, a.id))?.abortRequestedAt).toBeUndefined();
      await store.requestAbort(SESSION_ID, THREAD_ID, a.id);
      expect((await store.getQueueItem(SESSION_ID, a.id))?.abortRequestedAt).toBeDefined();
      expect((await store.getQueueItem(SESSION_ID, b.id))?.abortRequestedAt).toBeUndefined();
    });

    it("requestAbortActiveSubmission stamps only the running item", async () => {
      const active = makeItem({ createdAt: 100, updatedAt: 100 });
      const queued = makeItem({ createdAt: 200, updatedAt: 200 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, active);
      await store.admitSubmission(SESSION_ID, THREAD_ID, queued);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: active.id,
        attemptId: "att-active-abort",
        ownerId: "o",
      });

      const stamped = await store.requestAbortActiveSubmission(SESSION_ID, THREAD_ID, active.id);

      expect(stamped?.id).toBe(active.id);
      expect(stamped?.abortRequestedAt).toBeDefined();
      expect((await store.getQueueItem(SESSION_ID, active.id))?.abortRequestedAt).toBeDefined();
      expect((await store.getQueueItem(SESSION_ID, queued.id))?.abortRequestedAt).toBeUndefined();
    });

    it("keeps a repeated targeted abort from stamping a running successor", async () => {
      const first = makeItem({ createdAt: 100, updatedAt: 100 });
      const successor = makeItem({ createdAt: 200, updatedAt: 200 });
      await store.admitSubmission(SESSION_ID, THREAD_ID, first);
      await store.admitSubmission(SESSION_ID, THREAD_ID, successor);
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: first.id,
        attemptId: "att-first-targeted-abort",
        ownerId: "o",
      });

      expect(
        (await store.requestAbortActiveSubmission(SESSION_ID, THREAD_ID, first.id))?.id,
      ).toBe(first.id);
      await store.forceSettle(SESSION_ID, first.id, "aborted");
      await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: successor.id,
        attemptId: "att-successor-targeted-abort",
        ownerId: "o",
      });

      expect(
        await store.requestAbortActiveSubmission(SESSION_ID, THREAD_ID, first.id),
      ).toBeNull();
      expect(
        (await store.getQueueItem(SESSION_ID, successor.id))?.abortRequestedAt,
      ).toBeUndefined();
      expect(
        (await store.requestAbortActiveSubmission(SESSION_ID, THREAD_ID, successor.id))?.id,
      ).toBe(successor.id);
      expect(
        (await store.getQueueItem(SESSION_ID, successor.id))?.abortRequestedAt,
      ).toBeDefined();
    });

    it("requestAbortActiveSubmission stamps a blocked durable head", async () => {
      const blocked = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, blocked);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: blocked.id,
        attemptId: "att-blocked-abort",
        ownerId: "o",
      });
      await store.setSubmissionBlocked(
        SESSION_ID,
        THREAD_ID,
        blocked.id,
        true,
        { itemId: blocked.id, attemptId: claimed!.attemptId! },
      );

      const stamped = await store.requestAbortActiveSubmission(SESSION_ID, THREAD_ID, blocked.id);

      expect(stamped?.id).toBe(blocked.id);
      expect(stamped?.status).toBe("blocked_on_decision_gate");
      expect(stamped?.abortRequestedAt).toBeDefined();
    });

    it("requestAbortActiveSubmission ignores a queued head", async () => {
      const queued = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, queued);

      expect(await store.requestAbortActiveSubmission(SESSION_ID, THREAD_ID, queued.id)).toBeNull();
      expect((await store.getQueueItem(SESSION_ID, queued.id))?.abortRequestedAt).toBeUndefined();
    });

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

    // --- Operator surface ---

    it("listAllUnsettledSubmissions spans sessions and excludes settled", async () => {
      const OTHER = "sess-3";
      const OTHER_THREAD = "th-other-2";
      await store.saveSession(newSession({ id: OTHER }));
      await store.saveThread(OTHER, { ...newThread(OTHER_THREAD, "web:default"), sessionId: OTHER });

      const unsettledHere = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, unsettledHere);

      const settledHere = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, settledHere);
      await store.settleUnclaimed(SESSION_ID, THREAD_ID, settledHere.id, { outcome: "superseded" });

      const unsettledOther = makeItem({ threadId: OTHER_THREAD });
      await store.admitSubmission(OTHER, OTHER_THREAD, unsettledOther);

      const all = await store.listAllUnsettledSubmissions();
      const ids = all.map((i) => i.id);
      expect(ids).toContain(unsettledHere.id);
      expect(ids).toContain(unsettledOther.id);
      expect(ids).not.toContain(settledHere.id);

      const here = all.find((i) => i.id === unsettledHere.id);
      const other = all.find((i) => i.id === unsettledOther.id);
      expect(here?.sessionId).toBe(SESSION_ID);
      expect(other?.sessionId).toBe(OTHER);
      expect((await store.listAllUnsettledSubmissions([SESSION_ID])).map((i) => i.id)).toEqual([unsettledHere.id]);
      expect(await store.listAllUnsettledSubmissions([])).toEqual([]);
      expect(await store.listAllUnsettledSubmissions(["missing"])).toEqual([]);
      const scoped = await store.listAllUnsettledSubmissions([
        ...Array.from({ length: 1_001 }, (_, i) => `missing-${i}`), OTHER, OTHER,
      ]);
      expect(scoped.map((i) => i.id)).toEqual([unsettledOther.id]);
    });

    it("forceSettle on a running item settles it, clears markers, and fences off the old attempt", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      const claimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-1",
        ownerId: "o",
      });
      await store.insertAttemptMarker(item.id, "att-1");
      expect(await store.hasAttemptMarker(item.id, "att-1")).toBe(true);

      const settled = await store.forceSettle(SESSION_ID, item.id, "failed", "operator killed it");
      expect(settled.status).toBe("settled");
      expect(settled.outcome).toEqual({ outcome: "failed", error: "operator killed it" });

      // Markers gone.
      expect(await store.hasAttemptMarker(item.id, "att-1")).toBe(false);

      // A follow-up claim on the settled item is a no-op (nothing left to claim).
      const reclaimed = await store.claimSubmission({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: item.id,
        attemptId: "att-2",
        ownerId: "o2",
      });
      expect(reclaimed).toBeNull();

      // The zombie attempt's own write self-fences: the item is already
      // settled with a different outcome than the zombie is about to reserve,
      // so its write is rejected (ConflictError) rather than resurrecting it.
      const staleFence: WriteFence = { itemId: item.id, attemptId: claimed!.attemptId! };
      await expect(
        store.reserveSettlement(SESSION_ID, THREAD_ID, item.id, { outcome: "completed" }, staleFence),
      ).rejects.toThrow(ConflictError);
    });

    it("forceSettle twice throws ConflictError", async () => {
      const item = makeItem();
      await store.admitSubmission(SESSION_ID, THREAD_ID, item);
      await store.forceSettle(SESSION_ID, item.id, "aborted");
      await expect(store.forceSettle(SESSION_ID, item.id, "aborted")).rejects.toThrow(ConflictError);
    });

    it("forceSettle on a missing item throws NotFoundError", async () => {
      await expect(store.forceSettle(SESSION_ID, "nope", "failed")).rejects.toThrow(NotFoundError);
    });
  });
}
