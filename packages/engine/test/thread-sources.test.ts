import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { readSources } from "@valet/shared";
import { fauxAssistantMessage, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type BusEvent } from "../src/index.js";
import { defineTool } from "../src/builtin-tools/index.js";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";

const lookup = defineTool({
  name: "lookup",
  description: "Read a source.",
  intent: "exempt",
  parameters: Type.Object({}),
  execute: async () => ({
    text: "The deployment starts at 5pm.",
    label: "Read the deployment note",
    sources: [{ service: "memory", title: "Deployment", url: "/memory/deployment.md", snippet: "Starts at 5pm." }],
  }),
});

function setup() {
  const store = new InMemorySessionStore();
  const stream = new InMemoryEventStream();
  const events: BusEvent[] = [];
  stream.subscribe({}, event => events.push(event));
  const providers = { store, stream, sandboxProvider: new VirtualSandboxProvider() };
  return { providers, events, engine: new Engine({ providers }) };
}

async function waitForIdle(events: BusEvent[], queueItemId: string) {
  await expect.poll(() => events.some(event => event.queueItemId === queueItemId && event.event.type === "submission_settled")).toBe(true);
}

describe("thread source citations", () => {
  it.each(["fork", "duplicate", "restore"])("keeps inherited source ids distinct when a %s reads a new source", async mode => {
    const faux = registerFauxProvider({ provider: `copied-sources-${mode}` });
    let reads = 0;
    const reader = defineTool({
      name: "source_reader", description: "Read a note", intent: "exempt", parameters: Type.Object({}),
      execute: async () => ({ text: "A note", sources: [{ service: "memory", title: ++reads === 1 ? "Original note" : "New note" }] }),
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(reader.name, {}, { id: "original-read" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Original [s1]."),
      fauxAssistantMessage([fauxToolCall(reader.name, {}, { id: "new-read" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Original [s1]. New [s2]."),
    ]);
    const { engine, providers, events } = setup();
    const options = { userId: "alice", orgId: "org", workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [reader] };
    const original = await engine.createSession(options);
    let destination = original;
    try {
      const receipt = await original.prompt("Read the original");
      await waitForIdle(events, receipt.queueItemId);
      const sourceThread = original.threadById(receipt.threadId);
      if (!sourceThread) throw new Error("Expected source thread");
      let target = sourceThread;
      if (mode === "restore") {
        const row = await providers.store.getThread(original.id, sourceThread.id);
        if (!row) throw new Error("Expected source thread");
        await providers.store.saveThread(original.id, { ...row, metadata: undefined });
        original.suspendTimers();
        destination = await new Engine({ providers }).restoreSession({ sessionId: original.id, options });
        const restoredThread = destination.threadById(sourceThread.id);
        if (!restoredThread) throw new Error("Expected restored source thread");
        target = restoredThread;
      } else {
        const reply = (await sourceThread.readEntries()).find(entry => entry.type === "message" && entry.role === "assistant" && entry.stopReason === "end_turn");
        if (!reply) throw new Error("Expected source reply");
        if (mode === "duplicate") destination = await engine.createSession(options);
        target = await destination.createThread("copied");
        await target.copyPath(await sourceThread.forkPath(reply.id), { source: { sessionId: original.id, threadId: sourceThread.id } });
      }
      const next = await destination.prompt("Read a new note", { threadId: target.id });
      await waitForIdle(events, next.queueItemId);
      const entries = await target.readEntries();
      expect(entries.flatMap(entry => entry.type === "message" ? (entry.parts ?? []).flatMap(part => part.type === "tool_call" ? readSources(part.result) : []) : [])
        .map(source => ({ id: source.id, title: source.title }))).toEqual([
          { id: "s1", title: "Original note" }, { id: "s2", title: "New note" },
        ]);
      expect(entries.find(entry => entry.type === "message" && entry.role === "assistant" && entry.queueItemId === next.queueItemId && entry.stopReason === "end_turn"))
        .toMatchObject({ content: "Original [s1]. New [s2]." });
    } finally {
      original.suspendTimers();
      destination.suspendTimers();
      faux.unregister();
    }
  });

  it("ships text-only semantic failures live with the same details stored for reload", async () => {
    const faux = registerFauxProvider({ provider: "live-semantic-failure" });
    const failing = defineTool({
      name: "semantic_failure", description: "Fail an action", intent: "exempt", parameters: Type.Object({}),
      execute: async () => ({ text: "Permission denied", ok: false }),
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(failing.name, {}, { id: "failed-action" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("The action was denied."),
    ]);
    const { engine, events } = setup();
    const session = await engine.createSession({ userId: "alice", orgId: "org", workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [failing] });
    try {
      const receipt = await session.prompt("Run the action");
      await waitForIdle(events, receipt.queueItemId);
      const live = events.map(event => event.event).find(event => event.type === "tool_end");
      const call = (await session.readEntries("web:default"))
        .flatMap(entry => entry.type === "message" ? entry.parts ?? [] : []).find(part => part.type === "tool_call");
      expect(live?.type === "tool_end" && live.resultData).toMatchObject({ details: { ok: false } });
      expect(live?.type === "tool_end" && live.resultData).toEqual(call?.type === "tool_call" && call.result);
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("keeps a capped result's whole text out of the live event and names its stored entry", async () => {
    const faux = registerFauxProvider({ provider: "live-capped-failure" });
    const whole = "x".repeat(120_000);
    const failing = defineTool({
      name: "large_failure", description: "Fail with a long log", intent: "exempt", parameters: Type.Object({}),
      execute: async () => ({ text: whole, ok: false }),
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(failing.name, {}, { id: "large-failure" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("The action failed."),
    ]);
    const { engine, events } = setup();
    const session = await engine.createSession({ userId: "alice", orgId: "org", workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [failing] });
    try {
      const receipt = await session.prompt("Run the action");
      await waitForIdle(events, receipt.queueItemId);
      const live = events.map(event => event.event).find(event => event.type === "tool_end");
      const holder = (await session.readEntries("web:default"))
        .find(entry => entry.type === "message" && (entry.parts ?? []).some(part => part.type === "tool_call"));
      const call = holder?.type === "message" ? holder.parts?.find(part => part.type === "tool_call") : undefined;
      expect(call?.type === "tool_call" && call.result).toMatchObject({ details: { ok: false, fullText: whole } });
      expect(live?.type === "tool_end" && live.resultTrimmed).toEqual({ chars: whole.length, entryId: holder?.id });
      expect(live?.type === "tool_end" && live.resultData).toMatchObject({ details: { ok: false } });
      expect(live?.type === "tool_end" && live.resultData).not.toHaveProperty("details.fullText");
      expect(JSON.stringify(live).length).toBeLessThan(10_000);
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("keeps only citations backed by stored tool sources in settled text and broadcast parts", async () => {
    const faux = registerFauxProvider({ provider: "settled-source-citations" });
    let systemPrompt = "";
    let seenContext = "";
    const answer = "Starts at 5pm [s1]. Unknown [s99]. Literal `[s99]` and [s99](https://example.com).\n\n```text\n[s99]\n```";
    const expected = "Starts at 5pm [s1]. Unknown . Literal `[s99]` and [s99](https://example.com).\n\n```text\n[s99]\n```";
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "lookup-1" })], { stopReason: "toolUse" }),
      context => {
        systemPrompt = getCurrentSystemPrompt(context.messages) ?? "";
        seenContext = JSON.stringify(context.messages);
        return fauxAssistantMessage(answer);
      },
    ]);
    const { engine, events } = setup();
    const session = await engine.createSession({ userId: "alice", orgId: "org", workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [lookup] });
    try {
      const receipt = await session.prompt("When is the deployment?");
      await waitForIdle(events, receipt.queueItemId);
      const entries = await session.readEntries("web:default");
      const reply = entries.find(entry => entry.type === "message" && entry.role === "assistant" && entry.stopReason === "end_turn");
      expect(reply).toMatchObject({ content: expected, parts: [{ type: "text", text: expected }] });
      expect(events.map(event => event.event).find(event => event.type === "message_update" && event.messageId === reply?.id))
        .toMatchObject({ content: expected, parts: [{ type: "text", text: expected }] });
      expect(systemPrompt).toContain("[sN]");
      expect(systemPrompt).toMatch(/never invent/i);
      expect(seenContext).toContain("Sources:\\n[s1] Deployment");
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("ships text-only source metadata live with the same details stored for reload", async () => {
    const faux = registerFauxProvider({ provider: "live-source-details" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "lookup-live" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Starts at 5pm [s1]."),
    ]);
    const { engine, events } = setup();
    const session = await engine.createSession({ userId: "alice", orgId: "org", workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [lookup] });
    try {
      const receipt = await session.prompt("Read the note");
      await waitForIdle(events, receipt.queueItemId);
      const live = events.map(event => event.event).find(event => event.type === "tool_end");
      expect(live?.type === "tool_end" && live.resultData).toMatchObject({
        details: { label: "Read the deployment note", sources: [{ id: "s1", title: "Deployment" }] },
      });
      const entries = await session.readEntries("web:default");
      const call = entries.flatMap(entry => entry.type === "message" ? entry.parts ?? [] : []).find(part => part.type === "tool_call");
      expect(live?.type === "tool_end" && live.resultData).toEqual(call?.type === "tool_call" && call.result);
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("validates restored sources against stored records rather than allocated sequence numbers", async () => {
    const faux = registerFauxProvider({ provider: "restored-source-citations" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "lookup-restore" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Read it [s1]."),
      fauxAssistantMessage("The note [s1]. Reserved [s2]."),
      fauxAssistantMessage("Another thread [s1]."),
    ]);
    const { engine, providers, events } = setup();
    const options = { userId: "alice", orgId: "org", workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [lookup] };
    const session = await engine.createSession(options);
    try {
      const first = await session.prompt("Read the note");
      await waitForIdle(events, first.queueItemId);
      const thread = await session.threadByKey("web:default");
      expect(await thread?.allocateSourceIds(1)).toEqual(["s2"]);
      session.suspendTimers();
      const restored = await new Engine({ providers }).restoreSession({ sessionId: session.id, options });
      try {
        const next = await restored.prompt("What did it say?");
        await waitForIdle(events, next.queueItemId);
        expect((await restored.readEntries("web:default")).find(entry => entry.type === "message" && entry.role === "assistant" && entry.queueItemId === next.queueItemId))
          .toMatchObject({ content: "The note [s1]. Reserved ." });
        const otherThread = await restored.createThread("other");
        const other = await restored.prompt("There is no source here", { threadId: otherThread.id });
        await waitForIdle(events, other.queueItemId);
        expect((await restored.readEntries("other")).find(entry => entry.type === "message" && entry.role === "assistant"))
          .toMatchObject({ content: "Another thread ." });
      } finally { restored.suspendTimers(); }
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("reads no whole thread to number or check sources once the thread stores its source number", async () => {
    const faux = registerFauxProvider({ provider: "bounded-source-reads" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "lookup-first" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("First [s1]."),
      fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "lookup-second" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Second [s2]."),
    ]);
    const { engine, providers, events } = setup();
    const options = { userId: "alice", orgId: "org", workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [lookup] };
    const session = await engine.createSession(options);
    const wholeReads: string[] = [];
    const getEntries = providers.store.getEntries.bind(providers.store);
    providers.store.getEntries = async (sessionId, threadId, opts) => {
      const bounded = opts?.queueItemId !== undefined || opts?.limit !== undefined || opts?.headLimit !== undefined
        || opts?.entryIds !== undefined || opts?.entryTypes !== undefined;
      if (!bounded) wholeReads.push(threadId);
      return getEntries(sessionId, threadId, opts);
    };
    try {
      const first = await session.prompt("Read the note");
      await waitForIdle(events, first.queueItemId);
      session.suspendTimers();
      const restored = await new Engine({ providers }).restoreSession({ sessionId: session.id, options });
      try {
        wholeReads.length = 0;
        const next = await restored.prompt("Read it again");
        await waitForIdle(events, next.queueItemId);
        expect(wholeReads).toEqual([]);
        expect((await restored.readEntries("web:default")).find(entry => entry.type === "message" && entry.role === "assistant"
          && entry.queueItemId === next.queueItemId && entry.stopReason === "end_turn")).toMatchObject({ content: "Second [s2]." });
      } finally { restored.suspendTimers(); }
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("keeps replayed approval source results identical on the live event and stored entry", async () => {
    const faux = registerFauxProvider({ provider: "replayed-source-citations" });
    const gated = defineTool({
      name: "approved_lookup", description: "Read after approval", parameters: Type.Object({}), intent: "exempt",
      execute: async (_args, ctx) => {
        await ctx.requestDecision({ type: "approval", title: "Read the source?", resumeKey: "source-read" });
        return { text: "Read the note", label: "Read an approved source", sources: [{ service: "memory", title: "Note", url: "/memory/note.md" }] };
      },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(gated.name, {}, { id: "lookup-approved" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Read it [s1]."),
    ]);
    const { engine, providers, events } = setup();
    const options = { userId: "alice", orgId: "org", workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [gated] };
    const session = await engine.createSession(options);
    try {
      const receipt = await session.prompt("Read with approval");
      await expect.poll(async () => (await providers.store.listDecisionGates(session.id)).some(gate => gate.status === "pending")).toBe(true);
      const gate = (await providers.store.listDecisionGates(session.id)).find(gate => gate.status === "pending");
      if (!gate) throw new Error("Expected a pending approval");
      session.suspendTimers();
      const restored = await new Engine({ providers }).restoreSession({ sessionId: session.id, options });
      try {
        await restored.resolveDecision(gate.id, { actionId: "approve", resolvedBy: "alice", resolvedAt: Date.now() });
        await restored.thread(receipt.threadId).awaitResult(receipt.queueItemId);
        const live = events.map(event => event.event).find(event => event.type === "tool_end" && event.callId === "lookup-approved");
        const call = (await restored.readEntries("web:default"))
          .flatMap(entry => entry.type === "message" ? entry.parts ?? [] : []).find(part => part.type === "tool_call");
        expect(live?.type === "tool_end" && live.resultData).toMatchObject({ details: { label: "Read an approved source", sources: [{ id: "s1" }] } });
        expect(live?.type === "tool_end" && live.resultData).toEqual(call?.type === "tool_call" && call.result);
      } finally { restored.suspendTimers(); }
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });
});
