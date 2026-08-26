import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  GATE_EXPIRY_DEFAULT_MS,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type DecisionGate,
  type SessionEntry,
  type ToolDef,
  type WriteFence,
} from "../src/index.js";
import { fromRequest } from "../src/decision-gate.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, bus, events };
}

/** A tool whose execute() requests a decision and returns its result text. */
function approvalTool(): ToolDef {
  return {
    name: "do_thing",
    description: "Do a sensitive thing, gated by approval.",
    parameters: Type.Object({ arg: Type.String() }),
    execute: async (args, ctx) => {
      const resolution = await ctx.requestDecision({
        type: "approval",
        title: "approve do_thing?",
        body: `arg=${args.arg}`,
        resumeKey: `do_thing:${args.arg}`,
      });
      if (resolution.actionId === "approve") {
        return { text: `did the thing with arg=${args.arg}` };
      }
      return { text: `denied` };
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Async-predicate variant of waitFor, for polling store state. */
async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 1500,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("decision gates: pending -> resolved", () => {
  it("opens a gate, the turn pauses, resolution resumes the turn", async () => {
    const faux = registerFauxProvider({ provider: "gate-resolved" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "x" }, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("all done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [approvalTool()],
    });

    void session.prompt("please do thing");

    // Wait until we observe a decision_gate event
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));
    const gateEvent = events.find((e) => e.event.type === "decision_gate")!;
    const gate: DecisionGate = (gateEvent.event as { gate: DecisionGate }).gate;
    expect(gate.type).toBe("approval");
    expect(gate.status).toBe("pending");

    // The DAG should contain a decision_gate entry
    const entries = await session.readEntries("web:default");
    const gateEntries = entries.filter((e) => e.type === "decision_gate");
    expect(gateEntries).toHaveLength(1);

    // The thread is blocked
    const blocked = events.some(
      (e) => e.event.type === "status" && e.event.status === "blocked_on_decision_gate",
    );
    expect(blocked).toBe(true);

    // Resolve approve → turn should resume and complete
    await session.resolveDecision(gate.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });

    await waitFor(() =>
      events.some((e) => e.event.type === "status" && e.event.status === "idle"),
    );

    // The assistant emitted a "all done" final message
    const allEntries = await session.readEntries("web:default");
    const messages = allEntries.filter((e) => e.type === "message");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "all done" });

    // The gate event was emitted as resolved
    const resolved = events.find((e) => e.event.type === "decision_gate_resolved");
    expect(resolved).toBeTruthy();

    faux.unregister();
  });
});

describe("decision gates: pending -> withdrawn (abort)", () => {
  it("aborting the thread withdraws the pending gate", async () => {
    const faux = registerFauxProvider({ provider: "gate-withdrawn" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "y" }, { id: "tc2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("would never reach this"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [approvalTool()],
    });

    void session.prompt("please do thing");
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));

    await session.abort();

    const withdrawn = events.find((e) => e.event.type === "decision_gate_withdrawn");
    expect(withdrawn).toBeTruthy();
    expect((withdrawn!.event as { reason: string }).reason).toBe("abort");

    faux.unregister();
  });
});

describe("decision gates: pending -> expired", () => {
  it("a gate with a past expiresAt fires expired and rejects the tool", async () => {
    const faux = registerFauxProvider({ provider: "gate-expired" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("expiring", {}, { id: "tcE" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("never reached"),
    ]);

    const expiringTool: ToolDef = {
      name: "expiring",
      description: "expires fast",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        await ctx.requestDecision({
          type: "approval",
          title: "expire me",
          expiresAt: Date.now() + 30, // expires 30ms from now
          resumeKey: "expire-me-1",
        });
        return { text: "should not reach" };
      },
    };

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [expiringTool],
    });

    void session.prompt("trigger");
    await waitFor(() => events.some((e) => e.event.type === "decision_gate_expired"), 2000);

    faux.unregister();
  });
});

describe("decision gates: steer cancels pending gate", () => {
  it("a steer prompt withdraws the pending gate with reason=steer, and a late resolveDecision no-ops", async () => {
    const faux = registerFauxProvider({ provider: "gate-steer" });
    // First response: tool call that opens a gate. Withdrawing the gate makes
    // the tool return an error result (not a hard agent abort), so
    // pi-agent-core's loop always gives the model one more follow-up call to
    // react to that error before the turn can end — that call's content is
    // irrelevant here (decideTurnOutcome forces `superseded` regardless of
    // how A's turn actually terminates once supersededByItemId is stamped).
    // Third response is S's real completion.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "z" }, { id: "tc3" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("a's discarded follow-up"),
      fauxAssistantMessage("after steer"),
    ]);

    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [approvalTool()],
    });

    const r1 = await session.prompt("first");
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));
    const gateEvent = events.find((e) => e.event.type === "decision_gate")!;
    const gate: DecisionGate = (gateEvent.event as { gate: DecisionGate }).gate;

    // Steer — the durable supersession stamp lands before the gate withdrawal.
    const r2 = await session.thread().submitPrompt("second", { queueMode: "steer" });

    await waitFor(() => events.some((e) => e.event.type === "decision_gate_withdrawn"));
    const withdrawn = events.find((e) => e.event.type === "decision_gate_withdrawn");
    expect((withdrawn!.event as { reason: string }).reason).toBe("steer");

    await waitForAsync(async () => (await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled");
    const beforeLateResolve = await store.getQueueItem(session.id, r1.queueItemId);
    expect(beforeLateResolve?.outcome).toEqual({ outcome: "superseded" });
    expect(beforeLateResolve?.supersededByItemId).toBe(r2.queueItemId);

    // Late resolve against the withdrawn gate: must be a no-op — it neither
    // resumes the superseded turn nor mutates its durable record.
    await session.resolveDecision(gate.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });

    await waitForAsync(async () => (await store.getQueueItem(session.id, r2.queueItemId))?.status === "settled");
    const afterLateResolve = await store.getQueueItem(session.id, r1.queueItemId);
    expect(afterLateResolve).toEqual(beforeLateResolve);

    const s = await store.getQueueItem(session.id, r2.queueItemId);
    expect(s?.outcome).toEqual({ outcome: "completed" });

    faux.unregister();
  });
});

describe("decision gates: ordinal defaults (fromRequest)", () => {
  it("assigns a per-type default expiry when the request omits expiresAt", () => {
    const before = Date.now();
    const approval = fromRequest(
      { type: "approval", title: "a", resumeKey: "k" },
      { sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k", ordinal: 0 },
    );
    const credential = fromRequest(
      { type: "credential_request", title: "c", resumeKey: "k" },
      { sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k", ordinal: 0 },
    );
    const after = Date.now();

    expect(approval.expiresAt).toBeGreaterThanOrEqual(before + GATE_EXPIRY_DEFAULT_MS.approval);
    expect(approval.expiresAt).toBeLessThanOrEqual(after + GATE_EXPIRY_DEFAULT_MS.approval);
    expect(credential.expiresAt).toBeGreaterThanOrEqual(
      before + GATE_EXPIRY_DEFAULT_MS.credential_request,
    );
    expect(credential.expiresAt).toBeLessThanOrEqual(
      after + GATE_EXPIRY_DEFAULT_MS.credential_request,
    );
    expect(approval.ordinal).toBe(0);
    expect(approval.id).toBe("gate:s:t:q:k:0");
  });

  it("honours an explicit expiresAt over the default", () => {
    const explicit = Date.now() + 1234;
    const gate = fromRequest(
      { type: "approval", title: "a", resumeKey: "k", expiresAt: explicit },
      { sessionId: "s", threadId: "t", queueItemId: "q", resumeKey: "k", ordinal: 2 },
    );
    expect(gate.expiresAt).toBe(explicit);
    expect(gate.id).toBe("gate:s:t:q:k:2");
  });
});

describe("decision gates: retry after denial mints a fresh ordinal", () => {
  it("a second requestDecision with the same resumeKey opens gate :1 while :0 stays resolved", async () => {
    const faux = registerFauxProvider({ provider: "gate-retry" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("retry_thing", {}, { id: "tcR" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("all settled"),
    ]);

    // Tool asks twice under the SAME resumeKey: a denial triggers a retry.
    const retryTool: ToolDef = {
      name: "retry_thing",
      description: "asks twice under one resumeKey",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        const r1 = await ctx.requestDecision({
          type: "approval",
          title: "first",
          resumeKey: "rk",
        });
        if (r1.actionId === "deny") {
          const r2 = await ctx.requestDecision({
            type: "approval",
            title: "retry",
            resumeKey: "rk",
          });
          return { text: `second=${r2.actionId}` };
        }
        return { text: "approved first" };
      },
    };

    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [retryTool],
    });

    void session.prompt("go");

    await waitFor(() => events.filter((e) => e.event.type === "decision_gate").length >= 1);
    const gate0: DecisionGate = (
      events.find((e) => e.event.type === "decision_gate")!.event as { gate: DecisionGate }
    ).gate;
    expect(gate0.id.endsWith(":0")).toBe(true);
    expect(gate0.ordinal).toBe(0);

    // Deny gate 0 → the tool retries and opens a fresh gate.
    await session.resolveDecision(gate0.id, {
      actionId: "deny",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });

    await waitFor(
      () => events.filter((e) => e.event.type === "decision_gate").length >= 2,
      3000,
    );
    const gate1: DecisionGate = (
      events.filter((e) => e.event.type === "decision_gate")[1].event as { gate: DecisionGate }
    ).gate;
    expect(gate1.id).not.toBe(gate0.id);
    expect(gate1.id.endsWith(":1")).toBe(true);
    expect(gate1.ordinal).toBe(1);

    // Gate 0 stays terminal (resolved) — the retry did not mutate it.
    expect((await store.getDecisionGate(session.id, gate0.id))?.status).toBe("resolved");

    // Approve gate 1 → the turn completes.
    await session.resolveDecision(gate1.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });
    await waitFor(() =>
      events.some((e) => e.event.type === "status" && e.event.status === "idle"),
    );

    faux.unregister();
  });
});

describe("decision gates: two gated tool calls in one block (TKAI-238)", () => {
  it("serializes gate opens: both gates resolve in turn and no pending gate is left behind", async () => {
    const faux = registerFauxProvider({ provider: "gate-parallel" });
    // One assistant message with TWO gated tool calls. pi-agent-core executes
    // a block's tool calls in parallel, so both requestDecision calls race on
    // the same queue item.
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("do_thing", { arg: "a" }, { id: "tcA" }),
          fauxToolCall("do_thing", { arg: "b" }, { id: "tcB" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("both done"),
    ]);

    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [approvalTool()],
    });

    void session.prompt("do both things");

    // First gate opens; approve it.
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));
    const gate1: DecisionGate = (
      events.find((e) => e.event.type === "decision_gate")!.event as { gate: DecisionGate }
    ).gate;
    await session.resolveDecision(gate1.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });

    // The second gate must open AFTER the first resolves — not fail silently.
    await waitFor(
      () => events.filter((e) => e.event.type === "decision_gate").length >= 2,
      3000,
    );
    const gate2: DecisionGate = (
      events.filter((e) => e.event.type === "decision_gate")[1].event as { gate: DecisionGate }
    ).gate;
    expect(gate2.id).not.toBe(gate1.id);
    await session.resolveDecision(gate2.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });

    await waitFor(
      () => events.some((e) => e.event.type === "status" && e.event.status === "idle"),
      3000,
    );

    // Both tools ran for real — their results reached the transcript.
    const entries = await session.readEntries("web:default");
    const partTexts = entries
      .filter((e) => e.type === "message" && e.role === "assistant" && e.parts)
      .flatMap((e) => e.parts!)
      .filter((p) => p.type === "tool_call")
      .map((p) => JSON.stringify((p as { result?: unknown }).result ?? ""));
    expect(partTexts.some((t) => t.includes("did the thing with arg=a"))).toBe(true);
    expect(partTexts.some((t) => t.includes("did the thing with arg=b"))).toBe(true);

    // No orphan: every persisted gate is terminal, two of them resolved.
    const gates = await store.listDecisionGates(session.id);
    expect(gates.filter((g) => g.status === "pending")).toHaveLength(0);
    expect(gates.filter((g) => g.status === "resolved")).toHaveLength(2);

    faux.unregister();
  });
});

describe("decision gates: orphaned pending gate with no waiter (TKAI-238)", () => {
  /** Build a session + an orphaned pending gate row/entry with no waiter. */
  async function makeOrphan() {
    const faux = registerFauxProvider({ provider: "gate-orphan" });
    faux.setResponses([fauxAssistantMessage("hi")]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [],
    });
    await session.prompt("hello");
    await waitFor(() => events.some((e) => e.event.type === "status" && e.event.status === "idle"));
    const threadId = (await session.readEntries("web:default"))[0]!.threadId;

    // Simulate an orphan: a pending row + DAG entry whose waiter was never
    // registered (the open sequence failed partway on an older build).
    const gate = fromRequest(
      { type: "approval", title: "orphan?", resumeKey: "orphan-key" },
      {
        sessionId: session.id,
        threadId,
        queueItemId: "q-gone",
        resumeKey: "orphan-key",
        ordinal: 0,
      },
    );
    await store.saveDecisionGate(session.id, threadId, gate);
    const entry: SessionEntry = {
      id: "e-orphan",
      sessionId: session.id,
      threadId,
      parentId: null,
      type: "decision_gate",
      gate,
      createdAt: Date.now(),
    };
    await store.appendEntries(session.id, threadId, [entry]);
    return { faux, store, events, session, threadId, gate };
  }

  it("resolveDecision terminally resolves the orphan instead of silently no-oping", async () => {
    const { faux, store, events, session, gate } = await makeOrphan();

    await session.resolveDecision(gate.id, {
      actionId: "deny",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });

    expect((await store.getDecisionGate(session.id, gate.id))?.status).toBe("resolved");
    // The resolved event reaches live clients so the card clears.
    expect(
      events.some(
        (e) => e.event.type === "decision_gate_resolved" && e.event.gateId === gate.id,
      ),
    ).toBe(true);
    // The DAG entry is terminal too, so a refresh does not resurrect the card.
    const entries = await session.readEntries("web:default");
    const ge = entries.find((e) => e.type === "decision_gate" && e.gate.id === gate.id);
    expect(ge && ge.type === "decision_gate" ? ge.gate.status : undefined).toBe("resolved");

    faux.unregister();
  });

  it("withdrawDecision terminally withdraws the orphan", async () => {
    const { faux, store, events, session, gate } = await makeOrphan();

    await session.withdrawDecision(gate.id, "cancel");

    expect((await store.getDecisionGate(session.id, gate.id))?.status).toBe("withdrawn");
    expect(
      events.some(
        (e) => e.event.type === "decision_gate_withdrawn" && e.event.gateId === gate.id,
      ),
    ).toBe(true);

    faux.unregister();
  });

  it("leaves a suspended-turn gate alone — reconciliation owns its replay", async () => {
    const { faux, store, session, threadId, gate } = await makeOrphan();

    // A checkpoint referencing the gate means it is NOT an orphan: after a
    // restart, reconcileGate re-arms it and a store-side resolve would
    // bypass replay.
    await store.saveSuspendedTurn(session.id, threadId, {
      sessionId: session.id,
      threadId,
      queueItemId: "q-gone",
      gateId: gate.id,
      model: "m",
      toolCallId: "tc",
      toolName: "do_thing",
      toolArgs: {},
      resumeKey: "orphan-key",
      ordinal: 0,
      attempt: 1,
      createdAt: Date.now(),
    });

    await session.resolveDecision(gate.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });

    expect((await store.getDecisionGate(session.id, gate.id))?.status).toBe("pending");

    faux.unregister();
  });
});

describe("decision gates: gate open fails partway (TKAI-238)", () => {
  class FlakyBlockStore extends InMemorySessionStore {
    failNextBlock = false;
    override async setSubmissionBlocked(
      sessionId: string,
      threadId: string,
      itemId: string,
      blocked: boolean,
      fence: WriteFence,
    ): Promise<void> {
      if (blocked && this.failNextBlock) {
        this.failNextBlock = false;
        throw new Error("injected block failure");
      }
      return super.setSubmissionBlocked(sessionId, threadId, itemId, blocked, fence);
    }
  }

  it("withdraws the just-persisted gate so no pending row survives the failure", async () => {
    const faux = registerFauxProvider({ provider: "gate-open-fail" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "x" }, { id: "tcF" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("recovered"),
    ]);

    const store = new FlakyBlockStore();
    const bus = new InMemoryEventStream();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [approvalTool()],
    });

    store.failNextBlock = true;
    await session.prompt("go");
    await waitFor(() => events.some((e) => e.event.type === "status" && e.event.status === "idle"));

    // The gate the failed open persisted must be terminal, not pending.
    const gates = await store.listDecisionGates(session.id);
    expect(gates.filter((g) => g.status === "pending")).toHaveLength(0);
    expect(gates.filter((g) => g.status === "withdrawn")).toHaveLength(1);
    // The checkpoint did not leak either.
    const threadId = gates[0]!.threadId;
    expect(await store.getSuspendedTurn(session.id, threadId)).toBeFalsy();

    faux.unregister();
  });
});

describe("decision gates: durable expiry sweep", () => {
  it("sweepOnce expires a lapsed pending gate whose in-process timer was lost", async () => {
    const store = new InMemorySessionStore();
    const sandboxProvider = new VirtualSandboxProvider();
    const SID = "sess-sweep";

    // A tool that opens a gate with a far-future expiry, so no live timer fires
    // during the test — only the sweep (after we rewrite the deadline) can.
    const farTool: ToolDef = {
      name: "do_thing",
      description: "gate with a far-future deadline",
      parameters: Type.Object({ arg: Type.String() }),
      execute: async (args, ctx) => {
        const r = await ctx.requestDecision({
          type: "approval",
          title: "ok?",
          resumeKey: `do_thing:${args.arg}`,
          expiresAt: Date.now() + 3_600_000,
        });
        return { text: `did ${r.actionId}` };
      },
    };

    const faux1 = registerFauxProvider({ provider: "gate-sweep-1" });
    faux1.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "x" }, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
    ]);
    const bus1 = new InMemoryEventStream();
    const engine1 = new Engine({ providers: { store, stream: bus1, sandboxProvider } });
    await engine1.createSession({
      id: SID,
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux1.getModel(),
      tools: [farTool],
    });

    const gate = await new Promise<DecisionGate>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("gate timeout")), 2000);
      const unsub = bus1.subscribe({}, (e) => {
        if (e.event.type === "decision_gate") {
          clearTimeout(t);
          unsub();
          resolve(e.event.gate);
        }
      });
      void engine1.getSession(SID)!.prompt("go");
    });
    const suspended = await store.getSuspendedTurn(SID, gate.threadId);
    expect(suspended?.queueItemId).toBeDefined();
    faux1.unregister();

    // Restore into a second engine: reconciliation re-arms the pending gate
    // with its far-future timer, so nothing expires it on its own.
    const faux2 = registerFauxProvider({ provider: "gate-sweep-2" });
    faux2.setResponses([fauxAssistantMessage("done after expiry")]);
    const bus2 = new InMemoryEventStream();
    const events2: BusEvent[] = [];
    bus2.subscribe({}, (e) => events2.push(e));
    const engine2 = new Engine({ providers: { store, stream: bus2, sandboxProvider } });
    const session2 = await engine2.restoreSession({
      sessionId: SID,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: faux2.getModel(),
        tools: [farTool],
      },
    });

    // The deadline lapses: rewrite the persisted gate's expiresAt into the past.
    const stored = await store.getDecisionGate(SID, gate.id);
    await store.saveDecisionGate(SID, gate.threadId, {
      ...stored!,
      expiresAt: Date.now() - 1,
    });

    // One sweep pass runs the durable backstop.
    await session2.sweepOnce();

    // Gate row becomes expired and the expiry event is emitted for this gate.
    await waitForAsync(
      async () => (await store.getDecisionGate(SID, gate.id))?.status === "expired",
      3000,
    );
    expect(
      events2.some(
        (e) => e.event.type === "decision_gate_expired" && e.event.gateId === gate.id,
      ),
    ).toBe(true);

    // The blocked submission terminalizes (no longer stranded on the gate).
    const itemId = suspended!.queueItemId;
    await waitForAsync(
      async () => (await store.getQueueItem(SID, itemId))?.status === "settled",
      3000,
    );
    expect((await store.getQueueItem(SID, itemId))?.status).toBe("settled");

    faux2.unregister();
  });
});
