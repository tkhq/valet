/**
 * A turn that is durably `blocked_on_decision_gate` used to depend entirely on
 * the gate waiter living in THIS process. When that waiter disappeared without
 * terminalizing the block — a replay that cannot run, a gate error that is
 * neither expiry nor withdrawal — the turn stayed blocked forever: the
 * heartbeat kept renewing its lease, so reconciliation never reclaimed it;
 * `settleTurn` refuses to settle a blocked item; and abort/steer only withdraw
 * gates armed in memory. Every later message queued behind it, and only a
 * process restart cleared the thread.
 *
 * These tests pin the recovery contract: a gate block always has a way out.
 */
import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
} from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type DecisionGate,
  type SessionStore,
  type ToolDef,
} from "../src/index.js";

const approvalParams = Type.Object({ arg: Type.String() });

/** Opens the gate on the first run; returns the decision on replay. */
const approvalTool: ToolDef<typeof approvalParams> = {
  name: "do_thing",
  description: "approval-gated",
  parameters: approvalParams,
  execute: async (args, ctx) => {
    const r = await ctx.requestDecision({
      type: "approval",
      title: "ok?",
      resumeKey: `do_thing:${args.arg}`,
    });
    return { text: `did with ${r.actionId}` };
  },
};

/** Same name, never returns — models a replayed tool that cannot finish (a
 * hung integration, a sandbox that never answers). The decision is recorded,
 * the turn stays blocked, and no waiter is armed: the stranded shape. */
const hangingTool: ToolDef<typeof approvalParams> = {
  name: "do_thing",
  description: "approval-gated",
  parameters: approvalParams,
  execute: () => new Promise(() => {}),
};

async function poll(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let seq = 0;

/** Session whose first turn is blocked on a pending approval gate. */
async function bootBlockedOnGate(label: string) {
  const store: SessionStore = new InMemorySessionStore();
  const stream = new InMemoryEventStream();

  const faux = registerFauxProvider({ provider: `gate-recovery-${label}-${seq++}` });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("do_thing", { arg: "x" }, { id: "tc1" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);

  const engine = new Engine({
    providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() },
  });
  const sessionId = `sess-gate-recovery-${label}`;
  const session = await engine.createSession({
    id: sessionId,
    userId: "u1",
    orgId: "o1",
    workspace: "/",
    sandbox: {},
    model: faux.getModel(),
    tools: [approvalTool],
  });

  const gatePromise = new Promise<DecisionGate>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("gate timeout")), 10_000);
    const unsub = stream.subscribe({}, (e) => {
      if (e.event.type === "decision_gate") {
        clearTimeout(t);
        unsub();
        resolve(e.event.gate);
      }
    });
  });

  const receipt = await session.prompt("please do the thing");
  const gate = await gatePromise;
  await poll(
    async () =>
      (await store.getQueueItem(sessionId, receipt.queueItemId))?.status ===
      "blocked_on_decision_gate",
    5000,
    "durable blocked status",
  );

  return { store, stream, session, sessionId, gate, faux, itemId: receipt.queueItemId };
}

/**
 * A second live session over the same store — what a host cache rebuild or a
 * process restart produces. `restoreSession` runs startup reconciliation, which
 * re-arms the still-pending gate under a fresh fenced attempt.
 */
async function restoreWith(
  h: Awaited<ReturnType<typeof bootBlockedOnGate>>,
  label: string,
  tools: ToolDef<typeof approvalParams>[],
  opts: { gateBlockOrphanGraceMs?: number } = {},
) {
  const faux = registerFauxProvider({ provider: `gate-recovery-2-${label}-${seq++}` });
  faux.setResponses([
    fauxAssistantMessage("after the gate"),
    fauxAssistantMessage("after the steer"),
    fauxAssistantMessage("spare"),
  ]);
  const engine = new Engine({
    providers: { store: h.store, stream: h.stream, sandboxProvider: new VirtualSandboxProvider() },
  });
  const session = await engine.restoreSession({
    sessionId: h.sessionId,
    options: {
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
      ...opts,
    },
  });
  return { session, faux };
}

/** Resolve the gate and let the (hanging) replay strand the block. */
async function strandTheBlock(
  h: Awaited<ReturnType<typeof bootBlockedOnGate>>,
  session: { resolveDecision: (id: string, r: { actionId: string; resolvedBy: string; resolvedAt: number }) => Promise<void> },
) {
  await session.resolveDecision(h.gate.id, {
    actionId: "approve",
    resolvedBy: "u1",
    resolvedAt: Date.now(),
  });
  await poll(
    async () => (await h.store.getDecisionGate(h.sessionId, h.gate.id))?.status === "resolved",
    5000,
    "gate resolved",
  );
  const item = await h.store.getQueueItem(h.sessionId, h.itemId);
  expect(item?.status).toBe("blocked_on_decision_gate");
}

describe("gate-blocked turns always have a way out", () => {
  it("settles the turn when the replay cannot run, instead of leaving it blocked", async () => {
    const h = await bootBlockedOnGate("replay-missing");
    // The tool that opened the gate is not registered on the restored session —
    // a plugin turned off, an MCP server gone, a different tool assembly.
    const { session, faux } = await restoreWith(h, "replay-missing", []);

    await session.resolveDecision(h.gate.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });

    await poll(
      async () => (await h.store.getQueueItem(h.sessionId, h.itemId))?.status === "settled",
      10_000,
      "head settled after an impossible replay",
    );

    // The thread accepts work again.
    const next = await session.prompt("what happened?");
    await poll(
      async () => (await h.store.getQueueItem(h.sessionId, next.queueItemId))?.status === "settled",
      10_000,
      "next message runs",
    );
    expect(await h.store.listUnsettledSubmissions(h.sessionId)).toHaveLength(0);

    h.faux.unregister();
    faux.unregister();
  }, 30_000);

  it("abort releases a gate block whose waiter is gone", async () => {
    const h = await bootBlockedOnGate("abort");
    const { session, faux } = await restoreWith(h, "abort", [hangingTool]);
    await strandTheBlock(h, session);

    await session.abort();

    const item = await h.store.getQueueItem(h.sessionId, h.itemId);
    expect(item?.status).toBe("settled");
    expect(item?.outcome).toEqual({ outcome: "aborted" });

    h.faux.unregister();
    faux.unregister();
  }, 30_000);

  it("steer releases a gate block whose waiter is gone and runs the new message", async () => {
    const h = await bootBlockedOnGate("steer");
    const { session, faux } = await restoreWith(h, "steer", [hangingTool]);
    await strandTheBlock(h, session);

    const steer = await session.prompt("forget it, do this instead", { queueMode: "steer" });

    await poll(
      async () => (await h.store.getQueueItem(h.sessionId, steer.queueItemId))?.status === "settled",
      15_000,
      "steer message runs",
    );
    const head = await h.store.getQueueItem(h.sessionId, h.itemId);
    expect(head?.status).toBe("settled");
    expect(head?.outcome).toEqual({ outcome: "superseded" });

    h.faux.unregister();
    faux.unregister();
  }, 30_000);

  it("the sweep settles a gate block that lost its waiter, with no user action", async () => {
    const h = await bootBlockedOnGate("sweep");
    const { session, faux } = await restoreWith(h, "sweep", [hangingTool], {
      gateBlockOrphanGraceMs: 50,
    });
    await strandTheBlock(h, session);

    // First sweep only arms the grace timer — the window between
    // `requestDecision`'s durable block write and its waiter registration has
    // the same shape and must never be swept.
    await session.sweepOnce();
    expect((await h.store.getQueueItem(h.sessionId, h.itemId))?.status).toBe(
      "blocked_on_decision_gate",
    );

    await new Promise((r) => setTimeout(r, 80));
    await session.sweepOnce();

    await poll(
      async () => (await h.store.getQueueItem(h.sessionId, h.itemId))?.status === "settled",
      10_000,
      "sweep settles the orphaned block",
    );

    h.faux.unregister();
    faux.unregister();
  }, 30_000);

  it("a resumed turn withdraws gate rows left pending for it", async () => {
    const h = await bootBlockedOnGate("zombie-gate");
    // Lose the suspended-turn checkpoint: reconciliation then resumes the turn
    // (step 7) rather than re-arming the gate, and the gate row it leaves
    // behind can never be answered.
    await h.store.clearSuspendedTurn(h.sessionId, h.gate.threadId, undefined);

    const { session, faux } = await restoreWith(h, "zombie-gate", [approvalTool]);
    await poll(
      async () => (await h.store.getQueueItem(h.sessionId, h.itemId))?.status === "settled",
      10_000,
      "head settled by the resume path",
    );

    expect(await session.pendingDecisionGates()).toEqual([]);
    expect((await h.store.getDecisionGate(h.sessionId, h.gate.id))?.status).toBe("withdrawn");

    h.faux.unregister();
    faux.unregister();
  }, 30_000);
});
