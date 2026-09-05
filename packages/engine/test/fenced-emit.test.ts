import { describe, it, expect, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  StaleAttemptError,
  VirtualSandboxProvider,
  type BusEvent,
  type DecisionGate,
  type ResolvedModel,
  type ToolDef,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  // Wire the fence check (decision 12) — InMemoryEventStream accepts fenced
  // appends unconditionally unless a fenceCheck is configured.
  const bus = new InMemoryEventStream({
    fenceCheck: (fence) => store.isCurrentAttempt(fence.itemId, fence.attemptId),
  });
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, bus, events };
}

/** A tool whose execute() requests a decision, parking the turn (running + blocked). */
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
      return { text: resolution.actionId === "approve" ? "approved" : "denied" };
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

describe("attempt-fenced EventStream appends (decision 12)", () => {
  it("keeps ordinary emits best-effort but can surface a required append failure", async () => {
    const faux = registerFauxProvider({ provider: "required-emit" });
    const { engine, bus } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    vi.spyOn(bus, "append").mockRejectedValue(new Error("event stream unavailable"));

    await expect(
      session.emit({ type: "status", threadId: session.thread().id, status: "thinking" }),
    ).resolves.toBeUndefined();
    await expect(
      session.emit(
        { type: "status", threadId: session.thread().id, status: "thinking" },
        { throwOnAppendError: true },
      ),
    ).rejects.toThrow("event stream unavailable");
    faux.unregister();
  });

  it("never snapshots an active model before its delayed fenced append commits", async () => {
    const faux = registerFauxProvider({ provider: "fenced-delayed-model" });
    let providerCalls = 0;
    faux.setResponses([
      () => {
        providerCalls += 1;
        return fauxAssistantMessage("must not run");
      },
    ]);
    const { engine, store, bus, events } = makeEngine();
    const append = bus.append.bind(bus);
    let releaseAppend: (() => void) | undefined;
    const appendBlocked = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let markAppendPending: (() => void) | undefined;
    const appendPending = new Promise<void>((resolve) => {
      markAppendPending = resolve;
    });
    let pendingFence: { itemId: string; attemptId: string } | undefined;
    vi.spyOn(bus, "append").mockImplementation(async (event, eventKey, fence) => {
      if (
        !pendingFence &&
        event.event.type === "model_state" &&
        event.event.queueItemId !== null &&
        fence
      ) {
        pendingFence = fence;
        markAppendPending?.();
        await appendBlocked;
      }
      return append(event, eventKey, fence);
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = await session.ensureDefaultThread();

    const receipt = await thread.submitPrompt("lose ownership while publishing", {});
    await appendPending;
    let snapshotSettled = false;
    const snapshotRequestedWhilePending = thread.currentModelState().then((snapshot) => {
      snapshotSettled = true;
      return snapshot;
    });
    await Promise.resolve();
    expect(snapshotSettled).toBe(false);
    if (!pendingFence) throw new Error("active model append did not carry a fence");
    const replaced = await store.replaceSubmissionAttempt(
      session.id,
      thread.id,
      receipt.queueItemId,
      {
        sessionId: session.id,
        threadId: thread.id,
        itemId: receipt.queueItemId,
        attemptId: "att-delayed-successor",
        ownerId: "delayed-successor",
      },
      { expectedAttemptId: pendingFence.attemptId },
    );
    expect(replaced).toBeTruthy();
    await store.forceSettle(session.id, receipt.queueItemId, "aborted", "successor settled");
    releaseAppend?.();
    await waitFor(() => !thread.hasActiveRun);

    expect(await snapshotRequestedWhilePending).toBeNull();
    expect(await thread.currentModelState()).toBeNull();
    expect(providerCalls).toBe(0);
    expect(events.filter((event) => event.event.type === "model_state")).toHaveLength(0);
    faux.unregister();
  });

  it("a stale initial model-state publish skips the provider and cleans up for the next prompt", async () => {
    const faux = registerFauxProvider({ provider: "fenced-initial-model" });
    let providerCalls = 0;
    faux.setResponses([
      () => {
        providerCalls += 1;
        return fauxAssistantMessage("next prompt completed");
      },
    ]);
    const { engine, store, bus, events } = makeEngine();
    const append = bus.append.bind(bus);
    let intercepted = false;
    vi.spyOn(bus, "append").mockImplementation(async (event, eventKey, fence) => {
      if (!intercepted && event.event.type === "model_state" && fence) {
        intercepted = true;
        const replaced = await store.replaceSubmissionAttempt(
          event.sessionId,
          event.event.threadId,
          fence.itemId,
          {
            sessionId: event.sessionId,
            threadId: event.event.threadId,
            itemId: fence.itemId,
            attemptId: "att-initial-successor",
            ownerId: "initial-successor",
          },
          { expectedAttemptId: fence.attemptId },
        );
        expect(replaced).toBeTruthy();
        await store.forceSettle(event.sessionId, fence.itemId, "aborted", "successor settled");
      }
      return append(event, eventKey, fence);
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      systemPrompt: "Baseline prompt.",
    });
    const thread = await session.ensureDefaultThread();

    const stale = await thread.submitPrompt("stale prompt", {});
    await waitFor(() => !thread.hasActiveRun);

    expect(providerCalls).toBe(0);
    expect(thread.runningItemId()).toBeUndefined();
    expect(await thread.currentModelState()).toBeNull();
    expect(
      events.filter(
        (event) =>
          event.event.type === "model_state" &&
          (event.event.queueItemId === stale.queueItemId || event.event.queueItemId === null),
      ),
    ).toHaveLength(0);

    const next = await thread.submitPrompt("next prompt", {});
    await waitFor(() =>
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === next.queueItemId,
      ),
    );
    expect(providerCalls).toBe(1);
    expect(await thread.currentModelState()).toBeNull();
    faux.unregister();
  });

  it("a generic initial model-state failure skips its provider and restores the next prompt", async () => {
    const base = registerFauxProvider({ provider: "generic-initial-base" });
    const turn = registerFauxProvider({ provider: "generic-initial-turn" });
    const baseSpec = `${base.getModel().provider}/${base.getModel().id}`;
    const turnSpec = `${turn.getModel().provider}/${turn.getModel().id}`;
    let baseCalls = 0;
    let turnCalls = 0;
    let nextPromptSystem: string | undefined;
    base.setResponses([
      (context) => {
        baseCalls += 1;
        nextPromptSystem = context.systemPrompt;
        return fauxAssistantMessage("next prompt completed");
      },
    ]);
    turn.setResponses([
      () => {
        turnCalls += 1;
        return fauxAssistantMessage("must not run");
      },
    ]);
    const { engine, bus, events } = makeEngine();
    const append = bus.append.bind(bus);
    let rejected = false;
    vi.spyOn(bus, "append").mockImplementation(async (event, eventKey, fence) => {
      if (
        !rejected &&
        event.event.type === "model_state" &&
        event.event.model === turnSpec
      ) {
        rejected = true;
        throw new Error("initial model state unavailable");
      }
      return append(event, eventKey, fence);
    });
    const resolver = async (spec: string): Promise<ResolvedModel | null> => {
      if (spec === baseSpec) return { model: base.getModel(), apiKey: "base-key" };
      if (spec === turnSpec) return { model: turn.getModel(), apiKey: "turn-key" };
      return null;
    };
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: base.getModel(),
      modelSpec: baseSpec,
      systemPrompt: "Baseline prompt.",
      resolveModel: resolver,
    });
    const thread = await session.ensureDefaultThread();

    const failed = await thread.submitPrompt("use the turn model", { model: turnSpec });
    await waitFor(() =>
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === failed.queueItemId,
      ),
    );
    expect(turnCalls).toBe(0);
    expect(await thread.currentModelState()).toBeNull();
    expect(
      events.filter(
        (event) =>
          event.event.type === "model_state" &&
          (event.event.queueItemId === failed.queueItemId ||
            (event.event.queueItemId === null && event.queueItemId === failed.queueItemId)),
      ),
    ).toHaveLength(0);
    expect(
      (await thread.readEntries()).flatMap((entry) =>
        entry.type === "message" && entry.role === "user"
          ? [{ queueItemId: entry.queueItemId, content: entry.content }]
          : [],
      ),
    ).toEqual([{ queueItemId: failed.queueItemId, content: "use the turn model" }]);

    const next = await thread.submitPrompt("next prompt", {});
    await waitFor(() =>
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === next.queueItemId,
      ),
    );
    expect(baseCalls).toBe(1);
    expect(nextPromptSystem).toMatch(/^Baseline prompt\.\n\n## Runtime model\n/);
    expect(nextPromptSystem).toContain(`Current provider: ${base.getModel().provider}`);
    expect(nextPromptSystem).toContain("Temporary override: none");
    expect(await thread.currentModelState()).toBeNull();
    expect(
      (await thread.readEntries()).flatMap((entry) =>
        entry.type === "message" && entry.role === "user"
          ? [{ queueItemId: entry.queueItemId, content: entry.content }]
          : [],
      ),
    ).toEqual([
      { queueItemId: failed.queueItemId, content: "use the turn model" },
      { queueItemId: next.queueItemId, content: "next prompt" },
    ]);
    base.unregister();
    turn.unregister();
  });

  it("a stale agent switch publishes neither the replacement nor an idle state", async () => {
    const cheap = registerFauxProvider({ provider: "fenced-switch-cheap" });
    const strong = registerFauxProvider({ provider: "fenced-switch-strong" });
    const cheapSpec = `${cheap.getModel().provider}/${cheap.getModel().id}`;
    const strongSpec = `${strong.getModel().provider}/${strong.getModel().id}`;
    let cheapCalls = 0;
    let strongCalls = 0;
    cheap.setResponses([
      () => {
        cheapCalls += 1;
        return fauxAssistantMessage(
          [fauxToolCall("switch_model", { model: strongSpec }, { id: "tc-switch" })],
          { stopReason: "toolUse" },
        );
      },
      () => {
        cheapCalls += 1;
        return fauxAssistantMessage("next prompt completed");
      },
    ]);
    strong.setResponses([
      () => {
        strongCalls += 1;
        return fauxAssistantMessage("must not continue after stale publication");
      },
    ]);
    const { engine, store, bus, events } = makeEngine();
    const append = bus.append.bind(bus);
    let intercepted = false;
    vi.spyOn(bus, "append").mockImplementation(async (event, eventKey, fence) => {
      if (
        !intercepted &&
        event.event.type === "model_state" &&
        event.event.model === strongSpec &&
        fence
      ) {
        intercepted = true;
        const replaced = await store.replaceSubmissionAttempt(
          event.sessionId,
          event.event.threadId,
          fence.itemId,
          {
            sessionId: event.sessionId,
            threadId: event.event.threadId,
            itemId: fence.itemId,
            attemptId: "att-switch-successor",
            ownerId: "switch-successor",
          },
          { expectedAttemptId: fence.attemptId },
        );
        expect(replaced).toBeTruthy();
        await store.forceSettle(event.sessionId, fence.itemId, "aborted", "successor settled");
      }
      return append(event, eventKey, fence);
    });
    const resolver = async (spec: string): Promise<ResolvedModel | null> => {
      if (spec === cheapSpec) return { model: cheap.getModel(), apiKey: "cheap-key" };
      if (spec === strongSpec) return { model: strong.getModel(), apiKey: "strong-key" };
      return null;
    };
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: cheap.getModel(),
      modelSpec: cheapSpec,
      resolveModel: resolver,
    });
    const thread = await session.ensureDefaultThread();

    const receipt = await thread.submitPrompt("switch", {});
    await waitFor(() => intercepted && !thread.hasActiveRun);

    expect(cheapCalls).toBe(1);
    expect(strongCalls).toBe(0);
    expect(await thread.currentModelState()).toBeNull();
    expect(
      events.flatMap((event) =>
        event.event.type === "model_state" ? [event.event] : [],
      ),
    ).toEqual([
      {
        type: "model_state",
        threadId: thread.id,
        queueItemId: receipt.queueItemId,
        model: cheapSpec,
      },
    ]);

    const next = await thread.submitPrompt("next prompt", {});
    await waitFor(() =>
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === next.queueItemId,
      ),
    );
    expect(cheapCalls).toBe(2);
    expect(strongCalls).toBe(0);
    expect(await thread.currentModelState()).toBeNull();
    expect(
      events.flatMap((event) =>
        event.event.type === "model_state" ? [event.event] : [],
      ),
    ).toEqual([
      {
        type: "model_state",
        threadId: thread.id,
        queueItemId: receipt.queueItemId,
        model: cheapSpec,
      },
      {
        type: "model_state",
        threadId: thread.id,
        queueItemId: next.queueItemId,
        model: cheapSpec,
      },
      { type: "model_state", threadId: thread.id, queueItemId: null, model: null },
    ]);
    cheap.unregister();
    strong.unregister();
  });

  it("rejects the matching idle model-state clear when ownership turns stale", async () => {
    const faux = registerFauxProvider({ provider: "fenced-idle-model" });
    faux.setResponses([fauxAssistantMessage("done")]);
    const { engine, store, bus, events } = makeEngine();
    vi.spyOn(store, "reserveSettlement").mockRejectedValueOnce(
      new Error("settlement unavailable"),
    );

    const append = bus.append.bind(bus);
    let idleAppendAttempted = false;
    let idleEnvelopeQueueItemId: string | undefined;
    let idleFence: { itemId: string; attemptId: string } | undefined;
    let successorInstalled = false;
    vi.spyOn(bus, "append").mockImplementation(async (event, eventKey, fence) => {
      if (
        !idleAppendAttempted &&
        event.event.type === "model_state" &&
        event.event.queueItemId === null
      ) {
        idleAppendAttempted = true;
        idleEnvelopeQueueItemId = event.queueItemId;
        idleFence = fence;
        if (fence) {
          const replaced = await store.replaceSubmissionAttempt(
            event.sessionId,
            event.event.threadId,
            fence.itemId,
            {
              sessionId: event.sessionId,
              threadId: event.event.threadId,
              itemId: fence.itemId,
              attemptId: "att-idle-successor",
              ownerId: "idle-successor",
            },
            { expectedAttemptId: fence.attemptId },
          );
          successorInstalled = replaced !== null;
        }
      }
      return append(event, eventKey, fence);
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = await session.ensureDefaultThread();

    const receipt = await thread.submitPrompt("finish under the old attempt", {});
    await waitFor(() => idleAppendAttempted && !thread.hasActiveRun);

    expect(idleEnvelopeQueueItemId).toBe(receipt.queueItemId);
    expect(idleFence).toEqual({
      itemId: receipt.queueItemId,
      attemptId: expect.any(String),
    });
    expect(successorInstalled).toBe(true);
    expect(await thread.currentModelState()).toBeNull();
    expect(
      events.flatMap((event) =>
        event.event.type === "model_state" ? [event.event] : [],
      ),
    ).toEqual([
      {
        type: "model_state",
        threadId: thread.id,
        queueItemId: receipt.queueItemId,
        model: `${faux.getModel().provider}/${faux.getModel().id}`,
      },
    ]);

    await store.forceSettle(session.id, receipt.queueItemId, "aborted", "test cleanup");
    faux.unregister();
  });

  it("retries a generic idle model-state failure during final claim cleanup", async () => {
    const faux = registerFauxProvider({ provider: "generic-idle-retry" });
    faux.setResponses([fauxAssistantMessage("done")]);
    const { engine, bus, events } = makeEngine();
    const append = bus.append.bind(bus);
    let idleAttempts = 0;
    let markFirstIdlePending: (() => void) | undefined;
    const firstIdlePending = new Promise<void>((resolve) => {
      markFirstIdlePending = resolve;
    });
    let releaseFirstIdle: (() => void) | undefined;
    const firstIdleBlocked = new Promise<void>((resolve) => {
      releaseFirstIdle = resolve;
    });
    let markSettlementPending: (() => void) | undefined;
    const settlementPending = new Promise<void>((resolve) => {
      markSettlementPending = resolve;
    });
    let releaseSettlement: (() => void) | undefined;
    const settlementBlocked = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    vi.spyOn(bus, "append").mockImplementation(async (event, eventKey, fence) => {
      if (event.event.type === "model_state" && event.event.queueItemId === null) {
        idleAttempts += 1;
        if (idleAttempts === 1) {
          markFirstIdlePending?.();
          await firstIdleBlocked;
          throw new Error("idle model state unavailable");
        }
      }
      if (event.event.type === "submission_settled") {
        markSettlementPending?.();
        await settlementBlocked;
      }
      return append(event, eventKey, fence);
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = await session.ensureDefaultThread();

    const receipt = await thread.submitPrompt("finish", {});
    await firstIdlePending;
    let snapshotSettled = false;
    const snapshotDuringClear = thread.currentModelState().then((snapshot) => {
      snapshotSettled = true;
      return snapshot;
    });
    await Promise.resolve();
    expect(snapshotSettled).toBe(false);

    releaseFirstIdle?.();
    await settlementPending;
    expect(await snapshotDuringClear).toBeNull();
    expect(idleAttempts).toBe(1);
    expect(
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === receipt.queueItemId,
      ),
    ).toBe(false);

    releaseSettlement?.();
    await waitFor(() => !thread.hasActiveRun);

    expect(idleAttempts).toBe(2);
    expect(
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === receipt.queueItemId,
      ),
    ).toBe(true);
    expect(await thread.currentModelState()).toBeNull();
    expect(
      events.flatMap((event) =>
        event.event.type === "model_state" ? [event.event] : [],
      ),
    ).toEqual([
      {
        type: "model_state",
        threadId: thread.id,
        queueItemId: receipt.queueItemId,
        model: `${faux.getModel().provider}/${faux.getModel().id}`,
      },
      { type: "model_state", threadId: thread.id, queueItemId: null, model: null },
    ]);
    faux.unregister();
  });

  it("invalidates the reconnect snapshot when every idle append fails", async () => {
    const faux = registerFauxProvider({ provider: "generic-idle-persistent" });
    faux.setResponses([fauxAssistantMessage("done")]);
    const { engine, bus, events } = makeEngine();
    const append = bus.append.bind(bus);
    let idleAttempts = 0;
    vi.spyOn(bus, "append").mockImplementation(async (event, eventKey, fence) => {
      if (event.event.type === "model_state" && event.event.queueItemId === null) {
        idleAttempts += 1;
        throw new Error("idle model state unavailable");
      }
      return append(event, eventKey, fence);
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = await session.ensureDefaultThread();

    const receipt = await thread.submitPrompt("finish", {});
    await waitFor(() => idleAttempts > 0);
    await waitFor(() => !thread.hasActiveRun);

    expect(idleAttempts).toBe(2);
    expect(await thread.currentModelState()).toBeNull();
    expect(
      events.flatMap((event) =>
        event.event.type === "model_state" ? [event.event] : [],
      ),
    ).toEqual([
      {
        type: "model_state",
        threadId: thread.id,
        queueItemId: receipt.queueItemId,
        model: `${faux.getModel().provider}/${faux.getModel().id}`,
      },
    ]);
    faux.unregister();
  });

  it("a zombie's fenced emit rejects StaleAttemptError once a successor owns the item; no event lands durably", async () => {
    const faux = registerFauxProvider({ provider: "fenced-emit" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "x" }, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("all done"),
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

    void session.prompt("please do thing");

    // Wait for the turn to park on the decision gate — at this point the
    // item is durably "running" (claimed) with a real attemptId.
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));
    const gateEvent = events.find((e) => e.event.type === "decision_gate")!;
    const gate = (gateEvent.event as { gate: DecisionGate }).gate;
    const queueItemId = gate.queueItemId;

    const claimed = await store.getQueueItem(session.id, queueItemId);
    expect(claimed).toBeTruthy();
    const oldAttemptId = claimed?.attemptId;
    expect(oldAttemptId).toBeTruthy();
    if (!oldAttemptId) throw new Error("no attemptId");
    const oldFence = { itemId: queueItemId, attemptId: oldAttemptId };

    // Simulate reclaim (as reconciliation would after a crash): a fresh
    // attempt takes over the same item, superseding the one that's still
    // "in flight" from this test's point of view.
    const replaced = await store.replaceSubmissionAttempt(
      session.id,
      gate.threadId,
      queueItemId,
      {
        sessionId: session.id,
        threadId: gate.threadId,
        itemId: queueItemId,
        attemptId: "att-successor",
        ownerId: "owner-successor",
      },
      { expectedAttemptId: oldAttemptId },
    );
    expect(replaced).toBeTruthy();

    // The old (zombie) attempt tries to land a live-execution event under
    // its now-stale fence — must reject, not silently log-and-continue.
    await expect(
      session.emit(
        { type: "status", threadId: gate.threadId, status: "thinking" },
        { fence: oldFence, queueItemId },
      ),
    ).rejects.toBeInstanceOf(StaleAttemptError);

    // Durable log holds no event from the rejected zombie emit: exactly one
    // "thinking" status (the turn's legitimate agent_start, before the gate
    // parked it), never two.
    const durableAfterReject = events.filter(
      (e) => e.event.type === "status" && (e.event as { status: string }).status === "thinking",
    );
    expect(durableAfterReject).toHaveLength(1);
  });
});
