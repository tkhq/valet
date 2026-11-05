import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  pluginCatalogTools,
  type ActionPlugin,
  type BusEvent,
  type CreateSessionOptions,
  type PolicyResolver,
} from "../src/index.js";

describe.each([false, true])("team approval restart compatibility (resolver: %s)", (withResolver) => {
  it.each([true, false])("uses the persisted gate's approver when a teammate answers (legacy: %s)", async (legacy) => {
    const faux = registerFauxProvider({ provider: `approval-compat-${withResolver}-${legacy}` });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: "chat.post", params: {}, summary: "Post" }, { id: "post-call" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    let executions = 0;
    let resolutions = 0;
    const plugin: ActionPlugin = {
      service: "chat", defaultApprovalMode: "require_approval",
      actions: [{ id: "chat.post", name: "Post", description: "Post", riskLevel: "medium", parameters: Type.Object({}),
        execute: async () => { executions++; return { success: true, data: "posted" }; } }],
    };
    const policyResolver: PolicyResolver = {
      resolve: async () => ({ mode: "require_approval", provenance: { baseMode: "require_approval", source: "team_policy" } }),
      onResolution: async () => { resolutions++; },
    };
    const store = new InMemorySessionStore();
    const stream = new InMemoryEventStream();
    const events: BusEvent[] = [];
    stream.subscribe({}, event => events.push(event));
    const providers = { store, stream, sandboxProvider: new VirtualSandboxProvider() };
    const options: CreateSessionOptions = {
      userId: "runtime", orgId: "org", owner: { type: "team", id: "team" },
      workspace: "/", sandbox: {}, model: faux.getModel(), tools: pluginCatalogTools({ plugins: [plugin] }),
      ...(withResolver ? { policyResolver } : {}),
    };
    const session = await new Engine({ providers }).createSession(options);
    let restored: typeof session | undefined;
    try {
      const receipt = await session.prompt("Post", { author: { id: "asker", interactive: true } });
      await expect.poll(async () => (await store.getQueueItem(session.id, receipt.queueItemId))?.status).toBe("blocked_on_decision_gate");
      const gates = await store.listDecisionGates(session.id);
      expect(gates).toHaveLength(1);
      const gate = gates[0];
      if (!gate) throw new Error("Missing pending approval gate");
      expect(gate.context?.approver).toEqual({ userId: "asker" });
      if (legacy) {
        const context = { ...gate.context };
        delete context.approver;
        await store.saveDecisionGate(session.id, gate.threadId, { ...gate, context });
      }
      session.suspendTimers();
      restored = await new Engine({ providers }).restoreSession({ sessionId: session.id, options });
      await restored.resolveDecision(gate.id, { actionId: "approve", resolvedBy: "teammate", resolvedAt: Date.now() });
      await restored.thread(receipt.threadId).awaitResult(receipt.queueItemId);

      expect(executions).toBe(legacy ? 1 : 0);
      expect(resolutions).toBe(legacy && withResolver ? 1 : 0);
      const toolEnds = events.flatMap(({ event }) => event.type === "tool_end" && event.callId === "post-call" ? [event] : []);
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0]?.result).toContain(legacy ? "posted" : "denied:");
      expect(await store.listDecisionGates(session.id)).toHaveLength(1);
      expect((await store.getDecisionGate(session.id, gate.id))?.resolution).not.toHaveProperty("gateContext");
      expect(await store.getSuspendedTurn(session.id, gate.threadId)).toBeNull();
    } finally {
      session.suspendTimers();
      restored?.suspendTimers();
      faux.unregister();
    }
  });
});
