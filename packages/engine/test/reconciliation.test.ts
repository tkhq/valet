import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  Type,
} from "@mariozechner/pi-ai";
import {
  decideReconciliation,
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type DecisionGate,
  type MessageEntry,
  type QueueItem,
  type ReconcileContext,
  type SessionStore,
  type SubmissionOutcome,
  type SuspendedTurnState,
  type ToolDef,
  type WriteFence,
} from "../src/index.js";

// ── fixtures ────────────────────────────────────────────────────────

/** Poll an async predicate until it holds or the timeout elapses. */
async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 1500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitForAsync: timed out");
}

const NOW = 1_000_000;

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "q1",
    threadId: "t1",
    content: "hi",
    status: "running",
    attemptId: "att-1",
    attemptCount: 1,
    maxAttempts: 10,
    timeoutAt: NOW + 3_600_000,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...overrides,
  };
}

function ctx(overrides: Partial<ReconcileContext> = {}): ReconcileContext {
  return {
    now: NOW,
    hasTerminalAssistantEntry: false,
    attemptLive: false,
    suspended: null,
    gateStatus: null,
    ...overrides,
  };
}

function suspended(): SuspendedTurnState {
  return {
    sessionId: "s1",
    threadId: "t1",
    queueItemId: "q1",
    gateId: "g1",
    model: "m",
    toolCallId: "tc1",
    toolName: "do_thing",
    toolArgs: {},
    resumeKey: "do_thing:x",
    ordinal: 0,
    attempt: 1,
    createdAt: NOW - 500,
  };
}

// ── Step 0: guards ──────────────────────────────────────────────────

describe("decideReconciliation — step 0 guards", () => {
  it("settled → wait", () => {
    expect(decideReconciliation(item({ status: "settled" }), ctx())).toEqual({ kind: "wait" });
  });

  it("collecting → wait (collect flush owns it)", () => {
    expect(decideReconciliation(item({ status: "collecting" }), ctx())).toEqual({ kind: "wait" });
  });

  it("terminalizing → wait (executor re-runs finalize)", () => {
    expect(decideReconciliation(item({ status: "terminalizing" }), ctx())).toEqual({
      kind: "wait",
    });
  });

  it("live attempt → wait, even when timed out", () => {
    // attemptLive beats everything below it: an unexpired lease + fresh marker
    // means the attempt may still be running; not ours to touch.
    const action = decideReconciliation(
      item({ timeoutAt: NOW - 1 }),
      ctx({ attemptLive: true, hasTerminalAssistantEntry: true }),
    );
    expect(action).toEqual({ kind: "wait" });
  });
});

// ── Step 1: terminal assistant entry beats everything ───────────────

describe("decideReconciliation — step 1 (finished work settles first)", () => {
  it("terminal entry → completed", () => {
    expect(decideReconciliation(item(), ctx({ hasTerminalAssistantEntry: true }))).toEqual({
      kind: "settle",
      outcome: { outcome: "completed" },
    });
  });

  it("terminal entry + abortRequested + exhausted retries + timed out → completed (not aborted/failed)", () => {
    const action = decideReconciliation(
      item({ abortRequestedAt: NOW - 5, attemptCount: 99, maxAttempts: 10, timeoutAt: NOW - 1 }),
      ctx({ hasTerminalAssistantEntry: true }),
    );
    expect(action).toEqual({ kind: "settle", outcome: { outcome: "completed" } });
  });
});

// ── Step 2: abort ───────────────────────────────────────────────────

describe("decideReconciliation — step 2 (abort)", () => {
  it("abortRequestedAt → aborted", () => {
    expect(decideReconciliation(item({ abortRequestedAt: NOW - 5 }), ctx())).toEqual({
      kind: "settle",
      outcome: { outcome: "aborted" },
    });
  });

  it("abort beats supersession + exhausted retries + timeout", () => {
    const action = decideReconciliation(
      item({
        abortRequestedAt: NOW - 5,
        supersededByItemId: "q2",
        attemptCount: 99,
        timeoutAt: NOW - 1,
      }),
      ctx(),
    );
    expect(action).toEqual({ kind: "settle", outcome: { outcome: "aborted" } });
  });
});

// ── Step 3: supersession ────────────────────────────────────────────

describe("decideReconciliation — step 3 (supersession)", () => {
  it("supersededByItemId → superseded", () => {
    expect(decideReconciliation(item({ supersededByItemId: "q2" }), ctx())).toEqual({
      kind: "settle",
      outcome: { outcome: "superseded" },
    });
  });

  it("supersession beats retry budget + timeout", () => {
    const action = decideReconciliation(
      item({ supersededByItemId: "q2", attemptCount: 99, timeoutAt: NOW - 1 }),
      ctx(),
    );
    expect(action).toEqual({ kind: "settle", outcome: { outcome: "superseded" } });
  });
});

// ── Step 4: gate ────────────────────────────────────────────────────

describe("decideReconciliation — step 4 (blocked on gate)", () => {
  it("blocked + suspended + pending gate → rearm_gate", () => {
    const action = decideReconciliation(
      item({ status: "blocked_on_decision_gate" }),
      ctx({ suspended: suspended(), gateStatus: "pending" }),
    );
    expect(action).toEqual({ kind: "rearm_gate" });
  });

  it("blocked + suspended + resolved gate → replay_gate", () => {
    const action = decideReconciliation(
      item({ status: "blocked_on_decision_gate" }),
      ctx({ suspended: suspended(), gateStatus: "resolved" }),
    );
    expect(action).toEqual({ kind: "replay_gate" });
  });

  it("gate-blocked past timeoutAt with pending gate → rearm, NOT failed (timeout exempt)", () => {
    const action = decideReconciliation(
      item({ status: "blocked_on_decision_gate", timeoutAt: NOW - 1 }),
      ctx({ suspended: suspended(), gateStatus: "pending" }),
    );
    expect(action).toEqual({ kind: "rearm_gate" });
  });

  it("expired gate falls through to resume", () => {
    const action = decideReconciliation(
      item({ status: "blocked_on_decision_gate" }),
      ctx({ suspended: suspended(), gateStatus: "expired" }),
    );
    expect(action).toEqual({ kind: "resume" });
  });

  it("withdrawn gate falls through to resume", () => {
    const action = decideReconciliation(
      item({ status: "blocked_on_decision_gate" }),
      ctx({ suspended: suspended(), gateStatus: "withdrawn" }),
    );
    expect(action).toEqual({ kind: "resume" });
  });

  it("missing gate (null) falls through to resume", () => {
    const action = decideReconciliation(
      item({ status: "blocked_on_decision_gate" }),
      ctx({ suspended: suspended(), gateStatus: null }),
    );
    expect(action).toEqual({ kind: "resume" });
  });

  it("blocked but no suspended checkpoint falls through to resume", () => {
    const action = decideReconciliation(
      item({ status: "blocked_on_decision_gate" }),
      ctx({ suspended: null, gateStatus: "pending" }),
    );
    expect(action).toEqual({ kind: "resume" });
  });

  it("expired gate past timeoutAt still resumes (blocked status is timeout-exempt)", () => {
    const action = decideReconciliation(
      item({ status: "blocked_on_decision_gate", timeoutAt: NOW - 1 }),
      ctx({ suspended: suspended(), gateStatus: "expired" }),
    );
    expect(action).toEqual({ kind: "resume" });
  });

  it("expired gate with exhausted retries settles failed (retry budget still applies)", () => {
    const action = decideReconciliation(
      item({ status: "blocked_on_decision_gate", attemptCount: 10, maxAttempts: 10 }),
      ctx({ suspended: suspended(), gateStatus: "expired" }),
    );
    expect(action).toEqual({
      kind: "settle",
      outcome: { outcome: "failed", error: "retry budget exhausted" },
    });
  });
});

// ── Step 5: retry budget ────────────────────────────────────────────

describe("decideReconciliation — step 5 (retry budget)", () => {
  it("attemptCount >= maxAttempts → failed (retry budget exhausted)", () => {
    const action = decideReconciliation(item({ attemptCount: 10, maxAttempts: 10 }), ctx());
    expect(action).toEqual({
      kind: "settle",
      outcome: { outcome: "failed", error: "retry budget exhausted" },
    });
  });

  it("retry budget beats timeout", () => {
    const action = decideReconciliation(
      item({ attemptCount: 10, maxAttempts: 10, timeoutAt: NOW - 1 }),
      ctx(),
    );
    expect(action).toEqual({
      kind: "settle",
      outcome: { outcome: "failed", error: "retry budget exhausted" },
    });
  });
});

// ── Step 6: timeout ─────────────────────────────────────────────────

describe("decideReconciliation — step 6 (timeout)", () => {
  it("now >= timeoutAt → failed (timed out)", () => {
    const action = decideReconciliation(item({ timeoutAt: NOW - 1 }), ctx());
    expect(action).toEqual({ kind: "settle", outcome: { outcome: "failed", error: "timed out" } });
  });

  it("now < timeoutAt → resume", () => {
    expect(decideReconciliation(item({ timeoutAt: NOW + 1 }), ctx())).toEqual({ kind: "resume" });
  });
});

// ── Step 7: resume ──────────────────────────────────────────────────

describe("decideReconciliation — step 7 (resume)", () => {
  it("plain interrupted running item → resume", () => {
    expect(decideReconciliation(item(), ctx())).toEqual({ kind: "resume" });
  });
});

// ── entriesToAgentMessages: multi-round tool answering ──────────────

const SESSION = "sess-recon";
const THREAD = "th-recon";

describe("entriesToAgentMessages — toolResult emission", () => {
  it("answers every completed/error toolCall exactly once, in source order", async () => {
    const { entriesToAgentMessages } = await import("../src/thread.js");
    const now = Date.now();
    const modelHint = { api: "a", provider: "p", id: "m" };
    const entries: MessageEntry[] = [
      {
        id: "e-u",
        sessionId: SESSION,
        threadId: THREAD,
        parentId: null,
        type: "message",
        role: "user",
        content: "go",
        createdAt: now,
      },
      // Round 1: tool A completed before the crash.
      {
        id: "e-a1",
        sessionId: SESSION,
        threadId: THREAD,
        parentId: null,
        type: "message",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "call-A",
            toolName: "read_thing",
            status: "completed",
            args: { path: "/a" },
            result: { text: "contents of A" },
          },
        ],
        createdAt: now + 1,
      },
      // Round 2: tool B crashed and was repaired to error.
      {
        id: "e-a2",
        sessionId: SESSION,
        threadId: THREAD,
        parentId: null,
        type: "message",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "call-B",
            toolName: "read_thing",
            status: "error",
            args: { path: "/b" },
            error: "interrupted — result lost in restart",
          },
        ],
        createdAt: now + 2,
      },
    ];
    const messages = entriesToAgentMessages(entries, modelHint);

    // Shape: user, assistant[A], toolResult A, assistant[B], toolResult B.
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);
    const results = messages.filter((m) => m.role === "toolResult");
    // Exactly one toolResult per callId, in source order.
    expect(results.map((r) => (r.role === "toolResult" ? r.toolCallId : ""))).toEqual([
      "call-A",
      "call-B",
    ]);
    const a = results[0];
    const b = results[1];
    if (a.role !== "toolResult" || b.role !== "toolResult") throw new Error("unreachable");
    expect(a.isError).toBe(false);
    expect(a.content).toEqual([{ type: "text", text: "contents of A" }]);
    expect(b.isError).toBe(true);
    expect(b.content).toEqual([
      { type: "text", text: "interrupted — result lost in restart" },
    ]);
    // Trailing message is toolResult — continuation contract holds.
    expect(messages.at(-1)?.role).toBe("toolResult");
  });

  it("leaves a still-running (suspended-gate) toolCall unanswered for replay to answer", async () => {
    const { entriesToAgentMessages } = await import("../src/thread.js");
    const now = Date.now();
    const entries: MessageEntry[] = [
      {
        id: "e-a",
        sessionId: SESSION,
        threadId: THREAD,
        parentId: null,
        type: "message",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "call-S",
            toolName: "do_thing",
            status: "running",
            args: {},
          },
        ],
        createdAt: now,
      },
    ];
    const messages = entriesToAgentMessages(entries, { api: "a", provider: "p", id: "m" });
    expect(messages.filter((m) => m.role === "toolResult")).toHaveLength(0);
  });

  it("renders an elided tool result's stored placeholder, not a fabricated value", async () => {
    const { entriesToAgentMessages } = await import("../src/thread.js");
    const now = Date.now();
    const entries: MessageEntry[] = [
      {
        id: "e-a",
        sessionId: SESSION,
        threadId: THREAD,
        parentId: null,
        type: "message",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "call-E",
            toolName: "read_thing",
            status: "completed",
            args: {},
            result: { text: "[output elided to save context]" },
            elided: true,
          },
        ],
        createdAt: now,
      },
    ];
    const messages = entriesToAgentMessages(entries, { api: "a", provider: "p", id: "m" });
    const r = messages.find((m) => m.role === "toolResult");
    expect(r && r.role === "toolResult" ? r.content : undefined).toEqual([
      { type: "text", text: "[output elided to save context]" },
    ]);
  });
});

// ── Executor integration ────────────────────────────────────────────

/** A spy tool that records every execution — reconciliation must NEVER re-run it. */
function spyTool(): { def: ToolDef; calls: () => number } {
  let calls = 0;
  const params = Type.Object({ path: Type.String() });
  const def: ToolDef<typeof params> = {
    name: "read_thing",
    description: "spy",
    parameters: params,
    execute: async (args) => {
      calls += 1;
      return { text: `read ${args.path}` };
    },
  };
  return { def, calls: () => calls };
}

/**
 * Hand-craft a crashed session in the store: an admitted+claimed submission
 * whose turn persisted a user message and an assistant message with a dangling
 * (status "running") tool_call part, then "crashed" before settling. Leaves the
 * item `running` with a live marker.
 */
async function seedCrashedRunningTurn(
  store: SessionStore,
  opts: {
    supersededByItemId?: string;
    withGate?: boolean;
    gateExpiresAt?: number;
  } = {},
): Promise<{ itemId: string; attemptId: string; callId: string }> {
  const now = Date.now();
  await store.saveSession({
    id: SESSION,
    owner: { type: "user", id: "u1" },
    userId: "u1",
    orgId: "o1",
    workspace: "/",
    purpose: "interactive",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  await store.saveThread(SESSION, {
    id: THREAD,
    sessionId: SESSION,
    key: "web:default",
    status: "active",
    queueMode: "followup",
    createdAt: now,
    updatedAt: now,
  });

  const itemId = "q-crash";
  const admitItem: QueueItem = {
    id: itemId,
    threadId: THREAD,
    content: "do the thing",
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: now + 3_600_000,
    createdAt: now,
    updatedAt: now,
  };
  await store.admitSubmission(SESSION, THREAD, admitItem);
  const attemptId = "att-crash";
  const claimed = await store.claimSubmission({
    sessionId: SESSION,
    threadId: THREAD,
    itemId,
    attemptId,
    ownerId: "dead-owner",
  });
  if (!claimed) throw new Error("seed: claim failed");
  await store.insertAttemptMarker(itemId, attemptId);
  const fence: WriteFence = { itemId, attemptId };

  const callId = "tc-crash";
  const userEntry: MessageEntry = {
    id: "e-user",
    sessionId: SESSION,
    threadId: THREAD,
    parentId: null,
    type: "message",
    role: "user",
    content: "do the thing",
    queueItemId: itemId,
    createdAt: now,
  };
  const assistantEntry: MessageEntry = {
    id: "e-asst",
    sessionId: SESSION,
    threadId: THREAD,
    parentId: null,
    type: "message",
    role: "assistant",
    content: "working on it",
    parts: [
      { type: "text", text: "working on it" },
      { type: "tool_call", callId, toolName: "read_thing", status: "running", args: { path: "/x" } },
    ],
    queueItemId: itemId,
    createdAt: now + 1,
  };
  await store.appendEntries(SESSION, THREAD, [userEntry, assistantEntry], fence);

  if (opts.supersededByItemId !== undefined) {
    // Stamp supersession the way a steer admission would (transactionally).
    const steer: QueueItem = {
      id: opts.supersededByItemId,
      threadId: THREAD,
      content: "steered",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: now + 3_600_000,
      createdAt: now + 5,
      updatedAt: now + 5,
    };
    await store.admitSubmission(SESSION, THREAD, steer, { steer: true });
  }

  if (opts.withGate) {
    const gate: DecisionGate = {
      id: "g-crash",
      sessionId: SESSION,
      threadId: THREAD,
      queueItemId: itemId,
      resumeKey: "read_thing:/x",
      ordinal: 0,
      type: "approval",
      title: "ok?",
      actions: [],
      status: "pending",
      expiresAt: opts.gateExpiresAt,
      createdAt: now,
      updatedAt: now,
    };
    await store.saveDecisionGate(SESSION, THREAD, gate);
    await store.appendEntries(
      SESSION,
      THREAD,
      [
        {
          id: "e-gate",
          sessionId: SESSION,
          threadId: THREAD,
          parentId: null,
          type: "decision_gate",
          gate,
          queueItemId: itemId,
          createdAt: now,
        },
      ],
      fence,
    );
    await store.saveSuspendedTurn(
      SESSION,
      THREAD,
      {
        sessionId: SESSION,
        threadId: THREAD,
        queueItemId: itemId,
        gateId: gate.id,
        model: "faux",
        toolCallId: callId,
        toolName: "read_thing",
        toolArgs: { path: "/x" },
        resumeKey: "read_thing:/x",
        ordinal: 0,
        attempt: 1,
        createdAt: now,
      },
      fence,
    );
    await store.setSubmissionBlocked(SESSION, THREAD, itemId, true, fence);
  }

  return { itemId, attemptId, callId };
}

describe("reconciliation executor (integration)", () => {
  it("resumes a crashed running turn: dangling tool_call → error, continues, settles completed, no re-execution", async () => {
    const store = new InMemorySessionStore();
    const spy = spyTool();
    const { itemId, callId } = await seedCrashedRunningTurn(store);

    const faux = registerFauxProvider({ provider: "recon-resume" });
    faux.setResponses([fauxAssistantMessage("resumed and done")]);

    const bus = new InMemoryEventStream();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });

    await engine.restoreSession({
      sessionId: SESSION,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: faux.getModel(),
        tools: [spy.def],
      },
    });

    // Item settled completed.
    const settled = await store.getQueueItem(SESSION, itemId);
    expect(settled?.status).toBe("settled");
    expect(settled?.outcome).toEqual({ outcome: "completed" });

    // Dangling tool_call was repaired to an error part — never re-executed.
    const entries = await store.getEntries(SESSION, THREAD);
    const crashed = entries.find(
      (e): e is MessageEntry => e.type === "message" && e.id === "e-asst",
    );
    const part = crashed?.parts?.find((p) => p.type === "tool_call" && p.callId === callId);
    expect(part && part.type === "tool_call" ? part.status : undefined).toBe("error");
    expect(part && part.type === "tool_call" ? part.error : undefined).toContain(
      "result lost in restart",
    );
    expect(spy.calls()).toBe(0);

    // The continuation turn produced a final assistant entry.
    const assistants = entries.filter(
      (e): e is MessageEntry => e.type === "message" && e.role === "assistant",
    );
    expect(assistants.at(-1)?.content).toBe("resumed and done");

    faux.unregister();
  });

  it("resumes a multi-round crashed turn: round-1 tool completed, round-2 tool crashed — both answered, settles completed, no re-execution", async () => {
    // Round 1's tool call (A) completed before the crash; round 2's (B) was
    // mid-flight. The rehydrated context must answer BOTH calls (A from its
    // persisted result, B from the repaired interrupted-error) or a real
    // provider rejects it. entriesToAgentMessages owns all toolResult emission.
    const store = new InMemorySessionStore();
    const spy = spyTool();
    const now = Date.now();
    await store.saveSession({
      id: SESSION,
      owner: { type: "user", id: "u1" },
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      purpose: "interactive",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    await store.saveThread(SESSION, {
      id: THREAD,
      sessionId: SESSION,
      key: "web:default",
      status: "active",
      queueMode: "followup",
      createdAt: now,
      updatedAt: now,
    });
    const itemId = "q-multi";
    await store.admitSubmission(SESSION, THREAD, {
      id: itemId,
      threadId: THREAD,
      content: "do two things",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: now + 3_600_000,
      createdAt: now,
      updatedAt: now,
    });
    const attemptId = "att-multi";
    const claimed = await store.claimSubmission({
      sessionId: SESSION,
      threadId: THREAD,
      itemId,
      attemptId,
      ownerId: "dead-owner",
    });
    if (!claimed) throw new Error("seed: claim failed");
    await store.insertAttemptMarker(itemId, attemptId);
    const fence: WriteFence = { itemId, attemptId };
    await store.appendEntries(
      SESSION,
      THREAD,
      [
        {
          id: "e-user",
          sessionId: SESSION,
          threadId: THREAD,
          parentId: null,
          type: "message",
          role: "user",
          content: "do two things",
          queueItemId: itemId,
          createdAt: now,
        },
        // Round 1: tool A ran to completion, result persisted.
        {
          id: "e-round1",
          sessionId: SESSION,
          threadId: THREAD,
          parentId: null,
          type: "message",
          role: "assistant",
          content: "",
          parts: [
            {
              type: "tool_call",
              callId: "call-A",
              toolName: "read_thing",
              status: "completed",
              args: { path: "/a" },
              result: { text: "contents of A" },
            },
          ],
          queueItemId: itemId,
          createdAt: now + 1,
        },
        // Round 2: tool B started, crash before its result landed.
        {
          id: "e-round2",
          sessionId: SESSION,
          threadId: THREAD,
          parentId: null,
          type: "message",
          role: "assistant",
          content: "",
          parts: [
            {
              type: "tool_call",
              callId: "call-B",
              toolName: "read_thing",
              status: "running",
              args: { path: "/b" },
            },
          ],
          queueItemId: itemId,
          createdAt: now + 2,
        },
      ],
      fence,
    );

    const faux = registerFauxProvider({ provider: "recon-multiround" });
    faux.setResponses([fauxAssistantMessage("multi-round resumed")]);

    const bus = new InMemoryEventStream();
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    await engine.restoreSession({
      sessionId: SESSION,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: faux.getModel(),
        tools: [spy.def],
      },
    });

    const settled = await store.getQueueItem(SESSION, itemId);
    expect(settled?.status).toBe("settled");
    expect(settled?.outcome).toEqual({ outcome: "completed" });

    const entries = await store.getEntries(SESSION, THREAD);
    // Round 1's completed part is untouched; round 2's dangling part repaired.
    const round1 = entries.find((e): e is MessageEntry => e.type === "message" && e.id === "e-round1");
    const partA = round1?.parts?.find((p) => p.type === "tool_call" && p.callId === "call-A");
    expect(partA && partA.type === "tool_call" ? partA.status : undefined).toBe("completed");
    const round2 = entries.find((e): e is MessageEntry => e.type === "message" && e.id === "e-round2");
    const partB = round2?.parts?.find((p) => p.type === "tool_call" && p.callId === "call-B");
    expect(partB && partB.type === "tool_call" ? partB.status : undefined).toBe("error");

    // Continuation completed and neither tool was re-executed.
    const assistants = entries.filter(
      (e): e is MessageEntry => e.type === "message" && e.role === "assistant",
    );
    expect(assistants.at(-1)?.content).toBe("multi-round resumed");
    expect(spy.calls()).toBe(0);

    faux.unregister();
  });

  it("sweep reclaims an expired-lease running item and resumes it (reserve-half stranding)", async () => {
    // A transient reserveSettlement failure can leave an item `running` with the
    // marker intact and the lease ticking; when the lease lapses nothing in the
    // claim loop reclaims it. The sweep's expired-lease reconcile is the fix.
    const store = new InMemorySessionStore();
    const spy = spyTool();

    const faux = registerFauxProvider({ provider: "recon-sweep" });
    faux.setResponses([fauxAssistantMessage("swept and done")]);

    const bus = new InMemoryEventStream();
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const session = await engine.createSession({
      id: "sess-sweep",
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [spy.def],
    });
    const thread = await session.ensureDefaultThread();

    // Seed a stranded running item with an ALREADY-EXPIRED lease and a dangling
    // tool_call — admitted verbatim (bypassing claim) so we can set the past
    // lease directly.
    const now = Date.now();
    const strandedId = "q-strand";
    const attemptId = "att-strand";
    await store.admitSubmission("sess-sweep", thread.id, {
      id: strandedId,
      threadId: thread.id,
      content: "stranded",
      status: "running",
      attemptId,
      ownerId: "dead-owner",
      attemptCount: 1,
      maxAttempts: 10,
      leaseExpiresAt: now - 1000, // expired
      timeoutAt: now + 3_600_000,
      createdAt: now,
      updatedAt: now,
    });
    await store.insertAttemptMarker(strandedId, attemptId);
    const fence: WriteFence = { itemId: strandedId, attemptId };
    await store.appendEntries(
      "sess-sweep",
      thread.id,
      [
        {
          id: "e-strand-user",
          sessionId: "sess-sweep",
          threadId: thread.id,
          parentId: null,
          type: "message",
          role: "user",
          content: "stranded",
          queueItemId: strandedId,
          createdAt: now,
        },
        {
          id: "e-strand-asst",
          sessionId: "sess-sweep",
          threadId: thread.id,
          parentId: null,
          type: "message",
          role: "assistant",
          content: "mid tool",
          parts: [
            { type: "tool_call", callId: "tc-strand", toolName: "read_thing", status: "running", args: { path: "/y" } },
          ],
          queueItemId: strandedId,
          createdAt: now + 1,
        },
      ],
      fence,
    );
    // Rehydrate the live thread's transcript so the resume drive has context.
    thread.rehydrateTranscript(await store.getEntries("sess-sweep", thread.id));

    await session.sweepOnce();

    const settled = await store.getQueueItem("sess-sweep", strandedId);
    expect(settled?.status).toBe("settled");
    expect(settled?.outcome).toEqual({ outcome: "completed" });
    expect(spy.calls()).toBe(0);

    faux.unregister();
  });

  it("settles a superseded crashed turn and withdraws its pending gate (steer-crash cleanup)", async () => {
    const store = new InMemorySessionStore();
    const spy = spyTool();
    const { itemId } = await seedCrashedRunningTurn(store, {
      supersededByItemId: "q-steer",
      withGate: true,
    });

    const faux = registerFauxProvider({ provider: "recon-superseded" });
    faux.setResponses([fauxAssistantMessage("steer turn")]);

    const bus = new InMemoryEventStream();
    const withdrawn: string[] = [];
    bus.subscribe({}, (e) => {
      if (e.event.type === "decision_gate_withdrawn") withdrawn.push(e.event.reason);
    });
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });

    await engine.restoreSession({
      sessionId: SESSION,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: faux.getModel(),
        tools: [spy.def],
      },
    });

    // The superseded item settled `superseded`.
    const settled = await store.getQueueItem(SESSION, itemId);
    expect(settled?.status).toBe("settled");
    expect(settled?.outcome).toEqual({ outcome: "superseded" });

    // Its pending gate was withdrawn durably, reason 'steer'.
    const gate = await store.getDecisionGate(SESSION, "g-crash");
    expect(gate?.status).toBe("withdrawn");
    expect(withdrawn).toContain("steer");

    // No tool re-execution.
    expect(spy.calls()).toBe(0);

    faux.unregister();
  });

  it("restart with an already-expired pending gate terminalizes it and settles the turn (no permanent wedge)", async () => {
    const store = new InMemorySessionStore();
    const spy = spyTool();
    // Gate whose expiresAt is already past at reconciliation time.
    const { itemId } = await seedCrashedRunningTurn(store, {
      withGate: true,
      gateExpiresAt: Date.now() - 1000,
    });

    const faux = registerFauxProvider({ provider: "recon-gate-expired" });
    faux.setResponses([fauxAssistantMessage("resumed after expiry")]);

    const bus = new InMemoryEventStream();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });

    await engine.restoreSession({
      sessionId: SESSION,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: faux.getModel(),
        tools: [spy.def],
      },
    });

    // The re-armed gate's expiry terminalization runs fire-and-forget; wait for
    // the blocked item to reach a terminal, non-blocked state.
    await waitForAsync(async () => (await store.getQueueItem(SESSION, itemId))?.status === "settled");

    const settled = await store.getQueueItem(SESSION, itemId);
    expect(settled?.status).toBe("settled");
    expect(settled?.outcome?.outcome).toBe("completed");

    // Gate durably expired — not left pending.
    const gate = await store.getDecisionGate(SESSION, "g-crash");
    expect(gate?.status).toBe("expired");
    expect(events.some((e) => e.event.type === "decision_gate_expired")).toBe(true);

    // Suspended checkpoint cleared; block flag flipped off.
    expect(await store.getSuspendedTurn(SESSION, THREAD)).toBeNull();

    // No tool re-execution.
    expect(spy.calls()).toBe(0);

    // Thread head is unblocked: a subsequently admitted item gets claimed + settled.
    faux.setResponses([fauxAssistantMessage("next turn")]);
    const session = engine.getSession(SESSION);
    if (!session) throw new Error("session missing");
    const thread = await session.threadByKey("web:default");
    if (!thread) throw new Error("thread missing");
    const next = await thread.submitPrompt("another one", {});
    await waitForAsync(
      async () => (await store.getQueueItem(SESSION, next.queueItemId))?.status === "settled",
    );
    expect((await store.getQueueItem(SESSION, next.queueItemId))?.status).toBe("settled");

    faux.unregister();
  });

  it("re-armed pending gate that expires AFTER restart terminalizes and settles the turn", async () => {
    const store = new InMemorySessionStore();
    const spy = spyTool();
    // Gate expires shortly in the future — arms a real timer at reconcile time.
    const { itemId } = await seedCrashedRunningTurn(store, {
      withGate: true,
      gateExpiresAt: Date.now() + 60,
    });

    const faux = registerFauxProvider({ provider: "recon-gate-expire-later" });
    faux.setResponses([fauxAssistantMessage("resumed after late expiry")]);

    const bus = new InMemoryEventStream();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });

    await engine.restoreSession({
      sessionId: SESSION,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: faux.getModel(),
        tools: [spy.def],
      },
    });

    // Immediately after restart the gate is still pending (armed, not yet expired).
    // Wait for the timer to fire and the terminalization to drive the turn to settle.
    await waitForAsync(
      async () => (await store.getQueueItem(SESSION, itemId))?.status === "settled",
      3000,
    );

    const settled = await store.getQueueItem(SESSION, itemId);
    expect(settled?.status).toBe("settled");
    expect(settled?.outcome?.outcome).toBe("completed");
    const gate = await store.getDecisionGate(SESSION, "g-crash");
    expect(gate?.status).toBe("expired");
    expect(events.some((e) => e.event.type === "decision_gate_expired")).toBe(true);
    expect(spy.calls()).toBe(0);

    faux.unregister();
  });
});

// ── durable submission_settled: deterministic keys + appendOnce ──────
//
// Every settlement path emits `submission_settled` keyed `settled:{itemId}`.
// The unique key makes any double-emission across restart/reconcile paths a
// no-op, so the durable log holds exactly one settled event per item even when
// the settling operation (or a redundant reconcile) runs twice.

function makeLive() {
  const store = new InMemorySessionStore();
  const stream = new InMemoryEventStream();
  const events: BusEvent[] = [];
  stream.subscribe({}, (e) => events.push(e));
  const engine = new Engine({
    providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() },
  });
  return { engine, store, stream, events };
}

async function settledEventsFor(
  stream: InMemoryEventStream,
  sessionId: string,
  itemId: string,
): Promise<Array<{ outcome: SubmissionOutcome; offset: string; queueItemId?: string }>> {
  const { events } = await stream.read(sessionId);
  return events
    .filter((e) => e.event.type === "submission_settled" && e.queueItemId === itemId)
    .map((e) => {
      if (e.event.type !== "submission_settled") throw new Error("unreachable");
      return { outcome: e.event.outcome, offset: e.offset, queueItemId: e.queueItemId };
    });
}

describe("durable submission_settled events", () => {
  it("emits exactly one settled event for an aborted queued item; re-emit under the same key is a no-op", async () => {
    const faux = registerFauxProvider({ provider: "settled-abort" });
    faux.setResponses([fauxAssistantMessage("first-done"), fauxAssistantMessage("second-done")]);

    const { engine, store, stream } = makeLive();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("first");
    await waitForAsync(
      async () => (await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled",
    );
    await session.pause();
    const r2 = await session.thread().submitPrompt("second", {});
    expect((await store.getQueueItem(session.id, r2.queueItemId))?.status).toBe("queued");

    await session.abort();

    const settled = await settledEventsFor(stream, session.id, r2.queueItemId);
    expect(settled).toHaveLength(1);
    expect(settled[0].outcome).toEqual({ outcome: "aborted" });
    expect(settled[0].offset).toMatch(/^\d{16}$/);

    // appendOnce: a redundant reconcile emitting the same deterministic key
    // (`settled:{id}`) must not add a second row.
    await session.emit(
      {
        type: "submission_settled",
        sessionId: session.id,
        threadId: session.thread().id,
        queueItemId: r2.queueItemId,
        outcome: { outcome: "aborted" },
      },
      { eventKey: `settled:${r2.queueItemId}`, queueItemId: r2.queueItemId },
    );
    const after = await settledEventsFor(stream, session.id, r2.queueItemId);
    expect(after).toHaveLength(1);
    expect(after[0].offset).toBe(settled[0].offset);

    faux.unregister();
  });

  it("emits exactly one merged settled event per collect constituent", async () => {
    const faux = registerFauxProvider({ provider: "settled-collect" });
    faux.setResponses([fauxAssistantMessage("merged-done")]);

    const { engine, store, stream } = makeLive();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      queueMode: "collect",
      collectWindowMs: 60,
    });

    const r1 = await session.thread().submitPrompt("one", {});
    const r2 = await session.thread().submitPrompt("two", {});

    await waitForAsync(
      async () =>
        (await store.getQueueItem(session.id, r1.queueItemId))?.outcome?.outcome === "merged" &&
        (await store.getQueueItem(session.id, r2.queueItemId))?.outcome?.outcome === "merged",
    );

    for (const id of [r1.queueItemId, r2.queueItemId]) {
      const settled = await settledEventsFor(stream, session.id, id);
      expect(settled).toHaveLength(1);
      expect(settled[0].outcome).toEqual({ outcome: "merged" });
    }

    faux.unregister();
  });

  it("emits exactly one superseded settled event for a steered item", async () => {
    const faux = registerFauxProvider({ provider: "settled-steer", tokensPerSecond: 30 });
    const longText = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    faux.setResponses([fauxAssistantMessage(longText), fauxAssistantMessage("steer-done")]);

    const { engine, store, stream, events } = makeLive();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("original");
    await waitForAsync(async () => events.some((e) => e.event.type === "text_delta"));
    const r2 = await session.thread().submitPrompt("steer-in", { queueMode: "steer" });

    await waitForAsync(
      async () => (await store.getQueueItem(session.id, r1.queueItemId))?.outcome?.outcome === "superseded",
    );

    const settled = await settledEventsFor(stream, session.id, r1.queueItemId);
    expect(settled).toHaveLength(1);
    expect(settled[0].outcome).toEqual({ outcome: "superseded" });
    expect(settled[0].offset).toMatch(/^\d{16}$/);

    // The steer item itself settles completed — exactly one settled event.
    await waitForAsync(
      async () => (await store.getQueueItem(session.id, r2.queueItemId))?.status === "settled",
    );
    const steerSettled = await settledEventsFor(stream, session.id, r2.queueItemId);
    expect(steerSettled).toHaveLength(1);

    faux.unregister();
  });
});
