/**
 * Model switching: layered resolution + the `switch_model` builtin tool.
 *
 * Strategy: register two fauxes that override the *real* anthropic model
 * ids `claude-haiku-4-5` and `claude-opus-4-7`. That way:
 *   - `resolveModelId("claude-opus-4-7")` returns a Model object (the
 *     real id is in pi-ai's static registry, the faux replaces its
 *     behavior).
 *   - setModel's own resolution can be asserted without a host resolver.
 *
 * TWO HARNESS TRAPS, both of which produced confident wrong answers here:
 *
 * 1. A faux registered over a real anthropic id does NOT intercept the
 *    stream. A turn built that way reaches the live Anthropic API and
 *    bills real tokens; the faux's queued responses never fire. To observe
 *    which model a call reached, give each faux its own PROVIDER and tell
 *    them apart by spec through `modelSpec` + the `resolveModel` seam
 *    (every faux model's `.id` is "faux-1", so wire ids cannot separate
 *    them). The escalation suite below does this.
 *
 * 2. `status: "idle"` fires at every `turn_end`, not at the end of a
 *    submission. Waiting on it after a multi-turn run matches an idle from
 *    an earlier turn and samples state mid-flight — which reads exactly
 *    like a hung turn. Wait on `submission_settled`.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getModel,
  registerBuiltInApiProviders,
  registerFauxProvider,
  Type,
  type FauxProvider,
  type Model,
} from "@earendil-works/pi-ai/compat";
import {
  builtinTools,
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  loadRoleFromMarkdown,
  VirtualSandboxProvider,
  type BusEvent,
  type DecisionGate,
  type QueueItem,
  type ResolvedModel,
  type ToolDef,
} from "../src/index.js";
import { switchModelTool, taskTool } from "../src/builtin-tools/index.js";

const builtinToolNames = builtinTools.map((t) => t.name);

const HAIKU = "claude-haiku-4-5";
const OPUS = "claude-opus-4-7";

interface SetupResult {
  haikuFaux: FauxProvider;
  opusFaux: FauxProvider;
  engine: Engine;
  /** A second engine over the same providers — restores past `engine`'s
   *  session cache, which is what a process restart looks like. */
  newEngine: () => Engine;
  store: InMemorySessionStore;
  events: BusEvent[];
  /** The "real" registry entry for haiku (now backed by the faux). Has the
   *  proper id "claude-haiku-4-5" — which is what we test setModel against,
   *  not the faux's internal "faux-1". */
  baseModel: Model<unknown>;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    const c = cleanups.pop();
    try {
      c?.();
    } catch {
      // ignore — fauxes are fire-and-forget for tests
    }
  }
});

function setup(): SetupResult {
  const haikuFaux = registerFauxProvider({ provider: "anthropic", model: HAIKU });
  const opusFaux = registerFauxProvider({ provider: "anthropic", model: OPUS });
  cleanups.push(() => haikuFaux.unregister());
  cleanups.push(() => opusFaux.unregister());

  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });

  // Pull the registry-shaped Model — its `.id` is "claude-haiku-4-5",
  // which matches what setModel resolves against. The faux's own
  // getModel() returns a Model with `.id === "faux-1"` and would make
  // setModel comparisons fail.
  const baseModel = getModel("anthropic", HAIKU as never)!;
  const newEngine = () => new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { haikuFaux, opusFaux, engine, newEngine, store, events, baseModel };
}

function modelStateEvents(events: BusEvent[]) {
  return events.flatMap((event) => event.event.type === "model_state" ? [event.event] : []);
}

function approvalTool(): ToolDef {
  return {
    name: "do_thing",
    description: "Do a sensitive thing after approval.",
    parameters: Type.Object({ arg: Type.String() }),
    execute: async (args, ctx) => {
      const resolution = await ctx.requestDecision({
        type: "approval",
        title: "approve do_thing?",
        body: `arg=${args.arg}`,
        resumeKey: `do_thing:${args.arg}`,
      });
      return { text: resolution.actionId === "approve" ? "approved" : "denied" };
    },
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitForCondition: timed out");
}

describe("engine: model switching", () => {
  it("keeps tool guidance consistent with supervisor-selected drafting and review tiers", () => {
    expect(taskTool.description).not.toContain("Pass `l` or `xl` for architecture");
    expect(taskTool.description).toContain("s/m/l for drafting");
    expect(taskTool.description).toContain("l/xl for separate review");
    expect(taskTool.description).toContain("XL children review only");
    expect(switchModelTool.description).toContain("Children retain their assigned model");
    expect(switchModelTool.description).toContain("capability gap");
  });

  it("Thread.setModel persists the override and emits model_switched", async () => {
    const { engine, store, events, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
    });
    const thread = await session.ensureDefaultThread();
    // Threads pin the session's effective model at creation (TKAI-201).
    expect(thread.modelId()).toBe(HAIKU);

    const r = await thread.setModel(OPUS);
    expect(r.fromModel).toBe(HAIKU);
    expect(r.toModel).toBe(OPUS);
    expect(thread.modelId()).toBe(OPUS);

    // Persistence: the store now reflects the override.
    const persisted = await store.getThread(session.id, thread.id);
    expect(persisted?.model).toBe(OPUS);

    // model_switched fired on the bus.
    const switched = events.find((e) => e.event.type === "model_switched");
    expect(switched).toBeDefined();
    const ev = switched!.event as { fromModel: string; toModel: string };
    expect(ev.fromModel).toBe(HAIKU);
    expect(ev.toModel).toBe(OPUS);

    // Clearing returns to session default.
    const r2 = await thread.setModel(null);
    expect(r2.toModel).toBe(HAIKU);
    expect(thread.modelId()).toBeUndefined();
  });

  it("rejects unknown model ids without mutating state", async () => {
    const { engine, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
    });
    const thread = await session.ensureDefaultThread();
    await expect(thread.setModel("nonexistent-model-9999")).rejects.toThrow(
      /unknown model id/,
    );
    // The rejected switch left the creation-time pin (TKAI-201) untouched.
    expect(thread.modelId()).toBe(HAIKU);
    await expect(session.setModel("nonexistent-model-9999")).rejects.toThrow(
      /unknown model id/,
    );
    expect(session.options.model.id).toBe(HAIKU);
  });

  it("session.setModel updates the session default and persists", async () => {
    const { engine, store, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
    });
    expect(session.options.model.id).toBe(HAIKU);

    const r = await session.setModel(OPUS);
    expect(r.toModel).toBe(OPUS);
    expect(session.options.model.id).toBe(OPUS);

    const persisted = await store.getSession(session.id);
    expect(persisted?.model).toBe(OPUS);
  });

  it("switch_model tool dispatches to ctx.setModel", async () => {
    // Unit-test the tool's own error handling with a stub ToolContext. The
    // full agent-loop integration (does the switch reach the next LLM call,
    // and does it end with the turn) is covered by the escalation suite at
    // the bottom of this file, which drives real turns across two fauxes.

    const calls: Array<{ model: string }> = [];
    const stubCtx = {
      setModel: async ({ model }: { model: string }) => {
        calls.push({ model });
        return { fromModel: HAIKU, toModel: model };
      },
    } as unknown as Parameters<typeof switchModelTool.execute>[1];

    const r1 = await switchModelTool.execute(
      { model: OPUS } as never,
      stubCtx,
    );
    expect(calls[0]).toEqual({ model: OPUS });
    expect((r1 as { text: string }).text).toContain(OPUS);
    // The result names the scope the switch actually has (TKAI-338).
    expect((r1 as { text: string }).text).toContain("turn");

    // Errors surface as a readable result rather than throwing.
    const failingCtx = {
      setModel: async () => {
        throw new Error("unknown model id: bogus");
      },
    } as unknown as Parameters<typeof switchModelTool.execute>[1];
    const r2 = await switchModelTool.execute(
      { model: "bogus" } as never,
      failingCtx,
    );
    expect((r2 as { text: string }).text).toContain("switch_model failed");
  });

  it("threads pin the session model at creation; a session default change only affects new threads", async () => {
    const { engine, store, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
    });
    const first = await session.ensureDefaultThread();
    expect(first.modelId()).toBe(HAIKU);
    const persisted = await store.getThread(session.id, first.id);
    expect(persisted?.model).toBe(HAIKU);

    await session.setModel(OPUS);
    // The existing chat keeps the model it started with.
    expect(first.modelId()).toBe(HAIKU);
    // A NEW thread pins the new default.
    const second = session.thread("web:second");
    expect(second.modelId()).toBe(OPUS);
  });

  it("createThread persists explicit settings before it exposes the thread", async () => {
    const { engine, store, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
    });

    const thread = await session.createThread("web:configured", {
      model: "s",
      reasoning: "high",
    });

    expect(thread.modelId()).toBe("s");
    expect(thread.reasoning()).toBe("high");
    expect(await store.getThread(session.id, thread.id)).toMatchObject({
      model: "s",
      reasoning: "high",
    });
    expect(await session.threadByKey("web:configured")).toBe(thread);
  });

  it("createThread persists an explicit no-reasoning setting across restore", async () => {
    const { engine, newEngine, store, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
      sampling: { reasoning: "high" },
    });

    const thread = await session.createThread("web:no-reasoning", {
      model: "s",
      reasoning: null,
    });
    expect(thread.reasoning()).toBeUndefined();
    expect((await store.getThread(session.id, thread.id))?.reasoning).toBe("off");

    const restored = await newEngine().restoreSession({
      sessionId: session.id,
      options: { userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: baseModel },
    });
    expect(restored.threadById(thread.id)?.toThreadData().reasoning).toBe("off");
  });

  it("createThread does not expose a thread when persistence fails", async () => {
    const { engine, store, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
    });
    vi.spyOn(store, "saveThread").mockRejectedValueOnce(new Error("store unavailable"));

    await expect(session.createThread("web:failed", { model: "s" })).rejects.toThrow(
      "store unavailable",
    );
    expect(await session.threadByKey("web:failed")).toBeNull();
    expect(session.listThreads()).toHaveLength(0);
  });

  it("QueueItem.model outranks the thread pin; a dead item pin fails loud", async () => {
    const { engine, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
    });
    const thread = await session.ensureDefaultThread();
    expect(thread.modelId()).toBe(HAIKU);

    const item = (model: string) => ({
      id: "q-test",
      threadId: thread.id,
      content: "hi",
      model,
      status: "queued" as const,
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Item pin wins over the thread pin.
    expect(thread.resolveTurnModel(item(OPUS)).id).toBe(OPUS);
    // No item pin → thread pin.
    expect(thread.resolveTurnModel().id).toBe(HAIKU);
    // A divergent pin that no longer resolves fails the turn loud, and the
    // error names the corrective action.
    expect(() => thread.resolveTurnModel(item("gone-model-9999"))).toThrow(
      /no longer available.*\/model/,
    );
  });

  it("submitPrompt rejects an unknown per-item model at admission", async () => {
    const { engine, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
    });
    const thread = await session.ensureDefaultThread();
    await expect(
      thread.submitPrompt("hi", { model: "gone-model-9999" }),
    ).rejects.toThrow(/unknown model id/);
    // A pin naming the session's own spec is accepted without registry
    // resolution (custom providers / test doubles are not in the registry).
    const receipt = await thread.submitPrompt("hi", { model: HAIKU });
    expect(receipt.queueItemId).toBeTruthy();
  });

  it("Thread.setReasoning persists the pin and survives a restore", async () => {
    const { engine, newEngine, store, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
    });
    const thread = await session.ensureDefaultThread();
    // A fresh thread carries no pin — it inherits the session default.
    expect(thread.reasoning()).toBeUndefined();

    await thread.setReasoning("high");
    expect(thread.reasoning()).toBe("high");
    expect((await store.getThread(session.id, thread.id))?.reasoning).toBe("high");

    // Reload the session from the store: the pin comes back with it.
    const restored = await newEngine().restoreSession({
      sessionId: session.id,
      options: { userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: baseModel },
    });
    expect(restored.threadById(thread.id)?.reasoning()).toBe("high");
    // The next save must not stomp the pin back to NULL.
    expect(restored.threadById(thread.id)?.toThreadData().reasoning).toBe("high");

    // null clears the pin, in memory and in the store.
    await thread.setReasoning(null);
    expect(thread.reasoning()).toBeUndefined();
    expect((await store.getThread(session.id, thread.id))?.reasoning).toBeUndefined();
  });

  it("session.setReasoning persists on the session row; a restore does not clobber it", async () => {
    const { engine, newEngine, store, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
    });
    expect(session.options.sampling?.reasoning).toBeUndefined();

    await session.setReasoning("low");
    expect(session.options.sampling?.reasoning).toBe("low");
    expect((await store.getSession(session.id))?.reasoning).toBe("low");
    expect((await session.toData()).reasoning).toBe("low");

    // A host that does not re-supply `sampling.reasoning` on restore keeps
    // the persisted level (same rule as purpose / start-ref).
    const restored = await newEngine().restoreSession({
      sessionId: session.id,
      options: { userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: baseModel },
    });
    expect(restored.options.sampling?.reasoning).toBe("low");
    expect((await restored.toData()).reasoning).toBe("low");

    // An explicit level from the host still wins.
    const reasserted = await newEngine().restoreSession({
      sessionId: session.id,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: baseModel,
        sampling: { reasoning: "max" },
      },
    });
    expect(reasserted.options.sampling?.reasoning).toBe("max");

    // null clears the session default.
    await session.setReasoning(null);
    expect(session.options.sampling?.reasoning).toBeUndefined();
    expect((await store.getSession(session.id))?.reasoning).toBeUndefined();
  });

  it("setReasoning rejects an unknown level without mutating state", async () => {
    const { engine, baseModel } = setup();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseModel,
      sampling: { reasoning: "medium" },
    });
    const thread = await session.ensureDefaultThread();
    await thread.setReasoning("high");

    await expect(thread.setReasoning("turbo")).rejects.toThrow(/unknown reasoning level/);
    expect(thread.reasoning()).toBe("high");
    await expect(session.setReasoning("turbo")).rejects.toThrow(/unknown reasoning level/);
    expect(session.options.sampling?.reasoning).toBe("medium");
  });

  it("switch_model is registered in builtinTools", () => {
    // Smoke check that the tool is wired into the agent's tool list. The
    // engine's session.builtinTools comes from `builtinTools` re-exported
    // from `builtin-tools/index.ts`. If someone deletes the entry there,
    // this fails loudly.
    const names = (
      // Use `unknown` indirection so we don't drag the engine's full
      // builtinTools type into this test file.
      builtinToolNames as readonly string[]
    );
    expect(names).toContain("switch_model");
  });
});

describe("engine: active submission model state", () => {
  it("publishes a concrete active model and clears only the matching settlement", async () => {
    const faux = registerFauxProvider({ provider: "active-model" });
    cleanups.push(() => faux.unregister());
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "x" }, { id: "tc-active" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const events: BusEvent[] = [];
    bus.subscribe({}, (event) => events.push(event));
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools: [approvalTool()],
    });
    const thread = await session.ensureDefaultThread();

    const receipt = await thread.submitPrompt("do it", {});
    await waitForCondition(() => events.some((event) => event.event.type === "decision_gate"));

    const active = {
      queueItemId: receipt.queueItemId,
      model: `${faux.getModel().provider}/${faux.getModel().id}`,
    };
    expect(modelStateEvents(events)).toEqual([
      { type: "model_state", threadId: thread.id, ...active },
    ]);
    expect(await thread.currentModelState()).toEqual(active);
    const snapshot = await thread.currentModelState();
    if (!snapshot) throw new Error("active model snapshot missing");
    snapshot.model = "mutated/by-test";
    expect(await thread.currentModelState()).toEqual(active);

    const now = Date.now();
    for (const outcome of ["merged", "superseded"] as const) {
      const unrelated: QueueItem = {
        id: `q-unrelated-${outcome}`,
        threadId: thread.id,
        content: `${outcome} elsewhere`,
        status: "queued",
        attemptCount: 0,
        maxAttempts: 10,
        timeoutAt: now + 3_600_000,
        createdAt: now,
        updatedAt: now,
      };
      await store.admitSubmission(session.id, thread.id, unrelated);
      await thread.settleReconciled(unrelated, { outcome }, null);
      expect(await thread.currentModelState()).toEqual(active);
      expect(modelStateEvents(events)).toHaveLength(1);
    }

    const gateEvent = events.find((event) => event.event.type === "decision_gate");
    if (!gateEvent || gateEvent.event.type !== "decision_gate") {
      throw new Error("decision gate missing");
    }
    await session.resolveDecision(gateEvent.event.gate.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === receipt.queueItemId,
      ),
    );

    expect(modelStateEvents(events)).toEqual([
      { type: "model_state", threadId: thread.id, ...active },
      { type: "model_state", threadId: thread.id, queueItemId: null, model: null },
    ]);
    expect(await thread.currentModelState()).toBeNull();
  });

  it("publishes the queue-item model before pre-turn compaction invokes the model", async () => {
    const faux = registerFauxProvider({
      provider: "active-before-compaction",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100_000, maxTokens: 5 }],
    });
    cleanups.push(() => faux.unregister());
    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const events: BusEvent[] = [];
    bus.subscribe({}, (event) => events.push(event));
    const model = faux.getModel("tiny");
    if (!model) throw new Error("tiny faux model missing");
    const options = {
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      compaction: { tailTurns: 1 },
    };
    const engineA = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const sessionA = await engineA.createSession(options);
    const threadA = sessionA.thread();
    await store.appendEntries(sessionA.id, threadA.id, [
      {
        id: "e-active-1",
        sessionId: sessionA.id,
        threadId: threadA.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first prompt",
        createdAt: 1,
      },
      {
        id: "e-active-2",
        sessionId: sessionA.id,
        threadId: threadA.id,
        parentId: "e-active-1",
        type: "message",
        role: "assistant",
        content: "x".repeat(300_000),
        createdAt: 2,
      },
      {
        id: "e-active-3",
        sessionId: sessionA.id,
        threadId: threadA.id,
        parentId: "e-active-2",
        type: "message",
        role: "user",
        content: "second prompt",
        createdAt: 3,
      },
      {
        id: "e-active-4",
        sessionId: sessionA.id,
        threadId: threadA.id,
        parentId: "e-active-3",
        type: "message",
        role: "assistant",
        content: "y".repeat(150_000),
        createdAt: 4,
      },
    ]);

    let activeBeforeFirstModelCall = false;
    const summary =
      "## Goal\n- test\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- prior turns\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)";
    faux.setResponses([
      () => {
        activeBeforeFirstModelCall = modelStateEvents(events).some(
          (event) => event.queueItemId !== null && event.model === `${model.provider}/${model.id}`,
        );
        return fauxAssistantMessage(summary);
      },
      fauxAssistantMessage("post-compaction response"),
    ]);

    const engineB = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const restored = await engineB.restoreSession({ sessionId: sessionA.id, options });
    const receipt = await restored.prompt("third prompt");
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === receipt.queueItemId,
      ),
    );

    expect(activeBeforeFirstModelCall).toBe(true);
    const activeIndex = events.findIndex(
      (event) =>
        event.event.type === "model_state" &&
        event.event.queueItemId === receipt.queueItemId,
    );
    const compactionIndex = events.findIndex(
      (event) => event.event.type === "compaction_start" && event.threadId === receipt.threadId,
    );
    expect(activeIndex).toBeGreaterThanOrEqual(0);
    expect(activeIndex).toBeLessThan(compactionIndex);
  });

  it("publishes base, role, then idle model state for a successful role turn", async () => {
    const baseFaux = registerFauxProvider({ provider: "active-role-success-base" });
    const roleFaux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    cleanups.push(() => baseFaux.unregister());
    cleanups.push(() => {
      roleFaux.unregister();
      registerBuiltInApiProviders();
    });
    let rolePrompt: string | undefined;
    roleFaux.setResponses([
      (context) => {
        rolePrompt = context.systemPrompt;
        return fauxAssistantMessage("review completed");
      },
    ]);
    let nextRun:
      | { provider: string; systemPrompt: string | undefined }
      | undefined;
    baseFaux.setResponses([
      (context, _options, _state, model) => {
        nextRun = { provider: model.provider, systemPrompt: context.systemPrompt };
        return fauxAssistantMessage("plain follow-up completed");
      },
    ]);
    const role = loadRoleFromMarkdown(`---
name: reviewer
description: Review code
model: ${HAIKU}
---

Role-only instructions.
`);
    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream({
      fenceCheck: (fence) => store.isCurrentAttempt(fence.itemId, fence.attemptId),
    });
    const events: BusEvent[] = [];
    bus.subscribe({}, (event) => events.push(event));
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseFaux.getModel(),
      systemPrompt: "Base instructions.",
      roles: [role],
    });
    const thread = await session.ensureDefaultThread();

    const receipt = await thread.submitPrompt("review this", { role: "reviewer" });
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === receipt.queueItemId,
      ),
    );

    expect(
      modelStateEvents(events).filter(
        (event) => event.queueItemId === receipt.queueItemId || event.queueItemId === null,
      ),
    ).toEqual([
      {
        type: "model_state",
        threadId: thread.id,
        queueItemId: receipt.queueItemId,
        model: `${baseFaux.getModel().provider}/${baseFaux.getModel().id}`,
      },
      {
        type: "model_state",
        threadId: thread.id,
        queueItemId: receipt.queueItemId,
        model: `anthropic/${HAIKU}`,
      },
      { type: "model_state", threadId: thread.id, queueItemId: null, model: null },
    ]);
    expect(rolePrompt).toMatch(
      /^Base instructions\.\n\nRole-only instructions\.\n{2,3}## Runtime model\n/,
    );
    expect(rolePrompt).toContain(`Active selection: ${HAIKU}`);
    expect(rolePrompt).toContain("Temporary override: role model; expires when this turn ends");

    const followUp = await thread.submitPrompt("plain follow-up", {});
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === followUp.queueItemId,
      ),
    );
    expect(nextRun?.provider).toBe(baseFaux.getModel().provider);
    expect(nextRun?.systemPrompt).toMatch(/^Base instructions\.\n\n## Runtime model\n/);
    expect(nextRun?.systemPrompt).not.toContain("Role-only instructions.");
    expect(nextRun?.systemPrompt).toContain("Temporary override: none");
  });

  it("a generic role model-state failure skips the role provider and restores overlays", async () => {
    const baseFaux = registerFauxProvider({ provider: "active-role-failure-base" });
    const roleFaux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    cleanups.push(() => baseFaux.unregister());
    cleanups.push(() => {
      roleFaux.unregister();
      registerBuiltInApiProviders();
    });
    let roleCalls = 0;
    roleFaux.setResponses([
      () => {
        roleCalls += 1;
        return fauxAssistantMessage("must not run");
      },
    ]);
    let nextRun:
      | { provider: string; systemPrompt: string | undefined }
      | undefined;
    baseFaux.setResponses([
      (context, _options, _state, model) => {
        nextRun = { provider: model.provider, systemPrompt: context.systemPrompt };
        return fauxAssistantMessage("plain follow-up completed");
      },
    ]);
    const role = loadRoleFromMarkdown(`---
name: reviewer
description: Review code
model: ${HAIKU}
---

Role-only instructions.
`);
    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream({
      fenceCheck: (fence) => store.isCurrentAttempt(fence.itemId, fence.attemptId),
    });
    const events: BusEvent[] = [];
    bus.subscribe({}, (event) => events.push(event));
    const append = bus.append.bind(bus);
    let rejected = false;
    vi.spyOn(bus, "append").mockImplementation(async (event, eventKey, fence) => {
      if (
        !rejected &&
        event.event.type === "model_state" &&
        event.event.model === `anthropic/${HAIKU}`
      ) {
        rejected = true;
        throw new Error("role model state unavailable");
      }
      return append(event, eventKey, fence);
    });
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseFaux.getModel(),
      systemPrompt: "Base instructions.",
      roles: [role],
    });
    const thread = await session.ensureDefaultThread();

    const failed = await thread.submitPrompt("review this", { role: "reviewer" });
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === failed.queueItemId,
      ),
    );
    expect(roleCalls).toBe(0);
    expect(modelStateEvents(events)).toEqual([
      {
        type: "model_state",
        threadId: thread.id,
        queueItemId: failed.queueItemId,
        model: `${baseFaux.getModel().provider}/${baseFaux.getModel().id}`,
      },
      { type: "model_state", threadId: thread.id, queueItemId: null, model: null },
    ]);
    expect(await thread.currentModelState()).toBeNull();

    const next = await thread.submitPrompt("plain follow-up", {});
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === next.queueItemId,
      ),
    );
    expect(nextRun?.provider).toBe(baseFaux.getModel().provider);
    expect(nextRun?.systemPrompt).toMatch(/^Base instructions\.\n\n## Runtime model\n/);
    expect(nextRun?.systemPrompt).not.toContain("Role-only instructions.");
    expect(nextRun?.systemPrompt).toContain("Temporary override: none");
  });

  it("rejects a stale role replacement before append and restores overlays", async () => {
    const baseFaux = registerFauxProvider({ provider: "active-role-base" });
    cleanups.push(() => baseFaux.unregister());
    let nextRun:
      | { provider: string; systemPrompt: string | undefined }
      | undefined;
    baseFaux.setResponses([
      (ctx, _opts, _state, model) => {
        nextRun = { provider: model.provider, systemPrompt: ctx.systemPrompt };
        return fauxAssistantMessage("next prompt completed");
      },
    ]);
    const role = loadRoleFromMarkdown(`---
name: reviewer
description: Review code
model: ${HAIKU}
---

Role-only instructions.
`);
    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream({
      fenceCheck: (fence) => store.isCurrentAttempt(fence.itemId, fence.attemptId),
    });
    const events: BusEvent[] = [];
    bus.subscribe({}, (event) => events.push(event));
    const append = bus.append.bind(bus);
    let interceptedRoleState = false;
    vi.spyOn(bus, "append").mockImplementation(async (event, eventKey, fence) => {
      if (
        !interceptedRoleState &&
        event.event.type === "model_state" &&
        event.event.model === `anthropic/${HAIKU}` &&
        fence
      ) {
        interceptedRoleState = true;
        const replaced = await store.replaceSubmissionAttempt(
          event.sessionId,
          event.event.threadId,
          fence.itemId,
          {
            sessionId: event.sessionId,
            threadId: event.event.threadId,
            itemId: fence.itemId,
            attemptId: "att-role-successor",
            ownerId: "role-successor",
          },
          { expectedAttemptId: fence.attemptId },
        );
        expect(replaced).toBeTruthy();
        await store.forceSettle(event.sessionId, fence.itemId, "aborted", "successor settled");
      }
      return append(event, eventKey, fence);
    });
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: baseFaux.getModel(),
      systemPrompt: "Base instructions.",
      roles: [role],
    });
    const thread = await session.ensureDefaultThread();
    const first = await thread.submitPrompt("review this", { role: "reviewer" });
    await waitForCondition(() => interceptedRoleState && !thread.hasActiveRun);

    expect(modelStateEvents(events).filter((event) => event.queueItemId === first.queueItemId)).toEqual([
      {
        type: "model_state",
        threadId: thread.id,
        queueItemId: first.queueItemId,
        model: `${baseFaux.getModel().provider}/${baseFaux.getModel().id}`,
      },
    ]);
    expect(await thread.currentModelState()).toBeNull();

    const second = await thread.submitPrompt("plain follow-up", {});
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.event.type === "submission_settled" &&
          event.event.queueItemId === second.queueItemId,
      ),
    );
    expect(nextRun?.provider).toBe(baseFaux.getModel().provider);
    expect(nextRun?.systemPrompt).toMatch(/^Base instructions\.\n\n## Runtime model\n/);
    expect(nextRun?.systemPrompt).not.toContain("Role-only instructions.");
    expect(nextRun?.systemPrompt).toContain("Temporary override: none");
  });
});

/**
 * Agent-initiated escalation (TKAI-338).
 *
 * Harness note: every faux provider hands back a model whose `.id` is
 * "faux-1", so two fauxes cannot be told apart by wire id. They ARE told
 * apart by spec, via the host `resolveModel` seam plus `modelSpec` — the
 * documented shape for a host whose spec differs from the wire id. That lets
 * a test observe *which model a given LLM call reached* by which faux's
 * queued response fired.
 *
 * Do NOT reach for `registerFauxProvider({ provider: "anthropic", model:
 * "claude-…" })` here: overriding a real registry id does not intercept the
 * stream, and the turn goes to the live Anthropic API.
 */
const CHEAP_SPEC = "escprov-cheap/faux-1";
const STRONG_SPEC = "escprov-strong/faux-1";

describe("engine: agent-initiated model escalation (TKAI-338)", () => {
  interface EscalationSetup {
    engine: Engine;
    store: InMemorySessionStore;
    bus: InMemoryEventStream;
    events: BusEvent[];
    cheapModel: Model<unknown>;
    strongModel: Model<unknown>;
    resolver: (spec: string) => Promise<ResolvedModel | null>;
    cheapCalls: string[];
    strongCalls: string[];
  }

  function setupEscalation(tag: string): EscalationSetup {
    const cheapFaux = registerFauxProvider({ provider: `${tag}-cheap` });
    const strongFaux = registerFauxProvider({ provider: `${tag}-strong` });
    cleanups.push(() => cheapFaux.unregister());
    cleanups.push(() => strongFaux.unregister());

    const cheapModel = cheapFaux.getModel();
    const strongModel = strongFaux.getModel();
    const cheapCalls: string[] = [];
    const strongCalls: string[] = [];

    // Cheap model: the first call escalates. Its second queued response is
    // the one that fires if the switch never lands — so the assertion can
    // tell "escalation applied" from "escalation ignored".
    cheapFaux.setResponses([
      () => {
        cheapCalls.push("escalate");
        return fauxAssistantMessage(
          [fauxToolCall("switch_model", { model: STRONG_SPEC }, { id: "tc-esc" })],
          { stopReason: "toolUse" },
        );
      },
      () => {
        cheapCalls.push("continuation");
        return fauxAssistantMessage("continued on the cheap model");
      },
    ]);
    strongFaux.setResponses([
      () => {
        strongCalls.push("continuation");
        return fauxAssistantMessage("continued on the strong model");
      },
    ]);

    const resolver = async (spec: string): Promise<ResolvedModel | null> => {
      if (spec === CHEAP_SPEC) return { model: cheapModel, apiKey: "k-cheap" };
      if (spec === STRONG_SPEC) return { model: strongModel, apiKey: "k-strong" };
      return null;
    };

    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const sandboxProvider = new VirtualSandboxProvider();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });

    return { engine, store, bus, events, cheapModel, strongModel, resolver, cheapCalls, strongCalls };
  }

  /**
   * Wait for the SUBMISSION to settle, not for `status: "idle"`.
   *
   * `idle` fires at every pi-agent-core `turn_end`, so in a run that makes
   * more than one LLM call it has already fired before the later calls
   * happen. Waiting on it samples the run mid-flight and passes only when
   * the faux happens to finish inside the first poll (trap 2 in the header).
   */
  async function waitForSettled(
    events: BusEvent[],
    timeoutMs = 3000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (events.some((e) => e.event.type === "submission_settled")) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out waiting for submission_settled");
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("waitFor: timed out");
  }

  async function makeSession(s: EscalationSetup) {
    return s.engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: s.cheapModel,
      modelSpec: CHEAP_SPEC,
      resolveModel: s.resolver,
    });
  }

  it("takes effect on the next LLM call of the SAME turn", async () => {
    const s = setupEscalation("esc-applies");
    const session = await makeSession(s);

    const receipt = await session.prompt("do something hard");
    await waitForSettled(s.events);

    // The turn escalated once, then the CONTINUATION reached the strong
    // model — what the tool description and the prompt rules both promise
    // ("switch_model ... in this turn, then continue").
    expect(s.cheapCalls).toEqual(["escalate"]);
    expect(s.strongCalls).toEqual(["continuation"]);
    expect(modelStateEvents(s.events)).toEqual([
      {
        type: "model_state",
        threadId: receipt.threadId,
        queueItemId: receipt.queueItemId,
        model: `${s.cheapModel.provider}/${s.cheapModel.id}`,
      },
      {
        type: "model_state",
        threadId: receipt.threadId,
        queueItemId: receipt.queueItemId,
        model: `${s.strongModel.provider}/${s.strongModel.id}`,
      },
      {
        type: "model_state",
        threadId: receipt.threadId,
        queueItemId: null,
        model: null,
      },
    ]);
  });

  it("rolls back an agent switch when its model-state append fails", async () => {
    const s = setupEscalation("esc-append-fail");
    const append = s.bus.append.bind(s.bus);
    let rejected = false;
    vi.spyOn(s.bus, "append").mockImplementation(async (event, eventKey, fence) => {
      if (
        !rejected &&
        event.event.type === "model_state" &&
        event.event.model === `${s.strongModel.provider}/${s.strongModel.id}`
      ) {
        rejected = true;
        throw new Error("switch model state unavailable");
      }
      return append(event, eventKey, fence);
    });
    const session = await makeSession(s);

    const receipt = await session.prompt("do something hard");
    await waitForSettled(s.events);

    expect(s.cheapCalls).toEqual(["escalate", "continuation"]);
    expect(s.strongCalls).toEqual([]);
    expect(modelStateEvents(s.events)).toEqual([
      {
        type: "model_state",
        threadId: receipt.threadId,
        queueItemId: receipt.queueItemId,
        model: `${s.cheapModel.provider}/${s.cheapModel.id}`,
      },
      {
        type: "model_state",
        threadId: receipt.threadId,
        queueItemId: null,
        model: null,
      },
    ]);
    const entries = await session.readEntries("web:default");
    expect(JSON.stringify(entries)).toContain("switch_model failed: switch model state unavailable");
  });

  it("does not outlive the turn: the thread pin stays on the user's model", async () => {
    const s = setupEscalation("esc-scope");
    const session = await makeSession(s);

    const thread = await session.ensureDefaultThread();
    expect(thread.modelId()).toBe(CHEAP_SPEC);

    const receipt = await session.prompt("do something hard");
    await waitForSettled(s.events);

    // The escalation was turn-scoped: the user's pin is what survives, in
    // memory and on disk. Nothing strands the thread on the strong model.
    expect(thread.modelId()).toBe(CHEAP_SPEC);
    const persisted = await s.store.getThread(session.id, thread.id);
    expect(persisted?.model).toBe(CHEAP_SPEC);
  });

  it("a later turn starts back on the user's model", async () => {
    const s = setupEscalation("esc-next-turn");
    const session = await makeSession(s);

    const first = await session.prompt("do something hard");
    await waitForSettled(s.events);
    expect(s.strongCalls).toEqual(["continuation"]);

    // Second turn: the cheap faux's remaining queued response is what should
    // fire. If the escalation had persisted, the strong faux would run dry
    // and this turn would fail instead.
    const second = await session.prompt("a cheap follow-up");
    await waitFor(() => s.cheapCalls.length === 2);
    expect(second.threadId).toBe(first.threadId);
    expect(s.cheapCalls).toEqual(["escalate", "continuation"]);
    expect(s.strongCalls).toEqual(["continuation"]);
  });

  it("an escalation the resolver rejects leaves the turn on its current model", async () => {
    const s = setupEscalation("esc-reject");
    const session = await s.engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: s.cheapModel,
      modelSpec: CHEAP_SPEC,
      // Only the cheap spec resolves: the escalation target is refused, the
      // way a deleted custom-provider row would refuse it mid-turn.
      resolveModel: async (spec: string): Promise<ResolvedModel | null> =>
        spec === CHEAP_SPEC ? { model: s.cheapModel, apiKey: "k-cheap" } : null,
    });

    const thread = await session.ensureDefaultThread();
    const receipt = await session.prompt("do something hard");
    await waitForSettled(s.events);

    // The tool reported the failure and the turn finished on the model it
    // started with — no half-applied escalation, no wedged turn.
    expect(s.cheapCalls).toEqual(["escalate", "continuation"]);
    expect(s.strongCalls).toEqual([]);
    expect(thread.modelId()).toBe(CHEAP_SPEC);
    const entries = await session.readEntries("web:default");
    const toolResults = JSON.stringify(entries);
    expect(toolResults).toContain("switch_model failed");
  });

  it("a failed escalation still lets the turn gate and settle", async () => {
    // switch_model to a spec the resolver refuses. The tool reports the
    // failure, and the turn goes on to open a decision gate, resume, and
    // settle on the model it started with.
    const cheapFaux = registerFauxProvider({ provider: "esc-gate-cheap" });
    cleanups.push(() => cheapFaux.unregister());
    const cheapModel = cheapFaux.getModel();
    cheapFaux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("switch_model", { model: STRONG_SPEC }, { id: "tc-esc" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "x" }, { id: "tc-gate" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("all done"),
    ]);

    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });

    const gatedTool: ToolDef = {
      name: "do_thing",
      description: "Do a sensitive thing, gated by approval.",
      parameters: Type.Object({ arg: Type.String() }),
      execute: async (args, ctx) => {
        const resolution = await ctx.requestDecision({
          type: "approval",
          title: "approve do_thing?",
          body: `arg=${args.arg}`,
          resumeKey: `do_thing:${args.arg}`,
        });
        return { text: resolution.actionId === "approve" ? "did the thing" : "denied" };
      },
    };

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: cheapModel,
      modelSpec: CHEAP_SPEC,
      tools: [gatedTool],
      // The escalation target never resolves.
      resolveModel: async (spec: string): Promise<ResolvedModel | null> =>
        spec === CHEAP_SPEC ? { model: cheapModel, apiKey: "k-cheap" } : null,
    });

    void session.prompt("do something hard");
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));
    const gateEvent = events.find((e) => e.event.type === "decision_gate")!;
    const gate: DecisionGate = (gateEvent.event as { gate: DecisionGate }).gate;

    await session.resolveDecision(gate.id, {
      actionId: "approve",
      resolvedBy: "u1",
      resolvedAt: Date.now(),
    });
    // Settlement, not `status:idle`: idle already fired for the escalation
    // turn and would match instantly.
    await waitFor(() => events.some((e) => e.event.type === "submission_settled"));

    const entries = await session.readEntries("web:default");
    const messages = entries.filter((e) => e.type === "message");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "all done" });
    expect(await store.listUnsettledSubmissions(session.id)).toEqual([]);
  });

  it("switching BACK to the session's own spec retargets the turn", async () => {
    // The switch-back spec is valid by construction, so validateModelSpec
    // accepts it without resolving and hands back null. That branch still
    // has to apply the model (and refresh the per-turn key, which currently
    // holds the escalated provider's). Reporting success without applying
    // is the defect class this change exists to remove.
    const cheapFaux = registerFauxProvider({ provider: "esc-back-cheap" });
    const strongFaux = registerFauxProvider({ provider: "esc-back-strong" });
    cleanups.push(() => cheapFaux.unregister());
    cleanups.push(() => strongFaux.unregister());
    const cheapModel = cheapFaux.getModel();
    const strongModel = strongFaux.getModel();

    const seq: string[] = [];
    const keys: Array<string | undefined> = [];
    cheapFaux.setResponses([
      (_c, opts) => {
        seq.push("cheap:escalate");
        keys.push(opts?.apiKey);
        return fauxAssistantMessage(
          [fauxToolCall("switch_model", { model: STRONG_SPEC }, { id: "t1" })],
          { stopReason: "toolUse" },
        );
      },
      (_c, opts) => {
        seq.push("cheap:final");
        keys.push(opts?.apiKey);
        return fauxAssistantMessage("back on the cheap model");
      },
    ]);
    strongFaux.setResponses([
      (_c, opts) => {
        seq.push("strong:deescalate");
        keys.push(opts?.apiKey);
        return fauxAssistantMessage(
          [fauxToolCall("switch_model", { model: CHEAP_SPEC }, { id: "t2" })],
          { stopReason: "toolUse" },
        );
      },
    ]);

    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const engine = new Engine({
      providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: cheapModel,
      modelSpec: CHEAP_SPEC,
      resolveModel: async (spec: string): Promise<ResolvedModel | null> => {
        if (spec === CHEAP_SPEC) return { model: cheapModel, apiKey: "k-cheap" };
        if (spec === STRONG_SPEC) return { model: strongModel, apiKey: "k-strong" };
        return null;
      },
    });

    await session.prompt("do something hard, then wind back down");
    await waitForSettled(events);

    expect(seq).toEqual(["cheap:escalate", "strong:deescalate", "cheap:final"]);
    // The key follows the model both ways: reusing the strong provider's key
    // against the cheap provider would 401 in production.
    expect(keys).toEqual(["k-cheap", "k-strong", "k-cheap"]);
  });

  it("model_switched says whether the switch outlives the turn", async () => {
    const s = setupEscalation("esc-scope-field");
    const session = await makeSession(s);
    const thread = await session.ensureDefaultThread();

    await session.prompt("do something hard");
    await waitForSettled(s.events);

    const agentSwitch = s.events.find((e) => e.event.type === "model_switched");
    expect(agentSwitch?.event).toMatchObject({ scope: "turn", toModel: STRONG_SPEC });

    await thread.setModel(STRONG_SPEC, "set_via_api");
    const userSwitch = s.events
      .filter((e) => e.event.type === "model_switched")
      .at(-1);
    expect(userSwitch?.event).toMatchObject({ scope: "thread", toModel: STRONG_SPEC });
  });

  it("a user-initiated switch still persists across turns", async () => {
    const s = setupEscalation("esc-user");
    const session = await makeSession(s);

    const thread = await session.ensureDefaultThread();
    // No `tool:` prefix — this is the PATCH / `/model` path.
    await thread.setModel(STRONG_SPEC, "set_via_api");

    expect(thread.modelId()).toBe(STRONG_SPEC);
    const persisted = await s.store.getThread(session.id, thread.id);
    expect(persisted?.model).toBe(STRONG_SPEC);
  });
});
