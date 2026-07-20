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
  NoCredentialsError,
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

  it("credential-less turns (resolver throws NoCredentialsError) release back to queued, then settle `failed` with the HOST's message at the cap — zero entries appended", async () => {
    const faux = makeFaux("seam-nocreds");
    const model = faux.getModel();
    // The turn is detected as credential-less BEFORE any LLM call, so no faux
    // response is ever consumed — none are configured.

    const hostMessage = 'no usable API key for model "seam-nocreds-model" — configure an org LLM key';
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => {
        throw new NoCredentialsError(hostMessage, model);
      },
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
    // The settled error is the HOST's own message — never a fabricated one.
    expect(item?.outcome?.error).toBe(hostMessage);
    // 2 releases + 1 terminal attempt (MAX_CREDENTIAL_ATTEMPTS = 3).
    expect(item?.attemptCount).toBe(3);

    // Pre-run detection: a turn that never ran appends NOTHING — no duplicate
    // user entries, no assistant error entries, across all attempts.
    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "message" && e.role === "user")).toHaveLength(0);
    expect(entries.filter((e) => e.type === "message" && e.role === "assistant")).toHaveLength(0);
  });

  it("a key appearing mid-retry recovers: exactly ONE user entry and ZERO assistant error entries across all attempts", async () => {
    const faux = makeFaux("seam-recover");
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage("ok")]);

    let calls = 0;
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => {
        calls += 1;
        if (calls <= 2) throw new NoCredentialsError("no key yet", model);
        return { model, apiKey: "fresh-key" };
      },
    });
    const thread = session.thread();

    const r = await session.prompt("go");
    for (let i = 0; i < 8; i++) {
      await thread.kick();
      if ((await store.getQueueItem(session.id, r.queueItemId))?.status === "settled") break;
    }

    const item = await store.getQueueItem(session.id, r.queueItemId);
    expect(item?.status).toBe("settled");
    expect(item?.outcome?.outcome).toBe("completed");

    // The duplicate-entry residual is fixed: the two keyless attempts appended
    // nothing; only the successful run appended the user entry (once) and its
    // normal assistant message.
    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "message" && e.role === "user")).toHaveLength(1);
    const assistants = entries.filter((e) => e.type === "message" && e.role === "assistant");
    expect(assistants).toHaveLength(1);
  });

  it("a real (non-credential) turn error on a resolver session settles `failed` on the FIRST attempt with the real error", async () => {
    const faux = makeFaux("seam-realerr");
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage("boom", { stopReason: "error" })]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      // Resolver succeeds WITH a key — the error comes from the provider.
      resolveModel: async (): Promise<ResolvedModel | null> => ({ model, apiKey: "real-key" }),
    });
    const thread = session.thread();

    const r = await session.prompt("go");
    for (let i = 0; i < 4; i++) {
      await thread.kick();
      if ((await store.getQueueItem(session.id, r.queueItemId))?.status === "settled") break;
    }

    // Never misclassified as credential-less: no release cycles, one attempt,
    // settled `failed` with the provider's own error surface.
    const item = await store.getQueueItem(session.id, r.queueItemId);
    expect(item?.status).toBe("settled");
    expect(item?.outcome?.outcome).toBe("failed");
    expect(item?.attemptCount).toBe(1);
  });

  it("a steer superseding a keyless running item settles it `superseded` — never orphaned back to queued", async () => {
    const faux = makeFaux("seam-supersede");
    const model = faux.getModel();

    // First resolution parks until the steer has landed, then reports
    // keylessness — modelling "supersede arrives while the claim is live".
    let releaseFirst: (() => void) | undefined;
    const firstParked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => {
        calls += 1;
        if (calls === 1) await firstParked;
        throw new NoCredentialsError("no key", model);
      },
    });
    const thread = session.thread();

    const r1 = await session.prompt("one");
    // Wait until the first item's claim is live (resolver parked inside it).
    await waitFor(() => calls === 1);

    // Steer: supersedes the running item durably, then unpark the resolver.
    const r2 = await thread.submitPrompt("two", { queueMode: "steer" });
    releaseFirst?.();

    for (let i = 0; i < 4; i++) {
      await thread.kick();
      if ((await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled") break;
    }

    const one = await store.getQueueItem(session.id, r1.queueItemId);
    expect(one?.status).toBe("settled");
    expect(one?.outcome?.outcome).toBe("superseded");

    // The steer item is still live (queued/running — itself keyless), not lost.
    const two = await store.getQueueItem(session.id, r2.queueItemId);
    expect(two?.status).not.toBe("settled");
  });

  it("TOCTOU: a supersession stamped between the thread's snapshot and the release CAS settles `superseded`, never orphaned queued", async () => {
    const faux = makeFaux("seam-toctou");
    const model = faux.getModel();

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => {
        throw new NoCredentialsError("no key", model);
      },
    });
    const thread = session.thread();

    // Interpose on the store seam: by the time the thread calls
    // releaseSubmission it has ALREADY taken its getQueueItem snapshot (which
    // saw no supersession). Stamping the supersession here — before
    // delegating to the real CAS — is exactly the TOCTOU window: the stamp
    // lands after the check, before the commit. The CAS must refuse and the
    // thread must settle the item `superseded` itself.
    const realRelease = store.releaseSubmission.bind(store);
    let steerStamped = false;
    const steerId = "q-toctou-steer";
    vi.spyOn(store, "releaseSubmission").mockImplementation(
      async (sessionId, threadId, itemId, fence) => {
        if (!steerStamped) {
          steerStamped = true;
          const now = Date.now();
          await store.admitSubmission(
            sessionId,
            threadId,
            {
              id: steerId,
              threadId,
              content: "steer",
              status: "queued",
              attemptCount: 0,
              maxAttempts: 10,
              timeoutAt: now + 3_600_000,
              createdAt: now,
              updatedAt: now,
            },
            { steer: true },
          );
        }
        return realRelease(sessionId, threadId, itemId, fence);
      },
    );

    const r = await session.prompt("go");
    for (let i = 0; i < 4; i++) {
      await thread.kick();
      if ((await store.getQueueItem(session.id, r.queueItemId))?.status === "settled") break;
    }

    const one = await store.getQueueItem(session.id, r.queueItemId);
    expect(steerStamped).toBe(true);
    // Settled `superseded` on the SAME attempt — never released back to
    // `queued` with the supersession stamp set (the orphan that hangs
    // awaitResult forever).
    expect(one?.status).toBe("settled");
    expect(one?.outcome?.outcome).toBe("superseded");
  });

  it("a lease recycle (store attemptCount bump) does not burn the credential budget", async () => {
    const faux = makeFaux("seam-lease");
    const model = faux.getModel();

    const hostMessage = "no key anywhere";
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => {
        throw new NoCredentialsError(hostMessage, model);
      },
    });
    const thread = session.thread();

    // Admit directly at the store (no kick yet), then burn TWO store-level
    // attempts the way lease-expiry reconciliation would — claim + release —
    // before the thread ever sees the item.
    const itemId = "q-lease-recycle";
    await store.admitSubmission(session.id, thread.id, {
      id: itemId,
      threadId: thread.id,
      content: "hello",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    for (const att of ["att-pre-1", "att-pre-2"]) {
      await store.claimSubmission({
        sessionId: session.id,
        threadId: thread.id,
        itemId,
        attemptId: att,
        ownerId: "sweeper",
      });
      await store.insertAttemptMarker(itemId, att);
      await store.releaseSubmission(session.id, thread.id, itemId, { itemId, attemptId: att });
    }
    expect((await store.getQueueItem(session.id, itemId))?.attemptCount).toBe(2);

    // The thread's credential budget is its own (Thread-local map, keyed by
    // itemId) — the pre-burned store attempts must not count against it, so
    // the item still gets the full MAX_CREDENTIAL_ATTEMPTS (3) credential
    // attempts: settled on store attempt 2 + 3 = 5, not at 3.
    for (let i = 0; i < 8; i++) {
      await thread.kick();
      if ((await store.getQueueItem(session.id, itemId))?.status === "settled") break;
    }
    const item = await store.getQueueItem(session.id, itemId);
    expect(item?.status).toBe("settled");
    expect(item?.outcome?.outcome).toBe("failed");
    expect(item?.outcome?.error).toBe(hostMessage);
    expect(item?.attemptCount).toBe(5);
  });
});
