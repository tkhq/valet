import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({
    providers: { store, stream: bus, sandboxProvider },
  });
  return { engine, store, bus, events };
}

describe("engine: tool-call argument streaming", () => {
  it("emits ephemeral tool_call_update deltas while tool-call args stream", async () => {
    const args = {
      path: "/tmp/note.txt",
      content: "a note body long enough to split across several stream chunks",
    };
    // Small token sizes force the args JSON to stream in many deltas.
    const faux = registerFauxProvider({ provider: "toolstream1", tokenSize: { min: 4, max: 8 } });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", args, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const { engine, bus, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const receipt = await session.prompt("write a note");
    await waitForStatus(events, receipt.threadId, "idle");

    const updates = events
      .map((e) => e.event)
      .filter((e) => e.type === "tool_call_update");
    // At least the toolcall_start emit plus one args delta.
    expect(updates.length).toBeGreaterThanOrEqual(2);
    for (const u of updates) {
      expect(u.threadId).toBe(receipt.threadId);
      expect(u.callId).toBe("tc1");
      expect(u.toolName).toBe("write");
    }

    // The deltas concatenate to the complete args JSON.
    const joined = updates.map((u) => u.argsDelta).join("");
    expect(JSON.parse(joined)).toEqual(args);

    // Every update precedes tool execution.
    const types = events.map((e) => e.event.type);
    const firstToolStart = types.indexOf("tool_start");
    const lastUpdate = types.lastIndexOf("tool_call_update");
    expect(firstToolStart).toBeGreaterThan(lastUpdate);

    // Ephemeral plane only: never in the durable log.
    const { events: log } = await bus.read(session.id);
    expect(log.some((e) => e.event.type === "tool_call_update")).toBe(false);

    faux.unregister();
  });
});

async function waitForStatus(events: BusEvent[], threadId: string, status: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const hit = events.some(
      (e) =>
        e.event.type === "status" &&
        e.event.threadId === threadId &&
        e.event.status === status,
    );
    if (hit) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for status=${status}`);
}
