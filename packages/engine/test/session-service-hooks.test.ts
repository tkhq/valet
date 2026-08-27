import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import type { Context } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type CompactionHook,
  type ToolContext,
  type ToolDef,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({
    providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
  });
  return { engine, store, bus, events };
}

async function waitForStatus(
  events: BusEvent[],
  threadId: string,
  status: string,
  timeoutMs = 2000,
  fromIndex = 0,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events
        .slice(fromIndex)
        .some((e) => e.event.type === "status" && e.event.threadId === threadId && e.event.status === status);
      if (found) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for status=${status}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function waitForAsync(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitForAsync: timed out");
}

describe("session service hooks (systemContext, toolConfig, owner, compaction hooks)", () => {
  it("systemContext fragments land sorted by (order, name), after base prompt and before role overlay", async () => {
    const faux = registerFauxProvider({ provider: "svc1" });
    const capturedPrompts: (string | undefined)[] = [];
    const captureStep = (text: string) => async (context: Context) => {
      capturedPrompts.push(context.systemPrompt);
      return fauxAssistantMessage(text);
    };
    faux.setResponses([captureStep("ok")]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      systemPrompt: "BASE-PROMPT",
      roles: [{ name: "helper", content: "ROLE-TEXT" }],
      systemContext: [
        { name: "b-fragment", content: "FRAG-B", order: 10 },
        { name: "a-fragment", content: "FRAG-A", order: 10 },
        { name: "z-no-order", content: "FRAG-Z" },
      ],
    });

    const receipt = await session.prompt("hi", { role: "helper" });
    await waitForStatus(events, receipt.threadId, "idle");

    const prompt = capturedPrompts[0] ?? "";
    const baseIdx = prompt.indexOf("BASE-PROMPT");
    const fragAIdx = prompt.indexOf("FRAG-A");
    const fragBIdx = prompt.indexOf("FRAG-B");
    const fragZIdx = prompt.indexOf("FRAG-Z");
    const roleIdx = prompt.indexOf("ROLE-TEXT");

    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(fragAIdx).toBeGreaterThan(baseIdx);
    // order 10 fragments sorted by name: a-fragment before b-fragment.
    expect(fragBIdx).toBeGreaterThan(fragAIdx);
    // z-no-order defaults to order 100, sorts after the order:10 fragments.
    expect(fragZIdx).toBeGreaterThan(fragBIdx);
    expect(roleIdx).toBeGreaterThan(fragZIdx);

    faux.unregister();
  });

  it("toolConfig is visible as ctx.config inside a tool execution", async () => {
    const faux = registerFauxProvider({ provider: "svc2" });
    let seenConfig: Record<string, unknown> | undefined;
    const configTool: ToolDef = {
      name: "read_config",
      description: "reads toolConfig",
      parameters: Type.Object({}),
      execute: async (_args, ctx: ToolContext) => {
        seenConfig = ctx.config;
        return { text: "ok" };
      },
    };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read_config", {}, { id: "tc1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      tools: [configTool],
      toolConfig: { apiBaseUrl: "http://internal", internalToken: "tok" },
    });

    const receipt = await session.prompt("go");
    await waitForStatus(events, receipt.threadId, "idle");

    expect(seenConfig).toEqual({ apiBaseUrl: "http://internal", internalToken: "tok" });

    faux.unregister();
  });

  it("owner persists via toData and defaults to user:{userId} when absent", async () => {
    const { engine } = makeEngine();
    const faux = registerFauxProvider({ provider: "svc3" });
    faux.setResponses([fauxAssistantMessage("hi")]);

    const defaultSession = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });
    expect((await defaultSession.toData()).owner).toEqual({ type: "user", id: "u1" });

    const teamSession = await engine.createSession({
      userId: "u2",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      owner: { type: "team", id: "team-1" },
    });
    expect((await teamSession.toData()).owner).toEqual({ type: "team", id: "team-1" });

    faux.unregister();
  });

  it("a restored team-owned session is not stomped back to user-owned on next save", async () => {
    const { engine, store, bus } = makeEngine();
    const faux = registerFauxProvider({ provider: "svc4" });
    faux.setResponses([fauxAssistantMessage("hi")]);

    const created = await engine.createSession({
      id: "sess-owner-1",
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      owner: { type: "team", id: "team-9" },
    });
    await store.saveSession(await created.toData());

    // Simulate a process restart: a fresh Engine instance (same durable
    // store) rehydrates the session. Its options don't re-supply `owner`,
    // as real hosts typically won't round-trip it through
    // CreateSessionOptions on restore — the persisted value must win.
    const restartedEngine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const restored = await restartedEngine.restoreSession({
      sessionId: "sess-owner-1",
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/workspace",
        sandbox: {},
        model: faux.getModel(),
      },
    });

    expect((await restored.toData()).owner).toEqual({ type: "team", id: "team-9" });

    faux.unregister();
  });

  it("parentSessionId/parentThreadId persist via toData and survive a restore that doesn't re-supply them", async () => {
    const { engine, store, bus } = makeEngine();
    const faux = registerFauxProvider({ provider: "svc3b" });
    faux.setResponses([fauxAssistantMessage("hi")]);

    const child = await engine.createSession({
      id: "sess-child-1",
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      purpose: "child",
      parentSessionId: "sess-parent-1",
      parentThreadId: "th-parent-1",
    });
    expect((await child.toData()).parentSessionId).toBe("sess-parent-1");
    expect((await child.toData()).parentThreadId).toBe("th-parent-1");
    await store.saveSession(await child.toData());

    // A restart-style restore whose options don't re-supply
    // parentSessionId/parentThreadId (the app's generic sessionFor
    // chokepoint never does) must still see the persisted linkage — this
    // is what the signal edge ACL (parent <-> child) reads directly off
    // the store.
    const restartedEngine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const restored = await restartedEngine.restoreSession({
      sessionId: "sess-child-1",
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/workspace",
        sandbox: {},
        model: faux.getModel(),
      },
    });
    expect((await restored.toData()).parentSessionId).toBe("sess-parent-1");
    expect((await restored.toData()).parentThreadId).toBe("th-parent-1");

    faux.unregister();
  });

  it("compaction hooks fire in order with the summary after a manual compaction; a throwing hook does not fail compaction", async () => {
    const { engine, events } = makeEngine();
    const faux = registerFauxProvider({ provider: "svc5" });
    faux.setResponses([
      fauxAssistantMessage("first turn response"),
      fauxAssistantMessage("second turn response"),
    ]);

    const calls: string[] = [];
    const hookA: CompactionHook = async (args) => {
      calls.push(`A:${args.mode}:${args.threadId}`);
    };
    const hookThrows: CompactionHook = async () => {
      calls.push("throws");
      throw new Error("boom");
    };
    const hookC: CompactionHook = async (args) => {
      calls.push(`C:${typeof args.summary}`);
    };

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      // tailTurns: 1 forces the cut point to sit exactly at the second
      // turn's boundary once two turns exist, guaranteeing a non-trivial
      // head to summarize regardless of token-budget heuristics.
      compaction: { tailTurns: 1 },
      compactionHooks: [hookA, hookThrows, hookC],
    });

    const receipt1 = await session.prompt("first message");
    await waitForStatus(events, receipt1.threadId, "idle");
    const fromIndex = events.length;
    const receipt2 = await session.prompt("second message");
    await waitForStatus(events, receipt2.threadId, "idle", 2000, fromIndex);

    const thread = await session.threadByKey("web:default");
    if (!thread) throw new Error("thread not found");

    await expect(thread.compactThread({ mode: "manual" })).resolves.not.toThrow();
    await waitForAsync(() => calls.length >= 3);

    expect(calls[0]).toMatch(/^A:manual:/);
    expect(calls[1]).toBe("throws");
    expect(calls[2]).toMatch(/^C:string$/);

    faux.unregister();
  });
});
