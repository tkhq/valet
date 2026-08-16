import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { fauxAssistantMessage, registerFauxProvider, type FauxResponseStep } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  TimeoutError,
  VirtualSandboxProvider,
  type BusEvent,
  type MessageEntry,
  type QueueItem,
  type SessionStore,
} from "../src/index.js";
import { PgSessionStore, applyEngineMigrations, pgDbFromPglite } from "@valet/store-postgres";

let seedSeq = 1;
function seedItem(threadId: string, id: string): QueueItem {
  const createdAt = 1_000 + seedSeq++;
  return {
    id,
    threadId,
    content: `seed-${id}`,
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: createdAt + 3_600_000,
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * Seed a chain of `mergedCount` merged items directly in the store —
 * m0 → m1 → … → m(n-1) → terminal — with the terminal item settled
 * `completed` and carrying a persisted end_turn assistant entry.
 * Returns the ids in chain order (terminal last).
 */
async function seedMergeChain(
  store: SessionStore,
  sessionId: string,
  threadId: string,
  mergedCount: number,
  terminalText: string,
): Promise<string[]> {
  const ids = [
    ...Array.from({ length: mergedCount }, (_, i) => `m-${mergedCount}-${i}`),
    `terminal-${mergedCount}`,
  ];
  for (const id of ids) {
    await store.admitSubmission(sessionId, threadId, seedItem(threadId, id));
  }
  for (let i = 0; i < mergedCount; i++) {
    const ok = await store.settleUnclaimed(
      sessionId,
      threadId,
      ids[i],
      { outcome: "merged" },
      { mergedIntoItemId: ids[i + 1] },
    );
    if (!ok) throw new Error(`failed to seed merged item ${ids[i]}`);
  }
  const terminalId = ids[ids.length - 1];
  const entry: MessageEntry = {
    id: `entry-${terminalId}`,
    sessionId,
    threadId,
    parentId: null,
    createdAt: Date.now(),
    type: "message",
    role: "assistant",
    content: terminalText,
    queueItemId: terminalId,
    stopReason: "end_turn",
  };
  await store.appendEntries(sessionId, threadId, [entry]);
  const settled = await store.settleUnclaimed(sessionId, threadId, terminalId, {
    outcome: "completed",
  });
  if (!settled) throw new Error(`failed to seed terminal item ${terminalId}`);
  return ids;
}

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, bus, events };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Thread.awaitResult", () => {
  it("settled-before-call returns immediately with the right text", async () => {
    const faux = registerFauxProvider({ provider: "await-settled", tokensPerSecond: 200 });
    faux.setResponses([fauxAssistantMessage("done-already")]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("hello");
    await waitFor(async () => (await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled");

    const result = await session.thread().awaitResult(r1.queueItemId);
    expect(result).toEqual({
      queueItemId: r1.queueItemId,
      outcome: "completed",
      text: "done-already",
    });

    faux.unregister();
  });

  it("call-then-settle resolves via the event", async () => {
    const faux = registerFauxProvider({ provider: "await-live", tokensPerSecond: 50 });
    faux.setResponses([fauxAssistantMessage("later-done")]);

    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("hello");
    // Submission is not yet settled — awaitResult must subscribe and wait.
    const result = await session.thread().awaitResult(r1.queueItemId);
    expect(result).toEqual({
      queueItemId: r1.queueItemId,
      outcome: "completed",
      text: "later-done",
    });

    faux.unregister();
  });

  it("merged constituent delegates to the merged item's result", async () => {
    const faux = registerFauxProvider({ provider: "await-merged" });
    faux.setResponses([fauxAssistantMessage("merged-done")]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      queueMode: "collect",
      collectWindowMs: 60,
    });

    const r1 = await session.prompt("one");
    await session.prompt("two");

    // r1 settles to outcome "merged" almost immediately (before the merged
    // item itself finishes) — awaitResult on r1 must still wait for and
    // return the merged item's eventual result, not its own "merged" stub.
    const result = await session.thread().awaitResult(r1.queueItemId);
    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("merged-done");
    expect(result.queueItemId).not.toBe(r1.queueItemId);

    const constituent = await store.getQueueItem(session.id, r1.queueItemId);
    expect(constituent?.outcome).toEqual({ outcome: "merged" });
    expect(result.queueItemId).toBe(constituent?.mergedIntoItemId);

    faux.unregister();
  });

  it("merge chain of exactly MAX depth (5 hops) still resolves to the terminal result", async () => {
    const faux = registerFauxProvider({ provider: "await-depth-ok" });
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = session.thread();

    // 5 merged hops → the terminal item is read at delegation depth 5,
    // exactly the bound — must resolve, not error.
    const ids = await seedMergeChain(store, session.id, thread.id, 5, "deep-done");
    const result = await thread.awaitResult(ids[0]);
    expect(result).toEqual({
      queueItemId: ids[ids.length - 1],
      outcome: "completed",
      text: "deep-done",
    });

    faux.unregister();
  });

  it("merge chain exceeding MAX depth returns an error-shaped result, not a hang or throw", async () => {
    const faux = registerFauxProvider({ provider: "await-depth-exceeded" });
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = session.thread();

    // 7 merged hops: delegation is cut at depth 6 (> 5), i.e. at the 7th
    // item in the chain (index 6), before its terminal item is ever reached.
    const ids = await seedMergeChain(store, session.id, thread.id, 7, "never-reached");
    const result = await thread.awaitResult(ids[0]);
    expect(result).toEqual({
      queueItemId: ids[6],
      outcome: "failed",
      error: "merge delegation depth exceeded 5 hops",
    });

    faux.unregister();
  });

  it("superseded returns outcome 'superseded' plus partial text", async () => {
    const faux = registerFauxProvider({ provider: "await-superseded", tokensPerSecond: 30 });
    const longText = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    faux.setResponses([fauxAssistantMessage(longText), fauxAssistantMessage("steer-done")]);

    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("original");
    await waitFor(() => events.some((e) => e.event.type === "text_delta"));
    await session.thread().submitPrompt("steer-in", { queueMode: "steer" });

    const result = await session.thread().awaitResult(r1.queueItemId);
    expect(result.queueItemId).toBe(r1.queueItemId);
    expect(result.outcome).toBe("superseded");

    // End-to-end wiring proof: the content is nondeterministic (interrupted
    // mid-stream), so compute the expected partial text from the persisted
    // entries — the LAST assistant entry under the superseded item's own
    // queueItemId, regardless of stopReason — and require an exact match.
    const entries = await store.getEntries(session.id, session.thread().id);
    const partials = entries.filter(
      (e): e is MessageEntry =>
        e.type === "message" && e.role === "assistant" && e.queueItemId === r1.queueItemId,
    );
    expect(partials.length).toBeGreaterThan(0);
    const expectedText = partials[partials.length - 1].content;
    expect(expectedText.length).toBeGreaterThan(0);
    expect(result.text).toBe(expectedText);

    faux.unregister();
  });

  it("timeout rejects while the item later settles normally, undisturbed", async () => {
    const faux = registerFauxProvider({ provider: "await-timeout", tokensPerSecond: 20 });
    const longText = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    faux.setResponses([fauxAssistantMessage(longText)]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("go long");
    await expect(
      session.thread().awaitResult(r1.queueItemId, { timeoutMs: 20 }),
    ).rejects.toThrow(TimeoutError);

    // The submission itself must be unaffected by the timed-out wait — it
    // keeps running and eventually settles completed on its own.
    await waitFor(async () => (await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled");
    const item = await store.getQueueItem(session.id, r1.queueItemId);
    expect(item?.outcome).toEqual({ outcome: "completed" });

    const result = await session.thread().awaitResult(r1.queueItemId);
    expect(result.outcome).toBe("completed");

    faux.unregister();
  });

  it("aborting the signal rejects the wait without disturbing the submission", async () => {
    const faux = registerFauxProvider({ provider: "await-abort-signal", tokensPerSecond: 20 });
    const longText = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    faux.setResponses([fauxAssistantMessage(longText)]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("go long");
    const controller = new AbortController();
    const pending = session.thread().awaitResult(r1.queueItemId, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow();

    await waitFor(async () => (await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled");
    const item = await store.getQueueItem(session.id, r1.queueItemId);
    expect(item?.outcome).toEqual({ outcome: "completed" });

    faux.unregister();
  });

  it("resultSchema on a completed submission populates output", async () => {
    const faux = registerFauxProvider({ provider: "await-schema-valid" });
    faux.setResponses([fauxAssistantMessage('```json\n{"answer": 42}\n```')]);

    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const schema = Type.Object({ answer: Type.Number() });
    const r1 = await session.prompt("hi");
    const result = await session.thread().awaitResult(r1.queueItemId, { resultSchema: schema });
    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({ answer: 42 });
    expect(result.error).toBeUndefined();

    faux.unregister();
  });

  it("resultSchema validation failure leaves output undefined, sets error, outcome stays completed", async () => {
    const faux = registerFauxProvider({ provider: "await-schema-invalid" });
    faux.setResponses([fauxAssistantMessage('```json\n{"answer": "not-a-number"}\n```')]);

    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const schema = Type.Object({ answer: Type.Number() });
    const r1 = await session.prompt("hi");
    const result = await session.thread().awaitResult(r1.queueItemId, { resultSchema: schema });
    expect(result.outcome).toBe("completed");
    expect(result.output).toBeUndefined();
    expect(result.error).toBeDefined();

    faux.unregister();
  });

  it("resultSchema is not attempted for a non-completed outcome", async () => {
    const faux = registerFauxProvider({ provider: "await-schema-timeout", tokensPerSecond: 30 });
    const longText = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    faux.setResponses([fauxAssistantMessage(longText), fauxAssistantMessage("steer-done")]);

    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("original");
    await waitFor(() => events.some((e) => e.event.type === "text_delta"));
    await session.thread().submitPrompt("steer-in", { queueMode: "steer" });

    const schema = Type.Object({ answer: Type.Number() });
    const result = await session.thread().awaitResult(r1.queueItemId, { resultSchema: schema });
    expect(result.outcome).toBe("superseded");
    expect(result.output).toBeUndefined();
    expect(result.error).toBeUndefined();

    await waitFor(async () => (await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled");
    faux.unregister();
  });

  // Two PGlite cold boots (WASM init) make this the suite's heaviest test —
  // under full-suite worker contention it can exceed vitest's 5s default
  // while passing in well under 1s alone. Budget it explicitly.
  it("resumability: settle under engine A, awaitResult under a fresh engine B over the same store", { timeout: 20_000 }, async () => {
    const faux = registerFauxProvider({ provider: "await-resume", tokensPerSecond: 200 });
    faux.setResponses([fauxAssistantMessage("resumed-done")]);

    const dir = mkdtempSync(join(tmpdir(), "valet-await-result-"));
    // PGlite wants a directory to persist to, not a single file — unlike the
    // sqlite predecessor's single `engine.db` path.
    const dataDir = join(dir, "pgdata");

    const pgliteA = await PGlite.create(dataDir);
    const pgdbA = pgDbFromPglite(pgliteA);
    await applyEngineMigrations(pgdbA);
    const storeA = new PgSessionStore(pgdbA);
    const busA = new InMemoryEventStream();
    const engineA = new Engine({
      providers: { store: storeA, stream: busA, sandboxProvider: new VirtualSandboxProvider() },
    });
    const sessionA = await engineA.createSession({
      id: "sess-resume-1",
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await sessionA.prompt("hello");
    await waitFor(async () => (await storeA.getQueueItem(sessionA.id, r1.queueItemId))?.status === "settled");
    const resultFromA = await sessionA.thread().awaitResult(r1.queueItemId);

    await pgliteA.close();

    const pgliteB = await PGlite.create(dataDir);
    const storeB = new PgSessionStore(pgDbFromPglite(pgliteB));
    const busB = new InMemoryEventStream();
    const engineB = new Engine({
      providers: { store: storeB, stream: busB, sandboxProvider: new VirtualSandboxProvider() },
    });
    const sessionB = await engineB.restoreSession({
      sessionId: "sess-resume-1",
      options: {
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        sandbox: {},
        model: faux.getModel(),
      },
    });

    const resultFromB = await sessionB.thread().awaitResult(r1.queueItemId);
    expect(resultFromB).toEqual(resultFromA);
    expect(resultFromB).toEqual({
      queueItemId: r1.queueItemId,
      outcome: "completed",
      text: "resumed-done",
    });

    await pgliteB.close();
    faux.unregister();
  });
});
