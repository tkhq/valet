import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type ToolDef,
} from "../src/index.js";

const MARKER = "sentinel-credential-value";
const BLOCKED = "[blocked] the host sanitizer refused this output";

/**
 * Stands in for the host's credential tripwire: any value whose text
 * carries the marker is replaced. The replacement itself has no marker, so
 * a second pass over an already-blocked value leaves it alone.
 */
function stubSanitizer(_sessionId: string, value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.includes(MARKER) ? BLOCKED : value;
}

describe("engine: sanitized tool output round trip", () => {
  it("persists the blocked result and emits blocked args", async () => {
    const faux = registerFauxProvider({ provider: "sanitizer-roundtrip" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("leak", { note: MARKER }, { id: "tc-leak" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const leak: ToolDef = {
      name: "leak",
      description: "returns the value it was given",
      parameters: Type.Object({ note: Type.String() }),
      execute: async (args) => {
        const note = args.note;
        return { text: `resolved ${typeof note === "string" ? note : ""}` };
      },
    };

    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const engine = new Engine({
      providers: {
        store,
        stream: bus,
        sandboxProvider: new VirtualSandboxProvider(),
        sanitizeToolOutput: stubSanitizer,
      },
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [leak],
    });

    const receipt = await session.prompt("run the tool");
    await waitForStatus(events, receipt.threadId, "idle");

    // Hop 1 of the round trip: what the engine writes. The persisted part
    // must carry the blocked text, not the value the tool produced.
    const entries = await session.readEntries("web:default");
    const assistant = entries.find((e) => e.type === "message" && e.role === "assistant");
    expect(assistant).toBeDefined();
    if (assistant?.type !== "message") throw new Error("expected a message entry");
    const parts = assistant.parts ?? [];
    expect(parts).toHaveLength(1);
    const part = parts[0];
    if (part.type !== "tool_call") throw new Error("expected a tool_call part");
    expect(part.status).toBe("completed");
    const result = part.result;
    if (!result || typeof result !== "object") throw new Error("expected a structured result");
    expect(Reflect.get(result, "text")).toBe(BLOCKED);
    // The arguments are a string once sanitized, so they persist under the
    // one key a renderer can read.
    expect(part.args).toEqual({ blocked: BLOCKED });

    const toolStart = events.map((e) => e.event).find((e) => e.type === "tool_start");
    expect(toolStart).toBeDefined();
    if (toolStart?.type !== "tool_start") throw new Error("expected a tool_start event");
    expect(toolStart.args).toEqual({ blocked: BLOCKED });

    const toolEnd = events.map((e) => e.event).find((e) => e.type === "tool_end");
    if (toolEnd?.type !== "tool_end") throw new Error("expected a tool_end event");
    expect(toolEnd.result).toBe(BLOCKED);

    // Nothing anywhere carries the marker.
    expect(JSON.stringify(entries)).not.toContain(MARKER);

    faux.unregister();
  });
});

async function waitForStatus(events: BusEvent[], threadId: string, status: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const hit = events.some(
      (e) => e.event.type === "status" && e.event.threadId === threadId && e.event.status === status,
    );
    if (hit) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for status=${status}`);
}
