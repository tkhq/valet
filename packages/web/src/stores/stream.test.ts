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

describe("setThreadMessages", () => {
  beforeEach(reset);

  it("keeps a mid-stream assistant message that hasn't been persisted to REST yet", () => {
    const { ingest, setThreadMessages } = useStreamStore.getState();

    // The assistant message begins streaming — exists in the store, not
    // yet in any REST snapshot.
    ingest(SESSION, messageStart("asst-1", 1));
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      type: "text_delta",
      threadId: THREAD,
      messageId: "asst-1",
      delta: "hel",
    });

    // A `queue.state`-triggered refetch lands mid-stream, before
    // `message_end`/persistence — REST only knows about the prior turn.
    setThreadMessages(SESSION, THREAD, [
      {
        id: "user-1",
        sessionId: SESSION,
        threadId: THREAD,
        role: "user",
        content: "do the thing",
        parts: [{ kind: "text", text: "do the thing" }],
        createdAt: 1,
      },
    ]);

    const afterRefetch = useStreamStore.getState().bySession[SESSION].messages;
    expect(afterRefetch.map((m) => m.id)).toEqual(["user-1", "asst-1"]);
    const asst = afterRefetch.find((m) => m.id === "asst-1");
    expect(asst?.content).toBe("hel");

    // The stream continues after the merge — subsequent deltas must still
    // find the message (idx >= 0), proving it wasn't dropped.
    ingest(SESSION, {
      seq: 3,
      ts: Date.now(),
      type: "text_delta",
      threadId: THREAD,
      messageId: "asst-1",
      delta: "lo",
    });
    const afterDelta = useStreamStore.getState().bySession[SESSION].messages;
    expect(afterDelta.find((m) => m.id === "asst-1")?.content).toBe("hello");
  });

  it("drops the store's copy once the REST snapshot includes the same id (no duplicate)", () => {
    const { ingest, setThreadMessages } = useStreamStore.getState();

    ingest(SESSION, messageStart("asst-1", 1));
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      type: "text_delta",
      threadId: THREAD,
      messageId: "asst-1",
      delta: "hello",
    });

    // message_end has now arrived and the engine persisted the entry under
    // the same id — the follow-up refetch's REST snapshot includes it.
    setThreadMessages(SESSION, THREAD, [
      {
        id: "asst-1",
        sessionId: SESSION,
        threadId: THREAD,
        role: "assistant",
        content: "hello",
        parts: [{ kind: "text", text: "hello" }],
        createdAt: 1,
      },
    ]);

    const after = useStreamStore.getState().bySession[SESSION].messages;
    expect(after.filter((m) => m.id === "asst-1")).toHaveLength(1);
    expect(after.map((m) => m.id)).toEqual(["asst-1"]);
  });

  it("preserves an optimistic user message not yet reflected in the REST snapshot", () => {
    const { addUserMessage, setThreadMessages } = useStreamStore.getState();
    const localId = addUserMessage(SESSION, "hi there", THREAD);

    setThreadMessages(SESSION, THREAD, []);

    const after = useStreamStore.getState().bySession[SESSION].messages;
    expect(after.map((m) => m.id)).toEqual([localId]);
  });

  it("leaves other threads' messages untouched", () => {
    const { ingest, setThreadMessages } = useStreamStore.getState();
    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "message_start",
      threadId: "other-thread",
      messageId: "other-1",
      role: "assistant",
    });

    setThreadMessages(SESSION, THREAD, []);

    const after = useStreamStore.getState().bySession[SESSION].messages;
    expect(after.map((m) => m.id)).toEqual(["other-1"]);
  });

  it("drops an optimistic user message once its persisted twin (same queueItemId, different id) appears in the REST snapshot", () => {
    const { addUserMessage, setMessageQueueItemId, setThreadMessages } =
      useStreamStore.getState();
    const localId = addUserMessage(SESSION, "hi there", THREAD);
    setMessageQueueItemId(SESSION, localId, "q-1");

    setThreadMessages(SESSION, THREAD, [
      {
        id: "server-user-1",
        sessionId: SESSION,
        threadId: THREAD,
        role: "user",
        content: "hi there",
        parts: [{ kind: "text", text: "hi there" }],
        createdAt: 1,
        queueItemId: "q-1",
      },
    ]);

    const after = useStreamStore.getState().bySession[SESSION].messages;
    expect(after.filter((m) => m.role === "user")).toHaveLength(1);
    expect(after.map((m) => m.id)).toEqual(["server-user-1"]);
  });

  it("drops an unstamped optimistic user message by content match when its REST twin appears before the 202 settles", () => {
    const { addUserMessage, setThreadMessages } = useStreamStore.getState();
    const localId = addUserMessage(SESSION, "hi there", THREAD);
    // No setMessageQueueItemId call — the 202 response (and its queueItemId
    // stamp) hasn't come back yet.

    setThreadMessages(SESSION, THREAD, [
      {
        id: "server-user-1",
        sessionId: SESSION,
        threadId: THREAD,
        role: "user",
        content: "hi there",
        parts: [{ kind: "text", text: "hi there" }],
        createdAt: 1,
      },
    ]);

    const after = useStreamStore.getState().bySession[SESSION].messages;
    expect(after.filter((m) => m.role === "user")).toHaveLength(1);
    expect(after.map((m) => m.id)).toEqual(["server-user-1"]);
    expect(localId).toMatch(/^user-opt-/);
  });
});

describe("turn error visibility", () => {
  beforeEach(reset);

  function errorEvent(off: number): WireEvent {
    return {
      seq: off,
      ts: Date.now(),
      offset: offset(off),
      type: "error",
      threadId: THREAD,
      code: "run_failed",
      message: "400 credit balance too low",
      recoverable: true,
    };
  }

  it("keeps the error through turn_end so a failed turn stays visible", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, errorEvent(1));
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      offset: offset(2),
      type: "turn_end",
      threadId: THREAD,
      reason: "error",
    });

    const slice = useStreamStore.getState().bySession[SESSION];
    expect(slice.error).toEqual({ code: "run_failed", message: "400 credit balance too low" });
    expect(slice.agentStatus).toBe("idle");
  });

  it("clears the error when a new message starts streaming", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, errorEvent(1));
    ingest(SESSION, messageStart("m1", 2));
    expect(useStreamStore.getState().bySession[SESSION].error).toBeUndefined();
  });

  it("clears the error when the user sends a new prompt", () => {
    const { ingest, addUserMessage } = useStreamStore.getState();
    ingest(SESSION, errorEvent(1));
    addUserMessage(SESSION, "retry", THREAD);
    expect(useStreamStore.getState().bySession[SESSION].error).toBeUndefined();
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
