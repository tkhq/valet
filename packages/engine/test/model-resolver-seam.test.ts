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
  fauxToolCall,
  registerFauxProvider,
  Type,
  type FauxProvider,
} from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  NoCredentialsError,
  VirtualSandboxProvider,
  type BusEvent,
  type DecisionGate,
  type MessageEntry,
  type ResolvedModel,
  type ToolDef,
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

/** Async-predicate variant of waitFor, for polling store state. */
async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitForAsync: timed out");
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
      // Make every driven kick a counted credential cycle (the default 4s
      // backoff would coalesce this test's rapid kicks into one cycle).
      credentialReleaseBackoffMs: 0,
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
    // 2 releases + 1 terminal attempt (MAX_CREDENTIAL_ATTEMPTS = 3) — each
    // release hands its claim's attempt_count increment back (a released
    // claim never consumed run budget), so only the terminal claim remains.
    expect(item?.attemptCount).toBe(1);

    // Pre-run credential attempts append NOTHING; the CAP attempt appends
    // exactly the user entry (the transcript must record what was asked when
    // the failure surfaces) and never an assistant error entry.
    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "message" && e.role === "user")).toHaveLength(1);
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
      credentialReleaseBackoffMs: 0,
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
      credentialReleaseBackoffMs: 0,
    });
    const thread = session.thread();

    // Admit directly at the store (no kick yet), then burn store-level
    // attempts the way lease-expiry reconciliation would — one claim plus
    // TWO replaceSubmissionAttempt recycles (which increment attempt_count
    // and are deliberately NOT handed back by a release) — before the thread
    // ever sees the item.
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
    await store.claimSubmission({
      sessionId: session.id,
      threadId: thread.id,
      itemId,
      attemptId: "att-pre-1",
      ownerId: "sweeper",
    });
    let prevAtt = "att-pre-1";
    for (const att of ["att-pre-2", "att-pre-3"]) {
      const replaced = await store.replaceSubmissionAttempt(
        session.id,
        thread.id,
        itemId,
        { sessionId: session.id, threadId: thread.id, itemId, attemptId: att, ownerId: "sweeper" },
        { expectedAttemptId: prevAtt },
      );
      expect(replaced).not.toBeNull();
      prevAtt = att;
    }
    // claim(1) + two recycles(3); the credential-less release hands ONE
    // claim increment back → 2. (replaceSubmissionAttempt increments are
    // unaffected by the release-decrement rule.)
    await store.releaseSubmission(session.id, thread.id, itemId, {
      itemId,
      attemptId: prevAtt,
    });
    expect((await store.getQueueItem(session.id, itemId))?.attemptCount).toBe(2);

    // The credential budget is the DURABLE per-item counter — untouched by
    // the pre-burned recycles (their release carried no credential arg), so
    // the item still gets the full MAX_CREDENTIAL_ATTEMPTS (3) credential
    // cycles: 2 net-zero claim/release pairs + the terminal cap claim on top
    // of the 2 surviving pre-burn increments.
    for (let i = 0; i < 8; i++) {
      await thread.kick();
      if ((await store.getQueueItem(session.id, itemId))?.status === "settled") break;
    }
    const item = await store.getQueueItem(session.id, itemId);
    expect(item?.status).toBe("settled");
    expect(item?.outcome?.outcome).toBe("failed");
    expect(item?.outcome?.error).toBe(hostMessage);
    expect(item?.attemptCount).toBe(3);
  });

  it("a burst of external kicks inside the backoff window counts as ONE credential cycle — never caps the item", async () => {
    const faux = makeFaux("seam-burst");
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
      // Deliberately DEFAULT backoff — the pin is that rapid kicks (each
      // submit/resume/abort fires one unconditionally) coalesce into a single
      // counted cycle instead of burning the budget in milliseconds.
    });
    const thread = session.thread();

    const r = await session.prompt("go");
    for (let i = 0; i < 8; i++) {
      await thread.kick();
    }

    // Eight rapid kicks: without the backoff window this caps and settles
    // `failed` well before the 4th kick (see the cap test). With it, the
    // burst is one cycle — the item is still released `queued`, waiting for
    // a key.
    const item = await store.getQueueItem(session.id, r.queueItemId);
    expect(item?.status).toBe("queued");
  });

  it("a prior turn's aborted stopReason never decides a later capped keyless submission — it settles failed with the host message", async () => {
    const faux = makeFaux("seam-staleabort");
    const model = faux.getModel();
    // Turn one's stream ends `aborted` — its trailing assistant message stays
    // in agent.state across turns.
    faux.setResponses([fauxAssistantMessage("stopped", { stopReason: "aborted" })]);

    const hostMessage = "no key for turn two";
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
        if (calls === 1) return { model, apiKey: "k" };
        throw new NoCredentialsError(hostMessage, model);
      },
      credentialReleaseBackoffMs: 0,
    });
    const thread = session.thread();

    const r1 = await session.prompt("one");
    await waitForAsync(
      async () => (await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled",
    );
    expect((await store.getQueueItem(session.id, r1.queueItemId))?.outcome?.outcome).toBe(
      "aborted",
    );

    // Submission two is keyless and caps. Its own turn appended no assistant
    // message, so the trailing `aborted` message in agent.state is turn ONE's
    // — it must not decide this item's outcome (that would discard the
    // credentials error and mislabel the failure `aborted`).
    const r2 = await session.prompt("two");
    for (let i = 0; i < 8; i++) {
      await thread.kick();
      if ((await store.getQueueItem(session.id, r2.queueItemId))?.status === "settled") break;
    }
    const two = await store.getQueueItem(session.id, r2.queueItemId);
    expect(two?.status).toBe("settled");
    expect(two?.outcome?.outcome).toBe("failed");
    expect(two?.outcome?.error).toBe(hostMessage);
  });

  it("restart wakeup: a released keyless item is re-driven by restoreSession itself and completes once a key exists", async () => {
    const faux = makeFaux("seam-restart");
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage("done after restart")]);

    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const sandboxProvider = new VirtualSandboxProvider();
    let hasKey = false;
    const options = {
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => {
        if (!hasKey) throw new NoCredentialsError("no key", model);
        return { model, apiKey: "k" };
      },
      credentialReleaseBackoffMs: 0,
    };

    const engineA = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const sessionA = await engineA.createSession(options);
    const r = await sessionA.prompt("go");
    await sessionA.thread().kick();
    // Released back to `queued` with NO attempt id — the restart window in
    // which reconciliation's resume path short-circuits.
    const released = await store.getQueueItem(sessionA.id, r.queueItemId);
    expect(released?.status).toBe("queued");
    expect(released?.attemptId).toBeUndefined();
    // Silence engine A entirely so only the restore-side wakeup can drive it.
    sessionA.suspendTimers();

    hasKey = true;
    const engineB = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    await engineB.restoreSession({ sessionId: sessionA.id, options });

    // NO external prompt, kick, or sweep: restore's own queued-head wakeup
    // must claim and complete the item.
    await waitForAsync(
      async () => (await store.getQueueItem(sessionA.id, r.queueItemId))?.status === "settled",
    );
    const item = await store.getQueueItem(sessionA.id, r.queueItemId);
    expect(item?.outcome?.outcome).toBe("completed");
  });

  it("gate replay after restart runs the continuation on the resolver's CURRENT model, not the stale restore-time model", async () => {
    // Scenario: setModel to Y while the turn is suspended on a gate; the
    // engine restarts; the gate was resolved while down. The replayed
    // continuation must run on Y (what the resolver returns NOW), not the
    // stale restore-time model X.
    const fauxX = makeFaux("seam-resume-x");
    const fauxY = makeFaux("seam-resume-y");
    const modelX = fauxX.getModel();
    const modelY = fauxY.getModel();
    fauxX.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "a" }, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
      // Must NOT be consumed after the restart — the continuation belongs on Y.
      fauxAssistantMessage("on-X"),
    ]);
    fauxY.setResponses([fauxAssistantMessage("on-Y")]);

    const gateTool: ToolDef = {
      name: "do_thing",
      description: "gated thing",
      parameters: Type.Object({ arg: Type.String() }),
      execute: async (args, ctx) => {
        const resolution = await ctx.requestDecision({
          type: "approval",
          title: "approve?",
          body: `arg=${String(args.arg)}`,
          resumeKey: `do_thing:${String(args.arg)}`,
        });
        return { text: resolution.actionId };
      },
    };

    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const sandboxProvider = new VirtualSandboxProvider();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));

    const engineA = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const sessionA = await engineA.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: modelX,
      tools: [gateTool],
      resolveModel: async (): Promise<ResolvedModel | null> => ({ model: modelX, apiKey: "k" }),
    });
    void sessionA.prompt("do the thing");
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));
    const gateEvent = events.find((e) => e.event.type === "decision_gate");
    const gate = (gateEvent?.event as { gate: DecisionGate }).gate;
    // Let the blocked/suspended writes land durably before "crashing".
    await waitForAsync(
      async () =>
        (await store.getQueueItem(sessionA.id, gate.queueItemId))?.status ===
        "blocked_on_decision_gate",
    );
    sessionA.suspendTimers();

    // The gate is resolved DURABLY while this node is "down" — both the gate
    // row and the DAG's decision_gate entry (the replay path reads the
    // resolution from the entry), mirroring resolveDecision's durable writes.
    const resolution = { actionId: "approve", resolvedBy: "u1", resolvedAt: Date.now() };
    await store.saveDecisionGate(sessionA.id, gate.threadId, {
      ...gate,
      status: "resolved",
      resolution,
      updatedAt: Date.now(),
    });
    const gateEntries = await store.getEntries(sessionA.id, gate.threadId);
    const gateEntry = gateEntries.find((e) => e.type === "decision_gate" && e.gate.id === gate.id);
    expect(gateEntry?.type).toBe("decision_gate");
    if (gateEntry?.type === "decision_gate") {
      gateEntry.resolution = resolution;
      gateEntry.gate = { ...gateEntry.gate, status: "resolved", resolution };
      await store.updateEntry(sessionA.id, gate.threadId, gateEntry);
    }

    // Restart: the resolver is now keyless and resolves the thread's spec to
    // model Y (as a setModel-while-keyless would).
    const engineB = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    await engineB.restoreSession({
      sessionId: sessionA.id,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: modelX,
        tools: [gateTool],
        // The resolver now resolves the spec to Y WITH a key (the
        // keyless-resume policy is pinned separately below: it fails loudly).
        resolveModel: async (): Promise<ResolvedModel | null> => ({ model: modelY, apiKey: "k" }),
      },
    });

    await waitForAsync(
      async () => (await store.getQueueItem(sessionA.id, gate.queueItemId))?.status === "settled",
      4000,
    );
    const entries = await store.getEntries(sessionA.id, gate.threadId);
    const assistants = entries.filter((e) => e.type === "message" && e.role === "assistant");
    const lastAssistant = assistants[assistants.length - 1];
    // The continuation streamed on Y — proof the resume re-resolved and
    // stamped the resolver's model instead of silently continuing on stale X.
    expect(lastAssistant?.content).toBe("on-Y");
  });

  it("a KEYLESS gate replay settles failed — never silently continues on pi-ai's ambient env fallback", async () => {
    const fauxX = makeFaux("seam-resume-keyless");
    const modelX = fauxX.getModel();
    fauxX.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "a" }, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
      // Must NOT be consumed: a keyless resume has no authorized credential —
      // continuing here would mean pi-ai fell back to ambient env auth the
      // org never granted.
      fauxAssistantMessage("ambient continuation"),
    ]);

    const gateTool: ToolDef = {
      name: "do_thing",
      description: "gated thing",
      parameters: Type.Object({ arg: Type.String() }),
      execute: async (args, ctx) => {
        const resolution = await ctx.requestDecision({
          type: "approval",
          title: "approve?",
          body: `arg=${String(args.arg)}`,
          resumeKey: `do_thing:${String(args.arg)}`,
        });
        return { text: resolution.actionId };
      },
    };

    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const sandboxProvider = new VirtualSandboxProvider();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));

    const engineA = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const sessionA = await engineA.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: modelX,
      tools: [gateTool],
      resolveModel: async (): Promise<ResolvedModel | null> => ({ model: modelX, apiKey: "k" }),
    });
    void sessionA.prompt("do the thing");
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));
    const gateEvent = events.find((e) => e.event.type === "decision_gate");
    const gate = (gateEvent?.event as { gate: DecisionGate }).gate;
    await waitForAsync(
      async () =>
        (await store.getQueueItem(sessionA.id, gate.queueItemId))?.status ===
        "blocked_on_decision_gate",
    );
    sessionA.suspendTimers();

    const resolution = { actionId: "approve", resolvedBy: "u1", resolvedAt: Date.now() };
    await store.saveDecisionGate(sessionA.id, gate.threadId, {
      ...gate,
      status: "resolved",
      resolution,
      updatedAt: Date.now(),
    });
    const gateEntries = await store.getEntries(sessionA.id, gate.threadId);
    const gateEntry = gateEntries.find((e) => e.type === "decision_gate" && e.gate.id === gate.id);
    if (gateEntry?.type === "decision_gate") {
      gateEntry.resolution = resolution;
      gateEntry.gate = { ...gateEntry.gate, status: "resolved", resolution };
      await store.updateEntry(sessionA.id, gate.threadId, gateEntry);
    }

    const engineB = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    await engineB.restoreSession({
      sessionId: sessionA.id,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: modelX,
        tools: [gateTool],
        resolveModel: async (): Promise<ResolvedModel | null> => {
          throw new NoCredentialsError("no key anywhere for resume", modelX);
        },
      },
    });

    await waitForAsync(
      async () => (await store.getQueueItem(sessionA.id, gate.queueItemId))?.status === "settled",
      4000,
    );
    const item = await store.getQueueItem(sessionA.id, gate.queueItemId);
    // Fails loudly with the credential message — never a silent completion
    // on unauthorized ambient credentials.
    expect(item?.outcome?.outcome).toBe("failed");
    expect(item?.outcome?.error).toContain("no key anywhere for resume");
    const entries = await store.getEntries(sessionA.id, gate.threadId);
    const assistants = entries.filter((e) => e.type === "message" && e.role === "assistant");
    expect(assistants.some((e) => e.content === "ambient continuation")).toBe(false);
  });

  it("the credential budget is DURABLE: attempts burned before a restart still count toward the cap after restore", async () => {
    const faux = makeFaux("seam-durable-budget");
    const model = faux.getModel();

    const hostMessage = "no key, durable budget";
    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const sandboxProvider = new VirtualSandboxProvider();
    const options = {
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => {
        throw new NoCredentialsError(hostMessage, model);
      },
      credentialReleaseBackoffMs: 0,
    };

    const engineA = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const sessionA = await engineA.createSession(options);
    const threadA = sessionA.thread();
    const r = await sessionA.prompt("go");
    // Burn exactly TWO counted cycles under engine A (cap is 3).
    for (let i = 0; i < 8; i++) {
      if (((await store.getQueueItem(sessionA.id, r.queueItemId))?.credentialAttempts ?? 0) >= 2) {
        break;
      }
      await threadA.kick();
    }
    const burned = await store.getQueueItem(sessionA.id, r.queueItemId);
    expect(burned?.status).toBe("queued");
    expect(burned?.credentialAttempts).toBe(2);
    sessionA.suspendTimers();

    // "Crash-loop" restart, STILL keyless: the restore wakeup kick is cycle
    // 3 — the durable budget caps and the item settles failed. (Were the
    // budget in-memory, the restore would just release again and the item
    // would cycle queued→running→queued forever.)
    const engineB = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    await engineB.restoreSession({ sessionId: sessionA.id, options });

    await waitForAsync(
      async () => (await store.getQueueItem(sessionA.id, r.queueItemId))?.status === "settled",
    );
    const item = await store.getQueueItem(sessionA.id, r.queueItemId);
    expect(item?.outcome?.outcome).toBe("failed");
    expect(item?.outcome?.error).toBe(hostMessage);
  });

  it("a stream failure that yields an error-stop message settles failed with the real error", async () => {
    const faux = makeFaux("seam-pretoken");
    const model = faux.getModel();
    // The response factory throws; pi-agent-core surfaces it as an
    // error-stop assistant message.
    faux.setResponses([
      () => {
        throw new Error("boom before first token");
      },
    ]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => ({ model, apiKey: "k" }),
    });

    const r = await session.prompt("go");
    await waitForAsync(
      async () => (await store.getQueueItem(session.id, r.queueItemId))?.status === "settled",
    );
    const item = await store.getQueueItem(session.id, r.queueItemId);
    expect(item?.outcome?.outcome).toBe("failed");
    expect(item?.outcome?.error).toContain("boom before first token");
    expect(item?.attemptCount).toBe(1);
  });

  it("an agent-run REJECTION before any message_start settles failed — never completed off a stale clean transcript", async () => {
    const faux = makeFaux("seam-preject");
    const model = faux.getModel();
    // Turn ONE completes cleanly, leaving a trailing stop-reason "stop"
    // assistant message in agent.state (the stale transcript a later broken
    // turn must not inherit as `completed`).
    faux.setResponses([fauxAssistantMessage("first turn ok")]);

    // Turn TWO's resolver hands back a model whose provider is not
    // registered: the agent run REJECTS before producing any message —
    // no message_start, no assistant message for that turn.
    const broken = { ...model, provider: "seam-preject-unregistered" };
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
        return { model: calls === 1 ? model : broken, apiKey: "k" };
      },
    });

    const r1 = await session.prompt("one");
    await waitForAsync(
      async () => (await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled",
    );
    expect((await store.getQueueItem(session.id, r1.queueItemId))?.outcome?.outcome).toBe(
      "completed",
    );

    const r2 = await session.prompt("two");
    await waitForAsync(
      async () => (await store.getQueueItem(session.id, r2.queueItemId))?.status === "settled",
    );
    const two = await store.getQueueItem(session.id, r2.queueItemId);
    // The failure is detected independently of the transcript: turn two has
    // no assistant message of its own, and the trailing clean stop from turn
    // one must not decide `completed`.
    expect(two?.outcome?.outcome).toBe("failed");
    expect(two?.outcome?.error).toBeTruthy();
  });

  it("a store failure while persisting the assistant entry settles failed — never completed off the in-memory clean stop", async () => {
    // The one reachable "runAgent throws" shape: pi-agent-core converts
    // provider/stream failures into error-stop assistant messages, but a
    // throw from OUR emit handler (e.g. the fenced message_end append)
    // propagates out of the agent loop. The message then exists in
    // agent.state with a clean stop — settling by transcript would report
    // `completed` for a turn whose assistant entry was never persisted.
    const faux = makeFaux("seam-appendfail");
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage("looks clean")]);

    const { engine, store } = makeEngine();
    const realAppend = store.appendEntries.bind(store);
    let blew = false;
    vi.spyOn(store, "appendEntries").mockImplementation(async (sid, tid, entries, fence) => {
      if (!blew && entries.some((e) => e.type === "message" && e.role === "assistant")) {
        blew = true;
        throw new Error("append blew up");
      }
      return realAppend(sid, tid, entries, fence);
    });

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => ({ model, apiKey: "k" }),
    });

    const r = await session.prompt("go");
    await waitForAsync(
      async () => (await store.getQueueItem(session.id, r.queueItemId))?.status === "settled",
    );
    const item = await store.getQueueItem(session.id, r.queueItemId);
    expect(blew).toBe(true);
    expect(item?.outcome?.outcome).toBe("failed");
    expect(item?.outcome?.error).toContain("append blew up");
  });

  it("a non-credential resolver throw (e.g. disabled provider) settles failed WITH the user entry preserved", async () => {
    const faux = makeFaux("seam-disabled");
    const model = faux.getModel();

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => {
        throw new Error("provider acme is disabled");
      },
    });
    const thread = session.thread();

    const r = await session.prompt("please do the thing");
    await waitForAsync(
      async () => (await store.getQueueItem(session.id, r.queueItemId))?.status === "settled",
    );
    const item = await store.getQueueItem(session.id, r.queueItemId);
    // Identical failure surface (no release cycles — this is not a
    // credential problem), settled on the first attempt…
    expect(item?.outcome?.outcome).toBe("failed");
    expect(item?.outcome?.error).toContain("provider acme is disabled");
    expect(item?.attemptCount).toBe(1);
    // …but the prompt is still recorded in the transcript.
    const entries = await store.getEntries(session.id, thread.id);
    const users = entries.filter((e) => e.type === "message" && e.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.type === "message" ? users[0].content : "").toBe("please do the thing");
  });

  it("reconciliation RE-RUNS (not resumes) a running item whose attempt never appended its user entry", async () => {
    const faux = makeFaux("seam-rerun");
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage("fresh run")]);

    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const sandboxProvider = new VirtualSandboxProvider();
    const options = {
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => ({ model, apiKey: "k" }),
    };
    const engineA = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const sessionA = await engineA.createSession(options);
    const thread = sessionA.thread();
    sessionA.suspendTimers();

    // Craft the crash shape directly: a claimed (running) item whose attempt
    // died before appending ANY entry — e.g. a store throw inside the
    // credential-release path. Resuming it would continue the (empty /
    // previous) transcript and the prompt would never run.
    const itemId = "q-rerun-no-entry";
    await store.admitSubmission(sessionA.id, thread.id, {
      id: itemId,
      threadId: thread.id,
      content: "run me from scratch",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await store.claimSubmission({
      sessionId: sessionA.id,
      threadId: thread.id,
      itemId,
      attemptId: "att-dead",
      ownerId: "crashed-owner",
    });
    await store.insertAttemptMarker(itemId, "att-dead");

    // Restart: reconciliation must route this to a fresh from-scratch run.
    const engineB = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    await engineB.restoreSession({ sessionId: sessionA.id, options });

    await waitForAsync(
      async () => (await store.getQueueItem(sessionA.id, itemId))?.status === "settled",
    );
    const item = await store.getQueueItem(sessionA.id, itemId);
    expect(item?.outcome?.outcome).toBe("completed");
    // The fresh run recorded the prompt and produced the assistant reply —
    // a resume would have replayed a transcript with NO user entry.
    const entries = await store.getEntries(sessionA.id, thread.id);
    expect(
      entries.filter((e) => e.type === "message" && e.role === "user" && e.queueItemId === itemId),
    ).toHaveLength(1);
    const assistants = entries.filter((e) => e.type === "message" && e.role === "assistant");
    expect(assistants.some((e) => e.content === "fresh run")).toBe(true);
  });

  it("reconciliation re-runs a crashed running item that HAS its user entry but no assistant entry — without duplicating the entry", async () => {
    // The settle-cap crash shape: appendUserEntry landed, then the settle
    // threw and the process died. The reconcile guard keys on "no ASSISTANT
    // entry" (not "no user entry"), so this still re-runs from scratch; the
    // idempotent append means the re-run does not duplicate the prompt.
    const faux = makeFaux("seam-rerun-with-entry");
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage("fresh run after crash")]);

    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const sandboxProvider = new VirtualSandboxProvider();
    const options = {
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (): Promise<ResolvedModel | null> => ({ model, apiKey: "k" }),
    };
    const engineA = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const sessionA = await engineA.createSession(options);
    const thread = sessionA.thread();
    sessionA.suspendTimers();

    const itemId = "q-rerun-with-entry";
    await store.admitSubmission(sessionA.id, thread.id, {
      id: itemId,
      threadId: thread.id,
      content: "crashed after append",
      status: "queued",
      attemptCount: 0,
      maxAttempts: 10,
      timeoutAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await store.claimSubmission({
      sessionId: sessionA.id,
      threadId: thread.id,
      itemId,
      attemptId: "att-dead",
      ownerId: "crashed-owner",
    });
    await store.insertAttemptMarker(itemId, "att-dead");
    // The dead attempt got as far as persisting the user entry.
    const crafted: MessageEntry = {
      id: "e-crafted-user",
      sessionId: sessionA.id,
      threadId: thread.id,
      parentId: null,
      type: "message",
      role: "user",
      content: "crashed after append",
      queueItemId: itemId,
      createdAt: Date.now(),
    };
    await store.appendEntries(sessionA.id, thread.id, [crafted]);

    const engineB = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    await engineB.restoreSession({ sessionId: sessionA.id, options });

    await waitForAsync(
      async () => (await store.getQueueItem(sessionA.id, itemId))?.status === "settled",
    );
    const item = await store.getQueueItem(sessionA.id, itemId);
    expect(item?.outcome?.outcome).toBe("completed");
    // Fresh re-run happened (assistant reply exists) and the idempotent
    // append did NOT duplicate the user entry.
    const entries = await store.getEntries(sessionA.id, thread.id);
    expect(
      entries.filter((e) => e.type === "message" && e.role === "user" && e.queueItemId === itemId),
    ).toHaveLength(1);
    const assistants = entries.filter((e) => e.type === "message" && e.role === "assistant");
    expect(assistants.some((e) => e.content === "fresh run after crash")).toBe(true);
  });

  it("a resolver returning NULL on gate replay settles failed (unknown spec) — never streams on stale creds", async () => {
    const fauxX = makeFaux("seam-resume-nullspec");
    const modelX = fauxX.getModel();
    fauxX.setResponses([
      fauxAssistantMessage([fauxToolCall("do_thing", { arg: "a" }, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
      // Must NOT be consumed: the spec no longer resolves (e.g. the admin
      // deleted the custom provider row while the session sat at the gate) —
      // continuing would run on the stale key/model or ambient env creds.
      fauxAssistantMessage("stale continuation"),
    ]);

    const gateTool: ToolDef = {
      name: "do_thing",
      description: "gated thing",
      parameters: Type.Object({ arg: Type.String() }),
      execute: async (args, ctx) => {
        const resolution = await ctx.requestDecision({
          type: "approval",
          title: "approve?",
          body: `arg=${String(args.arg)}`,
          resumeKey: `do_thing:${String(args.arg)}`,
        });
        return { text: resolution.actionId };
      },
    };

    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const sandboxProvider = new VirtualSandboxProvider();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));

    const engineA = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const sessionA = await engineA.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: modelX,
      tools: [gateTool],
      resolveModel: async (): Promise<ResolvedModel | null> => ({ model: modelX, apiKey: "k" }),
    });
    void sessionA.prompt("do the thing");
    await waitFor(() => events.some((e) => e.event.type === "decision_gate"));
    const gateEvent = events.find((e) => e.event.type === "decision_gate");
    const gate = (gateEvent?.event as { gate: DecisionGate }).gate;
    await waitForAsync(
      async () =>
        (await store.getQueueItem(sessionA.id, gate.queueItemId))?.status ===
        "blocked_on_decision_gate",
    );
    sessionA.suspendTimers();

    const resolution = { actionId: "approve", resolvedBy: "u1", resolvedAt: Date.now() };
    await store.saveDecisionGate(sessionA.id, gate.threadId, {
      ...gate,
      status: "resolved",
      resolution,
      updatedAt: Date.now(),
    });
    const gateEntries = await store.getEntries(sessionA.id, gate.threadId);
    const gateEntry = gateEntries.find((e) => e.type === "decision_gate" && e.gate.id === gate.id);
    if (gateEntry?.type === "decision_gate") {
      gateEntry.resolution = resolution;
      gateEntry.gate = { ...gateEntry.gate, status: "resolved", resolution };
      await store.updateEntry(sessionA.id, gate.threadId, gateEntry);
    }

    const engineB = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    await engineB.restoreSession({
      sessionId: sessionA.id,
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: modelX,
        tools: [gateTool],
        // The spec is now UNKNOWN to the resolver (deleted provider row).
        resolveModel: async (): Promise<ResolvedModel | null> => null,
      },
    });

    await waitForAsync(
      async () => (await store.getQueueItem(sessionA.id, gate.queueItemId))?.status === "settled",
      4000,
    );
    const item = await store.getQueueItem(sessionA.id, gate.queueItemId);
    expect(item?.outcome?.outcome).toBe("failed");
    expect(item?.outcome?.error).toMatch(/unknown model id/);
    const entries = await store.getEntries(sessionA.id, gate.threadId);
    const assistants = entries.filter((e) => e.type === "message" && e.role === "assistant");
    expect(assistants.some((e) => e.content === "stale continuation")).toBe(false);
  });

  it("an abort stamped mid-release-window settles aborted under the same attempt — never passes through queued", async () => {
    const faux = makeFaux("seam-abort-window");
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
      credentialReleaseBackoffMs: 0,
    });
    const thread = session.thread();

    // Interpose on the store seam: by releaseSubmission time the thread's
    // guard snapshot saw NO abort — stamping it here lands the abort exactly
    // in the guard→CAS window. The CAS must refuse; the item must settle
    // `aborted` without ever flickering through `queued`.
    const realRelease = store.releaseSubmission.bind(store);
    let stamped = false;
    let statusAfterRefusedRelease: string | undefined;
    vi.spyOn(store, "releaseSubmission").mockImplementation(
      async (sessionId, threadId, itemId, fence, credential) => {
        if (!stamped) {
          stamped = true;
          await store.requestAbort(sessionId, threadId);
          const released = await realRelease(sessionId, threadId, itemId, fence, credential);
          statusAfterRefusedRelease = (await store.getQueueItem(sessionId, itemId))?.status;
          return released;
        }
        return realRelease(sessionId, threadId, itemId, fence, credential);
      },
    );

    const r = await session.prompt("go");
    for (let i = 0; i < 4; i++) {
      await thread.kick();
      if ((await store.getQueueItem(session.id, r.queueItemId))?.status === "settled") break;
    }

    expect(stamped).toBe(true);
    // The refused CAS left it running (never queued) …
    expect(statusAfterRefusedRelease).toBe("running");
    // … and it settled `aborted` under the same attempt.
    const item = await store.getQueueItem(session.id, r.queueItemId);
    expect(item?.status).toBe("settled");
    expect(item?.outcome?.outcome).toBe("aborted");
  });
});
