/**
 * Reducer tests for the session stream store. Pure logic — no DOM, no
 * React — exercised directly via the exported store actions.
 *
 * Covers Task 7: offset-based dedupe/advance (replacing seq-dedupe),
 * `queue.state` slice population, `submission.settled` message badges,
 * and gate replay idempotence.
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { WireEvent } from "@valet/api/wire";
import { useStreamStore } from "./stream";

const SESSION = "sess-1";
const THREAD = "thread-1";

function offset(n: number): string {
  return String(n).padStart(16, "0");
}

function reset() {
  useStreamStore.setState({ bySession: {} });
}

function messageStart(id: string, off: number): WireEvent {
  return {
    seq: off,
    ts: Date.now(),
    offset: offset(off),
    type: "message_start",
    threadId: THREAD,
    messageId: id,
    role: "assistant",
  };
}

describe("stream store reducer", () => {
  beforeEach(reset);

  it("advances lastOffset to the max seen and drops frames at/under it, but chunk-style frames never advance it", () => {
    const { ingest } = useStreamStore.getState();

    // Offsets 1, 2, 2 (dup), 3 — three distinct messages should land.
    ingest(SESSION, messageStart("m1", 1));
    ingest(SESSION, messageStart("m2", 2));
    ingest(SESSION, messageStart("m2-dup", 2)); // offset <= lastOffset(2) -> dropped
    ingest(SESSION, messageStart("m3", 3));

    const slice = useStreamStore.getState().bySession[SESSION];
    expect(slice.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(slice.lastOffset).toBe(offset(3));

    // A text_delta ("chunk"-like, high-frequency) frame carries no offset in
    // this test — it must apply (message content updates) without advancing
    // lastOffset.
    const delta: WireEvent = {
      seq: 4,
      ts: Date.now(),
      type: "text_delta",
      threadId: THREAD,
      messageId: "m3",
      delta: "hello",
    };
    ingest(SESSION, delta);
    const after = useStreamStore.getState().bySession[SESSION];
    expect(after.lastOffset).toBe(offset(3)); // unchanged
    const m3 = after.messages.find((m) => m.id === "m3");
    expect(m3?.content).toBe("hello");
  });

  it("populates the queue.state slice for the thread", () => {
    const { ingest } = useStreamStore.getState();
    const ev: WireEvent = {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "queue.state",
      sessionId: SESSION,
      threadId: THREAD,
      state: {
        mode: "followup",
        status: "queued",
        activeItemId: "item-1",
        pendingIds: ["item-2", "item-3"],
        collectingIds: [],
        blockedGateId: undefined,
      },
    };
    ingest(SESSION, ev);
    const slice = useStreamStore.getState().bySession[SESSION];
    const qs = slice.queueByThread?.[THREAD];
    expect(qs).toBeDefined();
    expect(qs?.status).toBe("queued");
    expect(qs?.activeItemId).toBe("item-1");
    expect(qs?.pendingIds).toEqual(["item-2", "item-3"]);
  });

  it("marks a matching user message as superseded on submission.settled", () => {
    const { ingest, addUserMessage } = useStreamStore.getState();
    const msgId = addUserMessage(SESSION, "do the thing", THREAD);

    const ev: WireEvent = {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "submission.settled",
      sessionId: SESSION,
      threadId: THREAD,
      queueItemId: msgId,
      outcome: "superseded",
    };
    ingest(SESSION, ev);

    const slice = useStreamStore.getState().bySession[SESSION];
    const msg = slice.messages.find((m) => m.id === msgId);
    expect(msg?.settledOutcome).toBe("superseded");
  });

  it("marks a matching user message as failed on submission.settled outcome=failed", () => {
    const { ingest, addUserMessage } = useStreamStore.getState();
    const msgId = addUserMessage(SESSION, "do another thing", THREAD);

    const ev: WireEvent = {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "submission.settled",
      sessionId: SESSION,
      threadId: THREAD,
      queueItemId: msgId,
      outcome: "failed",
      error: "boom",
    };
    ingest(SESSION, ev);

    const slice = useStreamStore.getState().bySession[SESSION];
    const msg = slice.messages.find((m) => m.id === msgId);
    expect(msg?.settledOutcome).toBe("failed");
  });

  it("matches submission.settled to the exact queueItemId, not the most recently sent message", () => {
    const { ingest, addUserMessage, setMessageQueueItemId } = useStreamStore.getState();

    // Two unsettled prompts queued back to back: A first, then B.
    const idA = addUserMessage(SESSION, "prompt A", THREAD);
    setMessageQueueItemId(SESSION, idA, "q-a");
    const idB = addUserMessage(SESSION, "prompt B", THREAD);
    setMessageQueueItemId(SESSION, idB, "q-b");

    // A settles (superseded) — even though B is the more recently sent
    // unsettled message, the exact queueItemId match must badge A.
    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "submission.settled",
      sessionId: SESSION,
      threadId: THREAD,
      queueItemId: "q-a",
      outcome: "superseded",
    });

    const slice = useStreamStore.getState().bySession[SESSION];
    const msgA = slice.messages.find((m) => m.id === idA);
    const msgB = slice.messages.find((m) => m.id === idB);
    expect(msgA?.settledOutcome).toBe("superseded");
    expect(msgB?.settledOutcome).toBeUndefined();
  });

  it("badges nothing when the queueItemId doesn't match any message and multiple messages are unsettled", () => {
    const { ingest, addUserMessage, setMessageQueueItemId } = useStreamStore.getState();

    const idA = addUserMessage(SESSION, "prompt A", THREAD);
    setMessageQueueItemId(SESSION, idA, "q-a");
    const idB = addUserMessage(SESSION, "prompt B", THREAD);
    setMessageQueueItemId(SESSION, idB, "q-b");

    // Settled event references a queueItemId that doesn't match any known
    // message (e.g. linkage never landed). With two candidates unsettled,
    // the recency heuristic is ambiguous — neither should be badged.
    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "submission.settled",
      sessionId: SESSION,
      threadId: THREAD,
      queueItemId: "q-unknown",
      outcome: "superseded",
    });

    const slice = useStreamStore.getState().bySession[SESSION];
    const msgA = slice.messages.find((m) => m.id === idA);
    const msgB = slice.messages.find((m) => m.id === idB);
    expect(msgA?.settledOutcome).toBeUndefined();
    expect(msgB?.settledOutcome).toBeUndefined();
  });

  it("does not duplicate a pending gate when the same gate is redelivered at a higher offset", () => {
    const { ingest } = useStreamStore.getState();
    const gate = {
      id: "gate-1",
      sessionId: SESSION,
      threadId: THREAD,
      type: "approval" as const,
      title: "Approve?",
      actions: [],
      status: "pending" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // First delivery at offset 5.
    ingest(SESSION, {
      seq: 5,
      ts: Date.now(),
      offset: offset(5),
      type: "decision_gate",
      threadId: THREAD,
      gate,
    });
    // A lower-offset replay is trivially dropped by the offset check before
    // it ever reaches the pendingGates merge — that path doesn't exercise
    // the merge logic at all. What actually needs coverage is a *fresh*
    // delivery of the same gateId at a HIGHER offset (e.g. the engine
    // re-emits the still-pending gate on reconnect/replay past the last
    // seen offset) — this must still land as exactly one entry keyed by
    // gateId, not append a duplicate.
    ingest(SESSION, {
      seq: 6,
      ts: Date.now(),
      offset: offset(6),
      type: "decision_gate",
      threadId: THREAD,
      gate,
    });

    const slice = useStreamStore.getState().bySession[SESSION];
    expect(Object.keys(slice.pendingGates)).toEqual(["gate-1"]);
    expect(slice.lastOffset).toBe(offset(6));
  });

  it("applies sandbox.status updates", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "sandbox.status",
      state: "provisioning",
      epoch: 1,
      estimateMs: 8000,
    });
    let slice = useStreamStore.getState().bySession[SESSION];
    expect(slice.sandbox).toEqual({ state: "provisioning", epoch: 1 });

    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      offset: offset(2),
      type: "sandbox.status",
      state: "ready",
      epoch: 1,
    });
    slice = useStreamStore.getState().bySession[SESSION];
    expect(slice.sandbox).toEqual({ state: "ready", epoch: 1 });
  });

  it("drops a sandbox.status event whose epoch regresses relative to the stored one", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "sandbox.status",
      state: "ready",
      epoch: 2,
    });
    // A later-offset frame reporting a lower epoch — e.g. a stale
    // re-provision-loop replay — must not clobber the newer epoch's state.
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      offset: offset(2),
      type: "sandbox.status",
      state: "error",
      epoch: 1,
    });
    const slice = useStreamStore.getState().bySession[SESSION];
    expect(slice.sandbox).toEqual({ state: "ready", epoch: 2 });
    // The offset still advances — this is an epoch-level drop, not an
    // offset-level one.
    expect(slice.lastOffset).toBe(offset(2));
  });

  it("clears sandbox status on reset()", () => {
    const { ingest, reset: resetSession } = useStreamStore.getState();
    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "sandbox.status",
      state: "ready",
      epoch: 1,
    });
    expect(useStreamStore.getState().bySession[SESSION].sandbox).toBeDefined();
    resetSession(SESSION);
    expect(useStreamStore.getState().bySession[SESSION].sandbox).toBeUndefined();
  });
});

describe("store default slice", () => {
  beforeEach(reset);

  it("has no entry in bySession for an unknown session (EMPTY is synthesized on read)", () => {
    // `useSessionStream` is a React hook (wraps useStreamStore + a
    // selector) and can't be invoked outside a component render; this
    // exercises the same underlying state it reads from instead.
    const slice = useStreamStore.getState().bySession["nope"];
    expect(slice).toBeUndefined();
  });
});
