import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  Type,
  type AssistantMessage,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
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

    try {
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
      // The bridge moves `ok` and `usageOutcome` into the agent result's
      // `details`, and the engine persists that object as the part result.
      expect(Reflect.get(result, "details")).toEqual({
        ok: false,
        usageOutcome: { outcome: "error", errorCode: "output_blocked" },
      });
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
    } finally {
      faux.unregister();
    }
  });
});

describe("engine: sanitizer covers signals and thrown errors", () => {
  it("sanitizes a signal body before it is stored, shown to the model, or emitted", async () => {
    const run = await startSession([], [fauxAssistantMessage("ok")]);
    try {
      const receipt = await run.session.prompt({
        kind: "signal",
        signalType: "process.exited",
        body: `exit 0\n${MARKER}\n`,
        attributes: {},
      });
      await waitForStatus(run.events, receipt.threadId, "idle");

      // The queued submission is what a restart replays, so it must hold the
      // sanitized body too.
      const submission = await run.store.getQueueItem(run.session.id, receipt.queueItemId);
      expect(submission).not.toBeNull();
      expect(JSON.stringify(submission?.content)).not.toContain(MARKER);
      expect(JSON.stringify(submission?.content)).toContain(BLOCKED);
      const stored = JSON.stringify(await run.session.readEntries("web:default"));
      expect(stored).not.toContain(MARKER);
      expect(stored).toContain(BLOCKED);
      expect(JSON.stringify(run.events)).not.toContain(MARKER);
      expect(run.modelInputs).toHaveLength(1);
      expect(run.modelInputs.join("\n")).not.toContain(MARKER);
    } finally {
      run.unregister();
    }
  });

  it.each([
    ["an Error", () => { throw new Error(`failed: ${MARKER}`); }],
    ["a string", () => { throw `failed: ${MARKER}`; }],
  ])("sanitizes a thrown tool error (%s) and persists the call as an error", async (_label, fail) => {
    const boom: ToolDef = {
      name: "boom",
      description: "always fails",
      parameters: Type.Object({}),
      execute: async () => fail(),
    };
    const run = await startSession([boom], [
      fauxAssistantMessage([fauxToolCall("boom", {}, { id: "tc-boom" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    try {
      const receipt = await run.session.prompt("run the tool");
      await waitForStatus(run.events, receipt.threadId, "idle");

      const part = await toolCallPart(run.session);
      expect(part.status).toBe("error");
      expect(JSON.stringify(part.result)).toContain(BLOCKED);
      expect(JSON.stringify(run.events)).not.toContain(MARKER);
      // The second model call carries the tool result: it must see the
      // blocked text, not the error message the tool threw.
      expect(run.modelInputs).toHaveLength(2);
      expect(run.modelInputs[1]).toContain(BLOCKED);
      expect(run.modelInputs.join("\n")).not.toContain(MARKER);
    } finally {
      run.unregister();
    }
  });
});

type TestSession = Awaited<ReturnType<Engine["createSession"]>>;

/**
 * Starts a session with the stub sanitizer. Each scripted model response
 * records the context the model received, so a test can assert what the
 * model saw, not only what the engine stored.
 */
async function startSession(tools: ToolDef[], responses: AssistantMessage[]) {
  const faux = registerFauxProvider({ provider: "sanitizer-seams" });
  const modelInputs: string[] = [];
  const steps: FauxResponseStep[] = responses.map((response) => (context) => {
    modelInputs.push(JSON.stringify(context));
    return response;
  });
  faux.setResponses(steps);
  const bus = new InMemoryEventStream();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const store = new InMemorySessionStore();
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
    tools,
  });
  return { session, store, events, modelInputs, unregister: () => faux.unregister() };
}

async function toolCallPart(session: TestSession) {
  const entries = await session.readEntries("web:default");
  const assistant = entries.find((e) => e.type === "message" && e.role === "assistant");
  if (assistant?.type !== "message") throw new Error("expected an assistant message entry");
  const part = assistant.parts?.[0];
  if (part?.type !== "tool_call") throw new Error("expected a tool_call part");
  return part;
}

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
