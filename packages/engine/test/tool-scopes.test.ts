import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, getApiProvider, registerApiProvider, registerFauxProvider, Type, unregisterApiProviders, type TranscriptContext } from "@earendil-works/pi-ai/compat";
import { builtinTools, Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type ToolDef } from "../src/index.js";
import { CONTINUATION_TOOL_SCOPE_KEY, UNATTENDED_WORKFLOW_KEY } from "@valet/shared";

describe.each(["user", "team"] as const)("%s task scopes", (ownerType) => {
  it("persists a continuation ceiling per thread and replaces it for a new task", async () => {
    const faux = registerFauxProvider({ provider: `scope-continuation-${ownerType}` });
    try {
      const store = new InMemorySessionStore();
      const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
      const options = { userId: "alice", orgId: "org", owner: { type: ownerType, id: ownerType === "user" ? "alice" : "team" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [] };
      const session = await engine.createSession(options);
      const scoped = await session.createThread("scoped");
      const other = await session.createThread("other");
      faux.setResponses([fauxAssistantMessage("done")]);
      const receipt = await scoped.submitPrompt("inspect", { metadata: { toolScope: { tools: [], actions: [] } } });
      await scoped.awaitResult(receipt.queueItemId);
      expect((await store.getThread(session.id, scoped.id))?.metadata?.[CONTINUATION_TOOL_SCOPE_KEY]).toEqual({ tools: [], actions: [] });
      expect((await store.getThread(session.id, other.id))?.metadata?.[CONTINUATION_TOOL_SCOPE_KEY]).toBeUndefined();
      const fresh = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
      const restored = await fresh.restoreSession({ sessionId: session.id, options });
      expect(restored.threadById(scoped.id)?.toThreadData().metadata?.[CONTINUATION_TOOL_SCOPE_KEY]).toEqual({ tools: [], actions: [] });
      faux.setResponses([fauxAssistantMessage("done")]);
      const restoredThread = restored.threadById(scoped.id);
      if (!restoredThread) throw new Error("restored thread missing");
      const next = await restoredThread.submitPrompt("new task", {});
      await restoredThread.awaitResult(next.queueItemId);
      expect((await store.getThread(session.id, scoped.id))?.metadata?.[CONTINUATION_TOOL_SCOPE_KEY]).toEqual({});
    } finally { faux.unregister(); }
  });

  it("offers newly selected tools on the next model call in the same submission", async () => {
    const faux = registerFauxProvider({ provider: `scope-refresh-${ownerType}` });
    const store = new InMemorySessionStore();
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    let writes = 0;
    const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: ownerType, id: ownerType === "user" ? "alice" : "team" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [],
      initialToolFocus: () => ({ tools: ["focus_tools"] }),
      tools: [
        { name: "focus_tools", description: "Focus", parameters: Type.Object({}), execute: async (_, ctx) => { await ctx.setToolFocus?.(undefined); return { text: "general" }; } },
        { name: "write_record", description: "Write", parameters: Type.Object({}), execute: async () => { writes++; return { text: "saved" }; } },
      ],
    });
    const thread = await session.createThread("editor");
    expect((await store.getThread(session.id, thread.id))?.metadata?.toolScope).toEqual({ tools: ["focus_tools"] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("focus_tools", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("write_record", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const receipt = await session.prompt("repair", { threadId: thread.id });
    await thread.awaitResult(receipt.queueItemId);
    expect(writes).toBe(1);
    faux.unregister();
  });

  it("keeps a submission ceiling when collect mode combines messages", async () => {
    const faux = registerFauxProvider({ provider: `scope-collect-${ownerType}` });
    const store = new InMemorySessionStore();
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    let writes = 0;
    const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: ownerType, id: ownerType === "user" ? "alice" : "team" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [], collectWindowMs: 10,
      tools: [{ name: "write_record", description: "Write", parameters: Type.Object({}), execute: async () => { writes++; return { text: "saved" }; } }],
    });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("write_record", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    const receipt = await session.prompt("write", { queueMode: "collect", metadata: { toolScope: { tools: [], actions: [] } } });
    await session.thread().awaitResult(receipt.queueItemId);
    expect(writes).toBe(0);
    const items = await store.getEntries(session.id, receipt.threadId);
    expect(JSON.stringify(items)).not.toContain('"text":"saved"');
    faux.unregister();
  });

  it("isolates thread focus and refuses a stale same-batch write", async () => {
    const faux = registerFauxProvider({ provider: `scope-${ownerType}` });
    const store = new InMemorySessionStore();
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    const writes: string[] = [];
    const tools: ToolDef[] = [
      { name: "focus_tools", description: "Focus", parameters: Type.Object({}), execute: async (_, ctx) => {
        await ctx.setToolFocus?.({ tools: ["focus_tools"] }); return { text: "focused" };
      } },
      { name: "change_record", description: "Change", parameters: Type.Object({}), execute: async (_, ctx) => {
        writes.push(ctx.threadId); return { text: "changed" };
      } },
    ];
    const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: ownerType, id: ownerType === "user" ? "alice" : "owner" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [], tools });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("focus_tools", {}), fauxToolCall("change_record", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("finished"),
    ]);
    const first = await session.prompt("diagnose", { threadId: session.thread("private:alice").id });
    await session.thread("private:alice").awaitResult(first.queueItemId);
    expect(writes).toEqual([]);
    expect(JSON.stringify(await session.thread("private:alice").readEntries())).toContain("outside this task");
    faux.setResponses([fauxAssistantMessage([fauxToolCall("change_record", {})], { stopReason: "toolUse" }), fauxAssistantMessage("finished")]);
    const second = await session.prompt("change", { threadId: session.thread("private:bob").id });
    await session.thread("private:bob").awaitResult(second.queueItemId);
    expect(writes).toEqual([second.threadId]);
    const focused = await store.getThread(session.id, first.threadId);
    expect(focused?.metadata?.toolScope).toEqual({ tools: ["focus_tools"] });
    await Promise.all([
      session.thread("private:alice").setToolFocus({ actions: ["github.get_issue"] }),
      session.thread("private:bob").setToolFocus({ actions: ["slack.search"] }),
    ]);
    expect(session.thread("private:alice").effectiveToolScope()).toEqual({ actions: ["github.get_issue"] });
    expect(session.thread("private:bob").effectiveToolScope()).toEqual({ actions: ["slack.search"] });
    faux.unregister();
  });

  it("preserves a session ceiling on restore and ignores a broader focus", async () => {
    const faux = registerFauxProvider({ provider: `scope-restore-${ownerType}` });
    const store = new InMemorySessionStore();
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    const options = { userId: "alice", orgId: "org", owner: { type: ownerType, id: ownerType === "user" ? "alice" : "owner" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [] };
    const session = await engine.createSession({ ...options, toolScope: { tools: [], actions: ["workflows.get_run"] } });
    const fresh = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    const restored = await fresh.restoreSession({ sessionId: session.id, options });
    await restored.thread().setToolFocus({ tools: ["bash"], actions: ["slack.*"] });
    expect(restored.thread().effectiveToolScope()).toEqual({ tools: [], actions: [] });
    faux.unregister();
  });
});

describe("unattended workflow tasks", () => {
  const ASKS = ["ask_question", "ask_approval"];
  /** The tool names the engine offered on the turn's first model request. */
  async function offeredTools(provider: string, purpose: "workflow" | "orchestrator", metadata: Record<string, unknown>): Promise<string[]> {
    const faux = registerFauxProvider({ provider });
    const original = getApiProvider(faux.api);
    if (!original) throw new Error("faux provider missing");
    let offered: string[] | undefined;
    // The transcript declares tools on system messages as they are added or removed.
    const record = (context: TranscriptContext) => {
      if (offered) return;
      const names = new Set<string>();
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsAdded ?? []) names.add(tool.name);
        for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
      }
      offered = [...names];
    };
    registerApiProvider({ api: faux.api,
      stream: (model, context, options) => { record(context); return original.stream(model, context, options); },
      streamSimple: (model, context, options) => { record(context); return original.streamSimple(model, context, options); },
    }, `${provider}-recorder`);
    try {
      const engine = new Engine({ providers: { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
      const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: "team", id: "team" }, workspace: "/", sandbox: {}, purpose, model: faux.getModel(), builtinTools });
      faux.setResponses([fauxAssistantMessage("done")]);
      const receipt = await session.prompt("report", { metadata });
      await session.thread().awaitResult(receipt.queueItemId);
      return offered ?? [];
    } finally {
      unregisterApiProviders(`${provider}-recorder`);
      faux.unregister();
    }
  }

  it.each([
    ["a workflow step session", "workflow", {}],
    ["a workflow task in an assistant thread", "orchestrator", { [UNATTENDED_WORKFLOW_KEY]: true }],
  ] as const)("does not offer tools that wait for a person to %s", async (label, purpose, metadata) => {
    const offered = await offeredTools(`unattended-${purpose}`, purpose, metadata);
    expect(offered, label).toContain("read");
    for (const name of ASKS) expect(offered, label).not.toContain(name);
  });

  it("still offers them to a person's own prompt in an assistant thread", async () => {
    const offered = await offeredTools("attended-orchestrator", "orchestrator", {});
    for (const name of ASKS) expect(offered).toContain(name);
  });
});
