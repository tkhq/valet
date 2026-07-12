import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  Type,
} from "@mariozechner/pi-ai";
import {
  decideReconciliation,
  Engine,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type DecisionGate,
  type MessageEntry,
  type QueueItem,
  type ReconcileContext,
  type SessionStore,
  type SuspendedTurnState,
  type ToolDef,
  type WriteFence,
} from "../src/index.js";

// ── fixtures ────────────────────────────────────────────────────────

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

// ── Executor integration ────────────────────────────────────────────

const SESSION = "sess-recon";
const THREAD = "th-recon";

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
      type: "approval",
      title: "ok?",
      actions: [],
      status: "pending",
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

    const bus = new InMemoryEventBus();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const engine = new Engine({
      providers: { store, bus, sandboxProvider: new VirtualSandboxProvider() },
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

  it("sweep reclaims an expired-lease running item and resumes it (reserve-half stranding)", async () => {
    // A transient reserveSettlement failure can leave an item `running` with the
    // marker intact and the lease ticking; when the lease lapses nothing in the
    // claim loop reclaims it. The sweep's expired-lease reconcile is the fix.
    const store = new InMemorySessionStore();
    const spy = spyTool();

    const faux = registerFauxProvider({ provider: "recon-sweep" });
    faux.setResponses([fauxAssistantMessage("swept and done")]);

    const bus = new InMemoryEventBus();
    const engine = new Engine({
      providers: { store, bus, sandboxProvider: new VirtualSandboxProvider() },
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

    const bus = new InMemoryEventBus();
    const withdrawn: string[] = [];
    bus.subscribe({}, (e) => {
      if (e.event.type === "decision_gate_withdrawn") withdrawn.push(e.event.reason);
    });
    const engine = new Engine({
      providers: { store, bus, sandboxProvider: new VirtualSandboxProvider() },
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
});
