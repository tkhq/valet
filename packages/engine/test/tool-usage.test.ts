import { afterEach, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { ToolUsageFact } from "@valet/shared";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type DecisionGate, type ToolDef } from "../src/index.js";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../src/test-helpers/index.js";

afterEach(() => { vi.restoreAllMocks(); });

it("records run time without approval waiting and keeps the reason separate", async () => {
  const facts: ToolUsageFact[] = [];
  const stream = new InMemoryEventStream();
  let publishGate!: (gate: DecisionGate) => void;
  const opened = new Promise<DecisionGate>(resolve => { publishGate = resolve; });
  stream.subscribe({}, ({ event }) => { if (event.type === "decision_gate") publishGate(event.gate); });
  const tool: ToolDef = {
    name: "timed_action", description: "Check approval timing", parameters: Type.Object({}),
    execute: async (args, ctx) => {
      expect(args).toEqual({});
      await ctx.requestDecision({ type: "approval", title: "Approve timing check?", body: "Policy details", resumeKey: "timing" });
      return { text: "done" };
    },
  };
  const faux = registerFauxProvider({ provider: "usage-timing" });
  faux.setResponses([fauxAssistantMessage([fauxToolCall(tool.name, {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const engine = new Engine({ providers: { store: new InMemorySessionStore(), stream, sandboxProvider: new VirtualSandboxProvider() } });
  const session = await engine.createSession({ userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel(), tools: [tool], recordToolUsage: fact => { facts.push(fact); } });
  try {
    const receipt = await session.prompt("Check timing.");
    const gate = await opened;
    expect(gate).toMatchObject({ body: "Policy details", agentReason: "Exercise timed_action in this test." });
    await new Promise(resolve => setTimeout(resolve, 150));
    await session.resolveDecision(gate.id, { actionId: "approve", resolvedBy: "u1", resolvedAt: Date.now() });
    await session.thread(receipt.threadId).awaitResult(receipt.queueItemId);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact.outcome).toBe("ok");
    expect(Date.now() - fact.createdAt).toBeGreaterThanOrEqual(150);
    expect(fact.durationMs).toBeLessThan(Date.now() - fact.createdAt - 100);
  } finally { await session.destroy(); faux.unregister(); }
});

it.each([false, true])("keeps team automation running when its telemetry sink throws: %s", async throws => {
  const facts: ToolUsageFact[] = [];
  const faux = registerFauxProvider({ provider: `usage-team-${throws}` });
  faux.setResponses([fauxAssistantMessage([fauxToolCall("list_threads", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const engine = new Engine({ providers: { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
  const session = await engine.createSession({ userId: "creator", orgId: "o1", owner: { type: "team", id: "t1" }, workspace: "/", sandbox: {}, model: faux.getModel(),
    recordToolUsage: fact => { facts.push(fact); if (throws) throw new Error("private failure text"); },
  });
  try {
    const receipt = await session.prompt("Check team threads.");
    expect((await session.thread(receipt.threadId).awaitResult(receipt.queueItemId)).outcome).toBe("completed");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ userId: null, ownerType: "team", ownerId: "t1", outcome: "ok" });
    if (throws) expect(console.warn).toHaveBeenCalledWith("Tool usage telemetry failed. Check the host telemetry sink.");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private failure text");
  } finally { await session.destroy(); faux.unregister(); }
});
