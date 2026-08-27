/**
 * Reducer tests for the session stream store. Pure logic — no DOM, no
 * React — exercised directly via the exported store actions.
 *
 * Covers Task 7: offset-based dedupe/advance (replacing seq-dedupe),
 * `queue.state` slice population, `submission.settled` message badges,
 * and gate replay idempotence.
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { WireEvent, WireQueueState } from "@valet/api/wire";
import { queueBusy, useStreamStore } from "./stream";

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

function statusEvent(
  threadId: string,
  status: "queued" | "thinking" | "blocked_on_decision_gate" | "idle",
  ts: number,
): WireEvent {
  return { seq: ts, ts, type: "status", threadId, status };
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

  it("keeps the engine's error text next to a failed settled outcome", () => {
    const { ingest, addUserMessage } = useStreamStore.getState();
    const msgId = addUserMessage(SESSION, "deploy the thing", THREAD);

    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "submission.settled",
      sessionId: SESSION,
      threadId: THREAD,
      queueItemId: msgId,
      outcome: "failed",
      error: "credit balance is too low",
    });

    const slice = useStreamStore.getState().bySession[SESSION];
    const msg = slice.messages.find((m) => m.id === msgId);
    expect(msg?.settledOutcome).toBe("failed");
    expect(msg?.settledError).toBe("credit balance is too low");
  });

  it("leaves settledError undefined when a non-clean outcome carries no reason", () => {
    const { ingest, addUserMessage } = useStreamStore.getState();
    const msgId = addUserMessage(SESSION, "stop that", THREAD);

    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "submission.settled",
      sessionId: SESSION,
      threadId: THREAD,
      queueItemId: msgId,
      outcome: "aborted",
    });

    const slice = useStreamStore.getState().bySession[SESSION];
    const msg = slice.messages.find((m) => m.id === msgId);
    expect(msg?.settledOutcome).toBe("aborted");
    expect(msg?.settledError).toBeUndefined();
  });

  it("clears both the badge and the reason when an item settles completed", () => {
    const { ingest, addUserMessage, setMessageQueueItemId } = useStreamStore.getState();
    const msgId = addUserMessage(SESSION, "retry that", THREAD);
    setMessageQueueItemId(SESSION, msgId, "q-1");

    // The reducer spreads the previous message, so a clean outcome must
    // overwrite `settledError` rather than inherit it.
    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "submission.settled",
      sessionId: SESSION,
      threadId: THREAD,
      queueItemId: "q-1",
      outcome: "failed",
      error: "sandbox is not reachable",
    });
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      offset: offset(2),
      type: "submission.settled",
      sessionId: SESSION,
      threadId: THREAD,
      queueItemId: "q-1",
      outcome: "completed",
    });

    const slice = useStreamStore.getState().bySession[SESSION];
    const msg = slice.messages.find((m) => m.id === msgId);
    expect(msg?.settledOutcome).toBeUndefined();
    expect(msg?.settledError).toBeUndefined();
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

  it("clears a superseded badge when the bubble is remapped onto a promoted item", () => {
    const { ingest, addUserMessage, setMessageQueueItemId } = useStreamStore.getState();
    const msgId = addUserMessage(SESSION, "follow after this turn", THREAD);
    setMessageQueueItemId(SESSION, msgId, "q-1");

    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "submission.settled",
      sessionId: SESSION,
      threadId: THREAD,
      queueItemId: "q-1",
      outcome: "superseded",
    });
    expect(useStreamStore.getState().bySession[SESSION].messages.find((m) => m.id === msgId)
      ?.settledOutcome).toBe("superseded");

    setMessageQueueItemId(SESSION, msgId, "q-2");
    const msg = useStreamStore.getState().bySession[SESSION].messages.find((m) => m.id === msgId);
    expect(msg?.queueItemId).toBe("q-2");
    expect(msg?.promotedFromItemId).toBe("q-1");
    expect(msg?.settledOutcome).toBeUndefined();
    expect(msg?.settledError).toBeUndefined();
  });

  it("ignores a superseded settle for an id this bubble was remapped away from", () => {
    const { ingest, addUserMessage, setMessageQueueItemId } = useStreamStore.getState();
    const msgId = addUserMessage(SESSION, "follow after this turn", THREAD);
    setMessageQueueItemId(SESSION, msgId, "q-1");
    setMessageQueueItemId(SESSION, msgId, "q-2");

    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "submission.settled",
      sessionId: SESSION,
      threadId: THREAD,
      queueItemId: "q-1",
      outcome: "superseded",
    });

    const msg = useStreamStore.getState().bySession[SESSION].messages.find((m) => m.id === msgId);
    expect(msg?.settledOutcome).toBeUndefined();
    expect(msg?.queueItemId).toBe("q-2");
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

  it("setPendingGates keeps the record identity for equal content (idempotent seeding)", () => {
    // More than one surface seeds (SessionView and ThreadTree via
    // usePendingGatesSeed); an equal-content re-seed must not rebuild the
    // record, or every subscriber re-renders once per seeding mount.
    const { setPendingGates } = useStreamStore.getState();
    const gate = {
      id: "gate-1",
      sessionId: SESSION,
      threadId: THREAD,
      type: "approval" as const,
      title: "Approve?",
      actions: [],
      status: "pending" as const,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };

    setPendingGates(SESSION, [gate]);
    const first = useStreamStore.getState().bySession[SESSION].pendingGates;
    setPendingGates(SESSION, [gate]);
    expect(useStreamStore.getState().bySession[SESSION].pendingGates).toBe(first);

    // A content change (here: the gate resolved away) still lands.
    setPendingGates(SESSION, []);
    expect(useStreamStore.getState().bySession[SESSION].pendingGates).toEqual({});
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

describe("streaming tool calls", () => {
  beforeEach(reset);

  function toolCallUpdate(callId: string, argsDelta: string): WireEvent {
    return {
      seq: 0,
      ts: Date.now(),
      type: "tool_call_update",
      threadId: THREAD,
      callId,
      toolName: "write",
      argsDelta,
    };
  }

  it("creates a streaming tool_call part and fills args as deltas accumulate", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, messageStart("m1", 1));
    ingest(SESSION, toolCallUpdate("tc1", ""));
    ingest(SESSION, toolCallUpdate("tc1", '{"path":"/tmp/x",'));

    let m1 = useStreamStore.getState().bySession[SESSION].messages[0];
    expect(m1.parts).toHaveLength(1);
    let part = m1.parts[0];
    if (part.kind !== "tool_call") throw new Error("expected tool_call part");
    expect(part.callId).toBe("tc1");
    expect(part.toolName).toBe("write");
    expect(part.status).toBe("streaming");
    expect(part.args).toEqual({ path: "/tmp/x" });

    ingest(SESSION, toolCallUpdate("tc1", '"content":"hel'));
    m1 = useStreamStore.getState().bySession[SESSION].messages[0];
    part = m1.parts[0];
    if (part.kind !== "tool_call") throw new Error("expected tool_call part");
    expect(part.args).toEqual({ path: "/tmp/x", content: "hel" });
  });

  it("keeps the last parseable args when a delta leaves the JSON mid-key", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, messageStart("m1", 1));
    ingest(SESSION, toolCallUpdate("tc1", '{"path":"/tmp/x"'));
    ingest(SESSION, toolCallUpdate("tc1", ',"conte'));
    const m1 = useStreamStore.getState().bySession[SESSION].messages[0];
    const part = m1.parts[0];
    if (part.kind !== "tool_call") throw new Error("expected tool_call part");
    expect(part.args).toEqual({ path: "/tmp/x" });
  });

  it("tool_start upgrades the streaming part in place (no duplicate) with final args", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, messageStart("m1", 1));
    ingest(SESSION, toolCallUpdate("tc1", '{"path":"/tmp/x"'));
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      offset: offset(2),
      type: "tool_start",
      threadId: THREAD,
      toolName: "write",
      callId: "tc1",
      args: { path: "/tmp/x", content: "full" },
    });

    const m1 = useStreamStore.getState().bySession[SESSION].messages[0];
    expect(m1.parts).toHaveLength(1);
    const part = m1.parts[0];
    if (part.kind !== "tool_call") throw new Error("expected tool_call part");
    expect(part.status).toBe("running");
    expect(part.args).toEqual({ path: "/tmp/x", content: "full" });
  });

  it("tool_start without a matching streaming part still appends (legacy path)", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, messageStart("m1", 1));
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      offset: offset(2),
      type: "tool_start",
      threadId: THREAD,
      toolName: "bash",
      args: { cmd: "ls" },
    });
    const m1 = useStreamStore.getState().bySession[SESSION].messages[0];
    expect(m1.parts).toHaveLength(1);
    expect(m1.parts[0]).toMatchObject({ kind: "tool_call", toolName: "bash", status: "running" });
  });

  it("tool_end resolves the part by callId, not just tool name", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, messageStart("m1", 1));
    // Two same-name calls: tc1 running, tc2 running.
    ingest(SESSION, {
      seq: 2, ts: Date.now(), offset: offset(2), type: "tool_start",
      threadId: THREAD, toolName: "bash", callId: "tc1", args: { cmd: "a" },
    });
    ingest(SESSION, {
      seq: 3, ts: Date.now(), offset: offset(3), type: "tool_start",
      threadId: THREAD, toolName: "bash", callId: "tc2", args: { cmd: "b" },
    });
    // End tc1 (the OLDER one) — name-recency matching would hit tc2.
    ingest(SESSION, {
      seq: 4, ts: Date.now(), offset: offset(4), type: "tool_end",
      threadId: THREAD, toolName: "bash", callId: "tc1", result: "done-a", isError: false,
    });
    const m1 = useStreamStore.getState().bySession[SESSION].messages[0];
    const byCall = Object.fromEntries(
      m1.parts.flatMap((p) => (p.kind === "tool_call" ? [[p.callId, p.status]] : [])),
    );
    expect(byCall).toEqual({ tc1: "completed", tc2: "running" });
  });

  it("message_end abort removes parts still streaming (they were never persisted)", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, messageStart("m1", 1));
    ingest(SESSION, toolCallUpdate("tc1", '{"path":"/tmp/x"'));
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      offset: offset(2),
      type: "message_end",
      threadId: THREAD,
      messageId: "m1",
      reason: "abort",
    });
    const slice = useStreamStore.getState().bySession[SESSION];
    expect(slice.messages[0].parts).toHaveLength(0);
    // The accumulated args scratch dies with the part.
    expect(slice.streamingArgs ?? {}).toEqual({});
  });

  it("message_end abort with an unknown messageId still sweeps the thread's streaming parts", () => {
    // A client that connected mid-turn never saw message_start for the
    // in-flight message; the streaming part sits on an older message.
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, messageStart("m1", 1));
    ingest(SESSION, toolCallUpdate("tc1", '{"path":"/tmp/x"'));
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      offset: offset(2),
      type: "message_end",
      threadId: THREAD,
      messageId: "m-never-seen",
      reason: "abort",
    });
    const slice = useStreamStore.getState().bySession[SESSION];
    expect(slice.messages[0].parts).toHaveLength(0);
    expect(slice.streamingArgs ?? {}).toEqual({});
  });

  it("turn_end sweeps parts still streaming and their scratch (zombie deltas cannot outlive the turn)", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, messageStart("m1", 1));
    ingest(SESSION, toolCallUpdate("tc1", '{"path":"/tmp/x"'));
    // tool_start never arrives (e.g. superseded attempt) — turn ends.
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      offset: offset(2),
      type: "turn_end",
      threadId: THREAD,
      reason: "end_turn",
    });
    const slice = useStreamStore.getState().bySession[SESSION];
    expect(slice.messages[0].parts).toHaveLength(0);
    expect(slice.streamingArgs ?? {}).toEqual({});
  });

  it("message_start sweeps stale streaming parts left by a zombie delta from a prior aborted run", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, messageStart("m1", 1));
    ingest(SESSION, toolCallUpdate("tc1", '{"path":"/tmp/x"'));
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      offset: offset(2),
      type: "message_end",
      threadId: THREAD,
      messageId: "m1",
      reason: "abort",
    });
    // Zombie delta from the aborted attempt lands after cleanup and
    // re-synthesizes a streaming part on m1.
    ingest(SESSION, toolCallUpdate("tc1", ',"content":"stale"'));
    expect(
      useStreamStore.getState().bySession[SESSION].messages[0].parts.length,
    ).toBeGreaterThan(0);
    // The next run's message_start clears it.
    ingest(SESSION, messageStart("m2", 3));
    const slice = useStreamStore.getState().bySession[SESSION];
    const streamingParts = slice.messages.flatMap((m) =>
      m.parts.filter((p) => p.kind === "tool_call" && p.status === "streaming"),
    );
    expect(streamingParts).toHaveLength(0);
    expect(slice.streamingArgs ?? {}).toEqual({});
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
    expect(slice.errorByThread[THREAD]).toEqual({
      code: "run_failed",
      message: "400 credit balance too low",
    });
    expect(slice.statusByThread[THREAD]?.status).toBe("idle");
  });

  it("clears the error when a new message starts streaming", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, errorEvent(1));
    ingest(SESSION, messageStart("m1", 2));
    expect(useStreamStore.getState().bySession[SESSION].errorByThread[THREAD]).toBeUndefined();
  });

  it("clears the error when the user sends a new prompt", () => {
    const { ingest, addUserMessage } = useStreamStore.getState();
    ingest(SESSION, errorEvent(1));
    addUserMessage(SESSION, "retry", THREAD);
    expect(useStreamStore.getState().bySession[SESSION].errorByThread[THREAD]).toBeUndefined();
  });

  it("keeps a thread's error when ANOTHER thread streams or the user prompts it", () => {
    const { ingest, addUserMessage } = useStreamStore.getState();
    const OTHER = "thread-other";
    ingest(SESSION, errorEvent(1));
    // Another thread starts streaming — thread-1's error must survive.
    ingest(SESSION, {
      seq: 2,
      ts: Date.now(),
      offset: offset(2),
      type: "message_start",
      threadId: OTHER,
      messageId: "m-other",
      role: "assistant",
    });
    // The user prompts another thread — still must survive.
    addUserMessage(SESSION, "hi", OTHER);
    expect(useStreamStore.getState().bySession[SESSION].errorByThread[THREAD]).toEqual({
      code: "run_failed",
      message: "400 credit balance too low",
    });
  });

  it("stores an error with no threadId as a session-level error", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, {
      seq: 1,
      ts: Date.now(),
      offset: offset(1),
      type: "error",
      code: "ws_open_failed",
      message: "failed to open session stream",
      recoverable: false,
    });
    const slice = useStreamStore.getState().bySession[SESSION];
    expect(slice.sessionError).toEqual({
      code: "ws_open_failed",
      message: "failed to open session stream",
    });
    expect(slice.errorByThread).toEqual({});
  });
});

describe("turnStartedAt", () => {
  beforeEach(reset);

  function threadStatus(threadId = THREAD) {
    return useStreamStore.getState().bySession[SESSION].statusByThread[threadId];
  }

  it("stamps turnStartedAt on the first non-idle status after idle", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, statusEvent(THREAD, "queued", 1000));
    expect(threadStatus().turnStartedAt).toBe(1000);
  });

  it("does not re-stamp on a later non-idle status within the same turn", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, statusEvent(THREAD, "queued", 1000));
    ingest(SESSION, statusEvent(THREAD, "thinking", 2000));
    expect(threadStatus().turnStartedAt).toBe(1000);
  });

  it("clears turnStartedAt on turn_end", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, statusEvent(THREAD, "queued", 1000));
    ingest(SESSION, { seq: 2, ts: 2000, type: "turn_end", threadId: THREAD, reason: "end_turn" } as WireEvent);
    expect(threadStatus().turnStartedAt).toBeUndefined();
  });

  it("stamps again on the next turn after idle", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, statusEvent(THREAD, "queued", 1000));
    ingest(SESSION, { seq: 2, ts: 2000, type: "turn_end", threadId: THREAD, reason: "end_turn" } as WireEvent);
    ingest(SESSION, statusEvent(THREAD, "queued", 3000));
    expect(threadStatus().turnStartedAt).toBe(3000);
  });
});

describe("per-thread status scoping", () => {
  beforeEach(reset);

  const THREAD_B = "thread-b";

  it("drops a duplicate status frame without churning the entry identity", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, statusEvent(THREAD, "thinking", 1000));
    const before = useStreamStore.getState().bySession[SESSION].statusByThread;
    // Same status again (the engine re-emits tool phases; the handshake
    // seed and durable replay overlap) — the map must keep its identity so
    // subscribers do not re-render.
    ingest(SESSION, statusEvent(THREAD, "thinking", 2000));
    expect(useStreamStore.getState().bySession[SESSION].statusByThread).toBe(before);
  });

  it("a gate-blocked thread does not change another thread's status", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, statusEvent(THREAD, "blocked_on_decision_gate", 1000));
    const byThread = useStreamStore.getState().bySession[SESSION].statusByThread;
    expect(byThread[THREAD].status).toBe("blocked_on_decision_gate");
    expect(byThread[THREAD_B]).toBeUndefined();
  });

  it("turn_end on one thread leaves the other thread's status alone", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, statusEvent(THREAD, "blocked_on_decision_gate", 1000));
    ingest(SESSION, statusEvent(THREAD_B, "thinking", 2000));
    ingest(SESSION, { seq: 3, ts: 3000, type: "turn_end", threadId: THREAD_B, reason: "end_turn" } as WireEvent);
    const byThread = useStreamStore.getState().bySession[SESSION].statusByThread;
    expect(byThread[THREAD].status).toBe("blocked_on_decision_gate");
    expect(byThread[THREAD_B].status).toBe("idle");
  });

  it("an error frame flips only its own thread", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, statusEvent(THREAD, "thinking", 1000));
    ingest(SESSION, {
      seq: 2,
      ts: 2000,
      offset: offset(2),
      type: "error",
      threadId: THREAD_B,
      code: "run_failed",
      message: "boom",
      recoverable: true,
    });
    const byThread = useStreamStore.getState().bySession[SESSION].statusByThread;
    expect(byThread[THREAD].status).toBe("thinking");
    expect(byThread[THREAD_B].status).toBe("error");
  });

  it("init clears every thread's transient status", () => {
    const { ingest } = useStreamStore.getState();
    ingest(SESSION, statusEvent(THREAD, "blocked_on_decision_gate", 1000));
    ingest(SESSION, statusEvent(THREAD_B, "thinking", 2000));
    ingest(SESSION, {
      seq: 3,
      ts: 3000,
      type: "init",
      session: {
        id: SESSION,
        workspace: "/workspace",
        status: "active",
        runState: "idle",
        createdAt: 0,
        updatedAt: 0,
        lastActivityAt: 0,
        owner: { type: "user", id: "user-1" },
        messageCount: 0,
        profile: "headless",
        docker: false,
      },
    });
    expect(useStreamStore.getState().bySession[SESSION].statusByThread).toEqual({});
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

describe("queueBusy", () => {
  const base: WireQueueState = {
    mode: "followup",
    status: "idle",
    pendingIds: [],
    collectingIds: [],
  };

  it("is false for an unknown or idle queue", () => {
    expect(queueBusy(undefined)).toBe(false);
    expect(queueBusy(base)).toBe(false);
  });

  it("is false for an idle queue carrying a stale activeItemId (frame drift)", () => {
    expect(queueBusy({ ...base, activeItemId: "q-stale" })).toBe(false);
  });

  it("is true for a thread paused mid-turn (paused status, claimed item)", () => {
    expect(queueBusy({ ...base, status: "paused", activeItemId: "q-1" })).toBe(true);
  });

  it("is true for a running or gate-blocked turn", () => {
    expect(queueBusy({ ...base, status: "running", activeItemId: "q-1" })).toBe(true);
    expect(
      queueBusy({ ...base, status: "blocked_on_decision_gate", blockedGateId: "g-1" }),
    ).toBe(true);
  });

  it("is true while submissions wait to run — a paused queue included", () => {
    expect(queueBusy({ ...base, status: "queued" })).toBe(true);
    expect(queueBusy({ ...base, status: "paused", pendingIds: ["q-1"] })).toBe(true);
    expect(queueBusy({ ...base, collectingIds: ["q-2"] })).toBe(true);
  });

  it("is false for a paused queue with nothing pending", () => {
    expect(queueBusy({ ...base, status: "paused" })).toBe(false);
  });
});
