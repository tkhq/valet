/**
 * `Thread.currentAgentStatus` — the mid-turn status reading the WS handshake
 * seeds to clients that connect while a turn is already running. Without it,
 * a client that connects during a long tool call sees the thread as idle
 * (no Stop button, Escape inert) until the next transition event.
 */
import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type ToolDef,
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
  return { engine, events };
}

describe("Thread.currentAgentStatus", () => {
  it("reads idle before any turn, tool_calling while a tool blocks, idle after the turn", async () => {
    const faux = registerFauxProvider({ provider: "status1" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-block" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    // A tool that parks until the test releases it — the window where a real
    // long command would be running.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let toolEntered!: () => void;
    const entered = new Promise<void>((r) => {
      toolEntered = r;
    });
    const block: ToolDef = {
      name: "block",
      description: "blocks until released",
      parameters: Type.Object({}),
      execute: async () => {
        toolEntered();
        await gate;
        return { text: "released" };
      },
    };

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [block],
    });
    const thread = await session.ensureDefaultThread();

    expect(thread.currentAgentStatus).toBe("idle");

    const receipt = await thread.submitPrompt("run the blocking tool", {});
    await entered;
    // Mid-tool: the turn owns the execution context and must read as such.
    expect(thread.currentAgentStatus).toBe("tool_calling");
    expect(thread.hasActiveRun).toBe(true);

    release();
    await waitForStatus(events, receipt.threadId, "idle");
    expect(thread.currentAgentStatus).toBe("idle");

    faux.unregister();
  });
});

async function waitForStatus(
  events: BusEvent[],
  threadId: string,
  status: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events.some(
        (e) =>
          e.event.type === "status" &&
          e.event.threadId === threadId &&
          e.event.status === status,
      );
      if (found) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for status=${status}`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}
