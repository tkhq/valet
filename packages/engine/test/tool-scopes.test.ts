import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type ToolDef } from "../src/index.js";

describe.each(["user", "team"] as const)("%s task scopes", (ownerType) => {
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
