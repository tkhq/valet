import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  estimateTokens,
  type CreateSessionOptions,
  type SessionEntry,
} from "../src/index.js";
import { COMPLETE_SUMMARY } from "./fixtures/compaction-summary.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function setup(provider: string, model: { contextWindow: number; maxTokens: number }, extra?: Partial<CreateSessionOptions>) {
  const faux = registerFauxProvider({ provider, models: [{ id: "ctx", name: "ctx", ...model }] });
  cleanups.push(() => faux.unregister());
  const fixture = faux.getModel("ctx");
  if (!fixture) throw new Error("Missing fixture model");
  const providers = { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
  const options: CreateSessionOptions = { userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: fixture, ...extra };
  return { faux, providers, options, engine: new Engine({ providers }) };
}

/** A two-turn history whose first prompt is large, linked so the DAG walk reaches every entry. */
function history(sessionId: string, threadId: string, big: string): SessionEntry[] {
  const at = Date.now();
  const row = { sessionId, threadId, type: "message" as const };
  return [
    { ...row, id: "u1", parentId: null, role: "user", content: big, createdAt: at },
    { ...row, id: "a1", parentId: "u1", role: "assistant", content: "Read it.", createdAt: at + 1 },
    { ...row, id: "u2", parentId: "a1", role: "user", content: "Now summarize the findings.", createdAt: at + 2 },
    { ...row, id: "a2", parentId: "u2", role: "assistant", content: "Here is the summary.", createdAt: at + 3 },
  ];
}

describe("Thread.contextUsage", () => {
  it("anchors a live thread on the last reported usage and budgets like the compaction check", async () => {
    const { faux, engine, providers, options } = setup("ctx-live", { contextWindow: 200_000, maxTokens: 8_000 });
    faux.setResponses([fauxAssistantMessage("hello back")]);
    const session = await engine.createSession(options);
    const receipt = await session.prompt("hello");
    const thread = session.thread();
    expect((await thread.awaitResult(receipt.queueItemId)).outcome).toBe("completed");
    const reply = (await providers.store.getEntries(session.id, thread.id))
      .find((entry) => entry.type === "message" && entry.role === "assistant");
    if (reply?.type !== "message" || !reply.usage) throw new Error("Missing assistant usage");

    // The output reserve is min(20_000, maxTokens), so 8_000 here.
    expect(await thread.contextUsage()).toEqual({
      tokens: reply.usage.total,
      limit: 192_000,
      contextWindow: 200_000,
      model: "ctx",
      autoCompact: true,
    });
  });

  it("reads a restored thread from the store and agrees with its loaded transcript", async () => {
    const { faux, engine, providers, options } = setup("ctx-restored", { contextWindow: 200_000, maxTokens: 8_000 });
    const session = await engine.createSession(options);
    const threadId = session.thread().id;
    const big = "evidence ".repeat(4_000);
    await providers.store.appendEntries(session.id, threadId, history(session.id, threadId, big));

    const restored = (await new Engine({ providers }).restoreSession({ sessionId: session.id, options })).thread();
    const fromStore = await restored.contextUsage();
    expect(fromStore?.tokens).toBeGreaterThanOrEqual(estimateTokens(big));
    expect(faux.state.callCount).toBe(0);

    restored.rehydrateTranscript(await providers.store.getEntries(session.id, threadId));
    expect(await restored.contextUsage()).toEqual(fromStore);
  });

  it("drops after a manual compaction", async () => {
    const { faux, engine, providers, options } = setup(
      "ctx-compact", { contextWindow: 200_000, maxTokens: 8_000 }, { compaction: { tailTurns: 1, autoContinue: false } },
    );
    faux.setResponses([fauxAssistantMessage(COMPLETE_SUMMARY)]);
    const session = await engine.createSession(options);
    const thread = session.thread();
    await providers.store.appendEntries(session.id, thread.id, history(session.id, thread.id, "evidence ".repeat(4_000)));
    thread.rehydrateTranscript(await providers.store.getEntries(session.id, thread.id));

    const before = await thread.contextUsage();
    expect(await thread.compactThread({ mode: "manual" })).toBe("compacted");
    const after = await thread.contextUsage();
    if (!before || !after) throw new Error("Missing context usage");
    expect(after.tokens).toBeLessThan(before.tokens / 2);
  });

  it("is undefined for a model that reports no context window", async () => {
    const { engine, options } = setup("ctx-unknown", { contextWindow: 0, maxTokens: 8_000 });
    const session = await engine.createSession(options);
    expect(await session.thread().contextUsage()).toBeUndefined();
  });

  it("reports when the session turns automatic compaction off", async () => {
    const { engine, options } = setup("ctx-off", { contextWindow: 200_000, maxTokens: 8_000 }, { compaction: { enabled: false } });
    const session = await engine.createSession(options);
    expect((await session.thread().contextUsage())?.autoCompact).toBe(false);
  });

  it("follows a size tier that an administrator re-points after the session was built", async () => {
    const { engine, options } = setup("ctx-tier-a", { contextWindow: 50_000, maxTokens: 8_000 });
    const large = registerFauxProvider({ provider: "ctx-tier-b", models: [{ id: "ctx-b", name: "ctx-b", contextWindow: 400_000, maxTokens: 8_000 }] });
    cleanups.push(() => large.unregister());
    let tier = options.model;
    const session = await engine.createSession({
      ...options, modelSpec: "m",
      resolveModel: async (spec) => spec === "m" ? { model: tier } : null,
    });
    expect((await session.thread().contextUsage())?.model).toBe("ctx");

    const repointed = large.getModel("ctx-b");
    if (!repointed) throw new Error("Missing fixture model");
    tier = repointed;
    expect(await session.thread().contextUsage()).toMatchObject({ model: "ctx-b", contextWindow: 400_000 });
  });

  it("reads the thread's own model, not a one-off turn model, when the turn's settlement is announced", async () => {
    const { faux, engine, providers, options } = setup("ctx-oneoff-small", { contextWindow: 50_000, maxTokens: 8_000 });
    const big = registerFauxProvider({ provider: "ctx-oneoff-big", models: [{ id: "ctx-big", name: "ctx-big", contextWindow: 400_000, maxTokens: 8_000 }] });
    cleanups.push(() => big.unregister());
    const bigModel = big.getModel("ctx-big");
    if (!bigModel) throw new Error("Missing fixture model");
    big.setResponses([fauxAssistantMessage("answered on the big model")]);
    faux.setResponses([]);
    const session = await engine.createSession({
      ...options, modelSpec: "small",
      resolveModel: async (spec) => spec === "small" ? { model: options.model } : spec === "big" ? { model: bigModel } : null,
    });
    const thread = session.thread();

    // The web refreshes the meter on submission.settled because a turn_end
    // refetch can land while the turn still holds its one-off model. A read
    // started as settlement is announced (bus delivery is synchronous) must
    // already see the thread's own model.
    const atSettle: Array<Promise<Awaited<ReturnType<typeof thread.contextUsage>>>> = [];
    const unsubscribe = providers.stream.subscribe(
      { sessionId: session.id, eventTypes: ["submission_settled"] },
      () => { atSettle.push(thread.contextUsage()); },
    );
    cleanups.push(unsubscribe);
    const receipt = await thread.submitPrompt("use the big model", { model: "big" });
    expect((await thread.awaitResult(receipt.queueItemId)).outcome).toBe("completed");

    expect(atSettle).toHaveLength(1);
    expect(await atSettle[0]).toMatchObject({ model: "ctx", contextWindow: 50_000 });
  });

  it("reads a thread's pinned model, not the session baseline, when its turn's settlement is announced", async () => {
    const { faux, engine, providers, options } = setup("ctx-pin-small", { contextWindow: 50_000, maxTokens: 8_000 });
    const big = registerFauxProvider({ provider: "ctx-pin-big", models: [{ id: "ctx-big", name: "ctx-big", contextWindow: 400_000, maxTokens: 8_000 }] });
    cleanups.push(() => big.unregister());
    const bigModel = big.getModel("ctx-big");
    if (!bigModel) throw new Error("Missing fixture model");
    big.setResponses([fauxAssistantMessage("answered on the pinned model")]);
    faux.setResponses([]);
    const session = await engine.createSession({
      ...options, modelSpec: "small",
      resolveModel: async (spec) => spec === "small" ? { model: options.model } : spec === "big" ? { model: bigModel } : null,
    });
    const thread = session.thread();
    await thread.setModel("big");

    // The turn's cleanup restores the session baseline before settlement is
    // delivered, while the turn is still running. A read at that moment must
    // report the thread's pin.
    const atSettle: Array<Promise<Awaited<ReturnType<typeof thread.contextUsage>>>> = [];
    cleanups.push(providers.stream.subscribe(
      { sessionId: session.id, eventTypes: ["submission_settled"] },
      () => { atSettle.push(thread.contextUsage()); },
    ));
    const receipt = await thread.submitPrompt("work on the pinned model", {});
    expect((await thread.awaitResult(receipt.queueItemId)).outcome).toBe("completed");

    expect(atSettle).toHaveLength(1);
    expect(await atSettle[0]).toMatchObject({ model: "ctx-big", contextWindow: 400_000 });
  });
});
