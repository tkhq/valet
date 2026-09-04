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
import { afterEach, describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getModel,
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
  VirtualSandboxProvider,
  type BusEvent,
  type DecisionGate,
  type ResolvedModel,
  type ToolDef,
} from "../src/index.js";
import { switchModelTool } from "../src/builtin-tools/index.js";

const builtinToolNames = builtinTools.map((t) => t.name);

const HAIKU = "claude-haiku-4-5";
const OPUS = "claude-opus-4-7";

interface SetupResult {
  haikuFaux: FauxProvider;
  opusFaux: FauxProvider;
  engine: Engine;
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
  return { haikuFaux, opusFaux, engine, store, events, baseModel };
}

describe("engine: model switching", () => {
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
    events: BusEvent[];
    cheapModel: Model<unknown>;
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

    return { engine, store, events, cheapModel, resolver, cheapCalls, strongCalls };
  }

  async function waitForStatus(
    events: BusEvent[],
    threadId: string,
    status: string,
    timeoutMs = 3000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = events.some(
        (e) =>
          e.event.type === "status" &&
          e.event.threadId === threadId &&
          e.event.status === status,
      );
      if (found) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for status=${status}`);
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
    await waitForStatus(s.events, receipt.threadId, "idle");

    // The turn escalated once, then the CONTINUATION reached the strong
    // model — what the tool description and the prompt rules both promise
    // ("switch_model ... in this turn, then continue").
    expect(s.cheapCalls).toEqual(["escalate"]);
    expect(s.strongCalls).toEqual(["continuation"]);
  });

  it("does not outlive the turn: the thread pin stays on the user's model", async () => {
    const s = setupEscalation("esc-scope");
    const session = await makeSession(s);

    const thread = await session.ensureDefaultThread();
    expect(thread.modelId()).toBe(CHEAP_SPEC);

    const receipt = await session.prompt("do something hard");
    await waitForStatus(s.events, receipt.threadId, "idle");

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
    await waitForStatus(s.events, first.threadId, "idle");
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
    await waitForStatus(s.events, receipt.threadId, "idle");

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
