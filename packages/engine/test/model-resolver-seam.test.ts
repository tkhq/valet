/**
 * Host model-resolver seam (Task 1): an optional `resolveModel` on the session
 * options object that lets the host resolve a model spec → `{ model, apiKey }`
 * per turn, delivering a per-turn API key to pi-agent-core via `getApiKey`.
 *
 * Absent resolver === today's behavior byte-for-byte: internal `resolveModelId`,
 * no `getApiKey` passed to the Agent (pi-ai env fallback → StreamOptions.apiKey
 * undefined). Present resolver: turn model + key come from the resolver, freshly
 * per turn (no cross-turn caching), and setModel validates through it.
 *
 * We observe the key the stream actually receives by using a faux-provider
 * response *factory* — it is handed the live `StreamOptions`, so `opts.apiKey`
 * is exactly what pi-agent-core stamped from `getApiKey`.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxProvider,
} from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type ResolvedModel,
} from "../src/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()?.();
    } catch {
      // fauxes are fire-and-forget for tests
    }
  }
});

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, bus, events };
}

function makeFaux(provider: string): FauxProvider {
  const faux = registerFauxProvider({ provider });
  cleanups.push(() => faux.unregister());
  return faux;
}

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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: timed out");
}

describe("host model resolver seam", () => {
  it("absent resolver: turns run exactly as today, Agent gets no getApiKey (apiKey undefined)", async () => {
    const faux = makeFaux("seam-absent");
    const seenKeys: Array<string | undefined> = [];
    faux.setResponses([
      (_ctx, opts) => {
        seenKeys.push(opts?.apiKey);
        return fauxAssistantMessage("ok");
      },
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      // NB: no resolveModel — the byte-identical pin.
    });

    const receipt = await session.prompt("hi");
    await waitForStatus(events, receipt.threadId, "idle");

    // Stream ran, and it received NO api key (env fallback preserved).
    expect(seenKeys).toEqual([undefined]);

    const entries = await session.readEntries("web:default");
    const assistant = entries.find((e) => e.type === "message" && e.role === "assistant");
    expect(assistant).toBeDefined();
  });

  it("present resolver: turn model + apiKey come from the resolver, fresh per turn (no cross-turn caching)", async () => {
    const faux = makeFaux("seam-present");
    const model = faux.getModel();
    const seenKeys: Array<string | undefined> = [];

    const resolver = vi.fn(
      async (_spec: string): Promise<ResolvedModel | null> => ({
        model,
        apiKey: `key-${resolver.mock.calls.length}`,
      }),
    );

    // One factory response per turn; each records the apiKey the stream saw.
    const record = (_ctx: unknown, opts: { apiKey?: string } | undefined) => {
      seenKeys.push(opts?.apiKey);
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([record, record]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: resolver,
    });

    // Await each turn by its own completion (the shared `events` array retains
    // turn one's idle status, so a second waitForStatus would return stale —
    // key on the per-turn stream observation instead).
    await session.prompt("turn one");
    await waitFor(() => seenKeys.length === 1);
    await session.prompt("turn two");
    await waitFor(() => seenKeys.length === 2);

    // Resolver consulted once per turn, always with the model spec string.
    expect(resolver).toHaveBeenCalledTimes(2);
    for (const call of resolver.mock.calls) {
      expect(call[0]).toBe(model.id);
    }

    // The stream saw a distinct key each turn — proof the key is re-resolved
    // per turn and never cached across turns (rotation applies next turn).
    expect(seenKeys).toEqual(["key-1", "key-2"]);
  });

  it("setModel validates through the resolver when present", async () => {
    const faux = makeFaux("seam-setmodel");
    const model = faux.getModel();
    const resolver = vi.fn(
      async (spec: string): Promise<ResolvedModel | null> =>
        spec === "prov_x/m1" ? { model, apiKey: "k" } : null,
    );

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: resolver,
    });

    // Unresolvable → throws the same "unknown model id" surface as today.
    await expect(session.setModel("nope/nope")).rejects.toThrow(/unknown model id/);

    // Resolvable → succeeds and persists the string.
    await session.setModel("prov_x/m1");
    const persisted = await store.getSession(session.id);
    expect(persisted?.model).toBe(model.id);

    // Thread.setModel also validates through the resolver.
    const thread = await session.ensureDefaultThread();
    await expect(thread.setModel("nope/nope")).rejects.toThrow(/unknown model id/);
    const okThread = await thread.setModel("prov_x/m1");
    expect(okThread.toModel).toBe("prov_x/m1");
  });

  it("credential-less turns release back to queued, then settle `failed` with a visible error at the cap (no forever-spin / entry leak)", async () => {
    const faux = makeFaux("seam-nocreds");
    const model = faux.getModel();
    // Every turn ends in an agent error (a keyless provider surfaces as
    // stopReason:"error"); the resolver yields NO apiKey, so each run is
    // credential-less and hits the release path.
    faux.setResponses(
      Array.from({ length: 8 }, () => fauxAssistantMessage("boom", { stopReason: "error" })),
    );

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => ({ model, apiKey: undefined }),
    });
    const thread = session.thread();

    const r = await session.prompt("go");
    // Drive claim cycles directly (no real 5s sweep). Each credential-less cycle
    // releases the head back to `queued` until the cap, then settles it `failed`.
    for (let i = 0; i < 8; i++) {
      await thread.kick();
      if ((await store.getQueueItem(session.id, r.queueItemId))?.status === "settled") break;
    }

    const item = await store.getQueueItem(session.id, r.queueItemId);
    expect(item?.status).toBe("settled");
    expect(item?.outcome?.outcome).toBe("failed");
    expect(item?.outcome?.error).toMatch(/no usable API key/i);
    // The release cap bounds retries, so it settles at attemptCount === 3.
    expect(item?.attemptCount).toBe(3);

    // Bounded error-entry growth: at most one assistant entry per claim cycle,
    // capped by MAX_CREDENTIAL_RELEASES (3) — not an unbounded leak.
    const entries = await store.getEntries(session.id, thread.id);
    const assistantEntries = entries.filter((e) => e.type === "message" && e.role === "assistant");
    expect(assistantEntries.length).toBeLessThanOrEqual(3);
  });
});
