import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { fauxAssistantMessage, registerFauxProvider, type FauxResponseStep } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import {
  Engine,
  InMemoryEventBus,
  InMemorySessionStore,
  TimeoutError,
  VirtualSandboxProvider,
  type BusEvent,
} from "../src/index.js";
import { SqliteSessionStore, applyEngineMigrations } from "@valet/store-sqlite";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventBus();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, bus, sandboxProvider } });
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

  it("superseded returns outcome 'superseded' plus partial text", async () => {
    const faux = registerFauxProvider({ provider: "await-superseded", tokensPerSecond: 30 });
    const longText = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    faux.setResponses([fauxAssistantMessage(longText), fauxAssistantMessage("steer-done")]);

    const { engine, events } = makeEngine();
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
    expect(result.text).toBeDefined();
    expect((result.text?.length ?? 0) > 0).toBe(true);

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

  it("resultSchema is rejected as not implemented until Phase 5", async () => {
    const faux = registerFauxProvider({ provider: "await-schema" });
    faux.setResponses([fauxAssistantMessage("n/a")]);

    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("hi");
    await expect(
      session.thread().awaitResult(r1.queueItemId, { resultSchema: Type.Object({}) }),
    ).rejects.toThrow("resultSchema lands in Phase 5");

    faux.unregister();
  });

  it("resumability: settle under engine A, awaitResult under a fresh engine B over the same store", async () => {
    const faux = registerFauxProvider({ provider: "await-resume", tokensPerSecond: 200 });
    faux.setResponses([fauxAssistantMessage("resumed-done")]);

    const dir = mkdtempSync(join(tmpdir(), "valet-await-result-"));
    const dbPath = join(dir, "engine.db");

    const sqliteA = new Database(dbPath);
    applyEngineMigrations(sqliteA);
    const storeA = new SqliteSessionStore(drizzle(sqliteA));
    const busA = new InMemoryEventBus();
    const engineA = new Engine({
      providers: { store: storeA, bus: busA, sandboxProvider: new VirtualSandboxProvider() },
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

    sqliteA.close();

    const sqliteB = new Database(dbPath);
    const storeB = new SqliteSessionStore(drizzle(sqliteB));
    const busB = new InMemoryEventBus();
    const engineB = new Engine({
      providers: { store: storeB, bus: busB, sandboxProvider: new VirtualSandboxProvider() },
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

    sqliteB.close();
    faux.unregister();
  });
});
