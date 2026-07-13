import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  StaleAttemptError,
  VirtualSandboxProvider,
  type BusEvent,
  type DecisionGate,
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
