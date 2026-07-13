import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@mariozechner/pi-ai";
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
  return { engine, store, bus, events, sandboxProvider };
}

describe("engine: single-thread happy path", () => {
  it("runs prompt -> assistant text response and persists to store", async () => {
    const faux = registerFauxProvider({ provider: "happy1" });
    faux.setResponses([fauxAssistantMessage("hello, world")]);

    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    const receipt = await session.prompt("say hi");
    expect(receipt.threadId).toBeTruthy();

    // Wait until idle (status event with idle)
    await waitForStatus(events, receipt.threadId, "idle");

    const entries = await session.readEntries("web:default");
    const messages = entries.filter((e) => e.type === "message");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "say hi" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "hello, world" });

    // Transcript↔submission linkage: both entries carry the turn's queueItemId,
    // and the final assistant entry records stopReason end_turn.
    expect(messages[0]).toMatchObject({ queueItemId: receipt.queueItemId });
    expect(messages[1]).toMatchObject({
      queueItemId: receipt.queueItemId,
      stopReason: "end_turn",
    });

    // Bus emitted the lifecycle events
    const types = events.map((e) => e.event.type);
    expect(types).toContain("thread_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("turn_end");

    // Session persisted in store
    expect(await store.getSession(session.id)).not.toBeNull();

    faux.unregister();
  });

  it("runs prompt -> tool call -> tool result -> end_turn", async () => {
    const faux = registerFauxProvider({ provider: "happy2" });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("write", { path: "/tmp/note.txt", content: "ok" }, { id: "tc1" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const receipt = await session.prompt("write a note");
    await waitForStatus(events, receipt.threadId, "idle");

    // The write tool ran against the virtual sandbox
    const fileContent = await session.sandbox.readFile("/tmp/note.txt");
    expect(fileContent).toBe("ok");

    // tool_start and tool_end events landed
    const tools = events.map((e) => e.event).filter((e) => e.type === "tool_start" || e.type === "tool_end");
    expect(tools.map((t) => t.type)).toEqual(["tool_start", "tool_end"]);

    // The persisted assistant entry has the tool_call part with COMPLETED
    // status + the result. Regression guard: an earlier bug persisted the
    // entry at message_end with status='running' and never re-persisted
    // after tool_execution_end, so reload showed cards stuck mid-execution.
    const entries = await session.readEntries("web:default");
    const assistant = entries.find(
      (e) => e.type === "message" && e.role === "assistant",
    );
    expect(assistant).toBeDefined();
    if (assistant?.type !== "message") throw new Error("unreachable");
    const toolCallPart = assistant.parts?.find((p) => p.type === "tool_call");
    expect(toolCallPart).toBeDefined();
    if (toolCallPart?.type !== "tool_call") throw new Error("unreachable");
    expect(toolCallPart.toolName).toBe("write");
    expect(toolCallPart.status).toBe("completed");
    expect(toolCallPart.args).toEqual({ path: "/tmp/note.txt", content: "ok" });
    // Regression guard: it's not enough that `result` is *defined* — readers
    // (UI tool renderers, thread_read formatting, exports) must be able to
    // pull a printable string out of it. Earlier the engine stored
    // pi-agent-core's `{ content: [...] }` shape verbatim while the wire
    // expected `{ text }`, so tool cards rendered as "(empty output)" on
    // reload. We now persist `result.text` alongside the structured fields.
    expect(toolCallPart.result).toBeDefined();
    const resultObj = toolCallPart.result as { text?: unknown };
    expect(typeof resultObj.text).toBe("string");
    expect((resultObj.text as string).length).toBeGreaterThan(0);
    expect(resultObj.text).toContain("/tmp/note.txt");

    // Linkage: the user entry, the tool_call-bearing assistant entry, and the
    // final assistant entry all carry this turn's queueItemId — this is what
    // awaitResult / reconciliation compute over.
    const userEntry = entries.find((e) => e.type === "message" && e.role === "user");
    expect(userEntry?.queueItemId).toBe(receipt.queueItemId);
    expect(assistant.queueItemId).toBe(receipt.queueItemId);
    const finalAssistant = entries
      .filter((e) => e.type === "message" && e.role === "assistant")
      .at(-1);
    expect(finalAssistant?.queueItemId).toBe(receipt.queueItemId);
    if (finalAssistant?.type === "message") {
      expect(finalAssistant.stopReason).toBe("end_turn");
    }

    faux.unregister();
  });

  it("invokes a custom ToolDef with ToolContext", async () => {
    const faux = registerFauxProvider({ provider: "happy3" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("greet", { who: "world" }, { id: "tc2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("ok"),
    ]);

    let receivedCtx: { userId?: string; threadId?: string } | undefined;
    const greet: ToolDef = {
      name: "greet",
      description: "greets",
      parameters: Type.Object({ who: Type.String() }),
      execute: async (args, ctx) => {
        receivedCtx = { userId: ctx.userId, threadId: ctx.threadId };
        return { text: `hello ${(args as { who: string }).who}` };
      },
    };

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u-custom",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [greet],
    });

    const receipt = await session.prompt("greet world");
    await waitForStatus(events, receipt.threadId, "idle");

    expect(receivedCtx?.userId).toBe("u-custom");
    expect(receivedCtx?.threadId).toBe(receipt.threadId);

    faux.unregister();
  });

  it("durably appends the turn's lifecycle events (offset-ordered, no text_delta, submission-linked)", async () => {
    const faux = registerFauxProvider({ provider: "happy-durable" });
    faux.setResponses([fauxAssistantMessage("durable hello")]);

    const { engine, bus, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    const receipt = await session.prompt("say hi");
    await waitForStatus(events, receipt.threadId, "idle");
    // The settlement emit races the idle status; wait for it in the log.
    await waitForAsync(async () => {
      const { events: log } = await bus.read(session.id);
      return log.some((e) => e.event.type === "submission_settled");
    });

    const { events: log } = await bus.read(session.id);

    // Offsets are 16-char zero-padded and strictly increasing in read order.
    for (const e of log) {
      expect(e.offset).toMatch(/^\d{16}$/);
    }
    const offsets = log.map((e) => e.offset);
    expect([...offsets].sort()).toEqual(offsets);

    // No text_delta ever lands in the durable log — it's ephemeral only.
    expect(log.some((e) => e.event.type === "text_delta")).toBe(false);
    // ...but the live subscriber DID see text_delta (ephemeral fan-out).
    expect(events.some((e) => e.event.type === "text_delta")).toBe(true);

    // Lifecycle backbone appears in offset order.
    const typeOrder = log.map((e) => e.event.type);
    const idx = (t: string) => typeOrder.indexOf(t);
    expect(idx("message_start")).toBeGreaterThanOrEqual(0);
    expect(idx("message_end")).toBeGreaterThan(idx("message_start"));
    expect(idx("turn_end")).toBeGreaterThan(idx("message_end"));
    expect(idx("submission_settled")).toBeGreaterThan(idx("turn_end"));

    // Every turn lifecycle event carries the receipt's queueItemId.
    const turnScoped = log.filter((e) =>
      ["message_start", "message_end", "turn_end", "status"].includes(e.event.type),
    );
    expect(turnScoped.length).toBeGreaterThan(0);
    for (const e of turnScoped) {
      expect(e.queueItemId).toBe(receipt.queueItemId);
    }

    // The settlement envelope is submission-linked.
    const settled = log.find((e) => e.event.type === "submission_settled");
    expect(settled?.queueItemId).toBe(receipt.queueItemId);
    expect(settled?.offset).toMatch(/^\d{16}$/);

    faux.unregister();
  });
});

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitForAsync: timed out");
}

async function waitForStatus(events: BusEvent[], threadId: string, status: string, timeoutMs = 2000): Promise<void> {
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
