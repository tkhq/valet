import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  PresenceRequiredError,
  PRESENCE_REQUIRED_MESSAGE,
  presenceRefusal,
  type BusEvent,
  type DecisionGate,
  type ToolDef,
} from "../src/index.js";

const approval = {
  id: "apr_1",
  approved_at: "2026-11-17T00:00:00.000Z",
  approved_until: "2026-11-17T00:00:00.000Z",
  state: {
    iss: "turnkey" as const,
    organization_id: "sub-1",
    amr: ["pop" as const, "user" as const],
    approver: { user_id: "passkey-user" },
    activities: [{ activity_id: "act-1", payload_sha256: "ab".repeat(32), approved_at: "2026-11-17T00:00:00.000Z" }],
  },
};
const presenceGate = { context: { assurance: "presence" }, actions: [{ id: "approve", label: "Sign" }, { id: "reject", label: "Reject" }] };

describe("presenceRefusal", () => {
  it("refuses an approve without presence evidence", () => {
    expect(presenceRefusal(presenceGate, { actionId: "approve" })).toBe(PRESENCE_REQUIRED_MESSAGE);
    expect(presenceRefusal(presenceGate, { actionId: "approve", assurance: "presence" })).toBe(PRESENCE_REQUIRED_MESSAGE);
  });

  it("treats an action marked approves as an approval", () => {
    const gate = { context: { assurance: "presence" }, actions: [{ id: "sign", label: "Sign", approves: true }] };
    expect(presenceRefusal(gate, { actionId: "sign" })).toBe(PRESENCE_REQUIRED_MESSAGE);
  });

  it("accepts a reject, a session gate, and a presence approval with evidence", () => {
    expect(presenceRefusal(presenceGate, { actionId: "reject" })).toBeNull();
    expect(presenceRefusal({ actions: presenceGate.actions }, { actionId: "approve" })).toBeNull();
    expect(presenceRefusal(presenceGate, { actionId: "approve", assurance: "presence", approval })).toBeNull();
  });
});

function presenceTool(): ToolDef {
  return {
    name: "sign_it",
    description: "Needs a passkey approval.",
    parameters: Type.Object({}),
    execute: async (_args, ctx) => {
      const resolution = await ctx.requestDecision({
        type: "approval",
        title: "Sign?",
        resumeKey: "sign_it",
        context: { assurance: "presence" },
        actions: [{ id: "approve", label: "Sign", approves: true }, { id: "reject", label: "Reject" }],
      });
      return { text: resolution.actionId === "approve" ? `signed:${resolution.assurance}` : "rejected" };
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1500) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Session.resolveDecision on a presence gate", () => {
  it("throws PresenceRequiredError for a plain approve and keeps the gate pending", async () => {
    const faux = registerFauxProvider({ provider: "gate-presence" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("sign_it", {}, { id: "tc1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const engine = new Engine({ providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() } });
    const session = await engine.createSession({
      userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel(), tools: [presenceTool()],
    });
    void session.prompt("sign it");
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));
    const gate = events.flatMap((e) => (e.event.type === "decision_gate" ? [e.event.gate] : []))[0] as DecisionGate;

    await expect(
      session.resolveDecision(gate.id, { actionId: "approve", resolvedBy: "u1", resolvedAt: Date.now() }),
    ).rejects.toBeInstanceOf(PresenceRequiredError);
    expect((await store.getDecisionGate(session.id, gate.id))?.status).toBe("pending");

    await session.resolveDecision(gate.id, {
      actionId: "approve", resolvedBy: "u1", resolvedAt: Date.now(), assurance: "presence", approval,
    });
    await waitFor(() => events.some((e) => e.event.type === "decision_gate_resolved"));
    const resolved = await store.getDecisionGate(session.id, gate.id);
    expect(resolved?.resolution?.assurance).toBe("presence");
    expect(resolved?.resolution?.approval?.state.activities.map((a) => a.activity_id)).toEqual(["act-1"]);
    faux.unregister();
  });
});
