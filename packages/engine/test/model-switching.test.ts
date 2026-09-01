/**
 * Model switching: layered resolution + the `switch_model` builtin tool.
 *
 * Strategy: register two fauxes that override the *real* anthropic model
 * ids `claude-haiku-4-5` and `claude-opus-4-7`. That way:
 *   - `resolveModelId("claude-opus-4-7")` returns a Model object (the
 *     real id is in pi-ai's static registry, the faux replaces its
 *     behavior).
 *   - We can drive turns through both without hitting Anthropic.
 *   - We can assert mid-turn switches by seeing which faux's pre-loaded
 *     responses fire.
 */
import { afterEach, describe, it, expect } from "vitest";
import {
  getModel,
  registerFauxProvider,
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

  it("switch_model tool dispatches to ctx.setModel (thread-only)", async () => {
    // Unit-test the tool directly with a stub ToolContext. Driving a full
    // agent loop here is awkward because pi-ai's faux registration
    // doesn't intercept `getModel` lookups, so the second LLM call after
    // a tool tries to hit real Anthropic. The integration that the tool
    // is registered + reachable from the agent runtime is covered
    // implicitly by the rest of this suite — agent.state.tools is built
    // from session.builtinTools, which we asserted contains
    // switchModelTool above.

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
    expect((r1 as { text: string }).text).toContain("thread");

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
