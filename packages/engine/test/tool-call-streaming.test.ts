import { describe, it, expect } from "vitest";
import { createAssistantMessageEventStream, fauxAssistantMessage, registerApiProvider, registerFauxProvider, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
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
  it("publishes a completed interval before message_end when the next block closes reasoning", async () => {
    const faux = registerFauxProvider({ provider: "thinking-interrupted" });
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const stream = (_model: Model<Api>) => {
      const events = createAssistantMessageEventStream();
      const thinking = fauxAssistantMessage([{ type: "thinking", thinking: "PRIVATE REASONING" }]);
      const message = fauxAssistantMessage([
        { type: "thinking", thinking: "PRIVATE REASONING" }, { type: "text", text: "answer" },
      ]);
      void (async () => {
        events.push({ type: "start", partial: thinking });
        events.push({ type: "thinking_start", contentIndex: 0, partial: thinking });
        events.push({ type: "text_start", contentIndex: 1, partial: message });
        await pending;
        events.push({ type: "done", reason: "stop", message });
        events.end(message);
      })();
      return events;
    };
    registerApiProvider({ api: faux.api, stream, streamSimple: stream });
    const { engine, events } = makeEngine();
    const session = await engine.createSession({ userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel() });
    try {
      const receipt = await session.prompt("reason");
      await expect.poll(() => events.some(e => e.event.type === "thinking_update" && e.event.part.durationMs !== undefined)).toBe(true);
      expect(events.some(e => e.event.type === "message_end")).toBe(false);
      const finished = events.map(e => e.event).find(e => e.type === "thinking_update" && e.part.durationMs !== undefined);
      expect(finished?.type === "thinking_update" && finished.part.text).toBe("");
      expect(JSON.stringify(events)).not.toContain("PRIVATE REASONING");
      release?.();
      await waitForStatus(events, receipt.threadId, "idle");
      const entries = await session.readEntries("web:default");
      const entry = entries.find(e => e.type === "message" && e.role === "assistant");
      expect(entry?.type === "message" && entry.parts?.[0]).toEqual(finished?.type === "thinking_update" && finished.part);
    } finally {
      release?.();
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("streams and persists each reasoning block in provider order", async () => {
    const faux = registerFauxProvider({ provider: "thinking-timing", tokenSize: { min: 2, max: 3 } });
    faux.setResponses([fauxAssistantMessage([
      { type: "thinking", thinking: "first reasoning" },
      { type: "text", text: "intermediate answer" },
      { type: "thinking", thinking: "second reasoning" },
      { type: "text", text: "final answer" },
    ])]);
    try {
      const { engine, bus, events } = makeEngine();
      const session = await engine.createSession({ userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel() });
      const receipt = await session.prompt("reason twice");
      await waitForStatus(events, receipt.threadId, "idle");
      const updates = events.map(e => e.event).filter(e => e.type === "thinking_update");
      expect(updates.length).toBeGreaterThan(4);
      const finished = updates.filter(e => e.part.durationMs !== undefined);
      expect(finished.map(e => e.index)).toEqual([0, 2]);
      expect(updates.every(e => e.part.text === "")).toBe(true);
      for (const update of finished) {
        expect(update.part.startedAt).toBeTypeOf("number");
        expect(update.part.durationMs).toBeGreaterThanOrEqual(0);
      }
      const entries = await session.readEntries("web:default");
      const entry = entries.find(e => e.type === "message" && e.role === "assistant");
      expect(entry?.type).toBe("message");
      if (entry?.type !== "message") throw new Error("Missing assistant entry");
      expect(entry.parts?.map(p => p.type)).toEqual(["thinking", "text", "thinking", "text"]);
      expect(entry.parts?.filter(p => p.type === "thinking")).toEqual(finished.map(e => e.part));
      const { events: log } = await bus.read(session.id);
      expect(log.some(e => e.event.type === "thinking_update")).toBe(false);
      const canonical = log.map(e => e.event).find(e => e.type === "message_update");
      expect(canonical?.type === "message_update" && canonical.parts).toEqual(entry.parts);
      for (const value of [events, log, entries]) {
        expect(JSON.stringify(value)).not.toContain("first reasoning");
        expect(JSON.stringify(value)).not.toContain("second reasoning");
      }
    } finally {
      faux.unregister();
    }
  });

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

    expect(events.some(e => e.event.type === "thinking_update")).toBe(false);
    expect((await session.readEntries("web:default")).some(e =>
      e.type === "message" && e.parts?.some(p => p.type === "thinking"))).toBe(false);

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
