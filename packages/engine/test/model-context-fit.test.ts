import { afterEach, describe, expect, it, vi } from "vitest";
import * as catalog from "../src/model-catalog.js";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider,
  loadRoleFromMarkdown, type BusEvent,
} from "../src/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });

async function settled(events: BusEvent[], queueItemId: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === queueItemId)) {
    if (Date.now() > deadline) throw new Error("submission did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("smaller model context protection", () => {
  it.each(["pin", "submission", "role", "tool"] as const)(
    "compacts before the first smaller-model request after a %s switch",
    async (selection) => {
      const large = registerFauxProvider({ provider: `context-large-${selection}`,
        models: [{ id: "large", name: "large", contextWindow: 1_000_000, maxTokens: 5 }] });
      const small = registerFauxProvider({ provider: `context-small-${selection}`,
        models: [{ id: "small", name: "small", contextWindow: 200_000, maxTokens: 5 }] });
      cleanups.push(() => large.unregister(), () => small.unregister());
      const largeModel = large.getModel("large")!;
      const smallModel = small.getModel("small")!;
      const smallSpec = `${smallModel.provider}/${smallModel.id}`;
      // Role frontmatter uses the bundled lookup rather than the host resolver.
      const bundled = catalog.bundledModel;
      vi.spyOn(catalog, "bundledModel").mockImplementation((provider, id) =>
        provider === smallModel.provider && id === smallModel.id ? smallModel : bundled(provider, id),
      );
      const events: BusEvent[] = [];
      const store = new InMemorySessionStore();
      const stream = new InMemoryEventStream();
      stream.subscribe({}, (event) => events.push(event));
      const engine = new Engine({ providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() } });
      const session = await engine.createSession({
        userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: largeModel,
        resolveModel: async (spec) => ({ model: spec === smallSpec ? smallModel : largeModel, apiKey: "mock" }),
        roles: [loadRoleFromMarkdown(`---\nname: slides\ndescription: Edit slides\nmodel: ${smallSpec}\n---\nUse slide tools.`)],
        compaction: { tailTurns: 1, autoContinue: false },
      });
      const thread = session.thread();
      // A warm conversation fits a million-token model but exceeds 200k.
      large.setResponses([fauxAssistantMessage("x".repeat(600_000)), fauxAssistantMessage("y".repeat(560_000))]);
      await settled(events, (await session.prompt("inspect slides")).queueItemId);
      await settled(events, (await session.prompt("inspect more slides")).queueItemId);
      const smallRequests: string[] = [];
      small.setResponses([
        (context) => { smallRequests.push(JSON.stringify(context)); return fauxAssistantMessage("## Goal\n- Edit slides\n## Progress\n- Inspection complete"); },
        (context) => { smallRequests.push(JSON.stringify(context)); return fauxAssistantMessage("slides updated"); },
      ]);
      if (selection === "pin") await thread.setModel(smallSpec);
      if (selection === "tool") large.setResponses([fauxAssistantMessage(
        [fauxToolCall("switch_model", { model: smallSpec }, { id: "switch-small" })], { stopReason: "toolUse" },
      )]);
      const receipt = await thread.submitPrompt("edit the title", {
        ...(selection === "submission" ? { model: smallSpec } : {}),
        ...(selection === "role" ? { role: "slides" } : {}),
      });
      await settled(events, receipt.queueItemId);
      expect(smallRequests).toHaveLength(2);
      expect(smallRequests.every((request) => request.length < 800_000)).toBe(true);
      const entries = await store.getEntries(session.id, thread.id);
      const replies = entries.filter((e) => e.type === "message" && e.role === "assistant");
      expect(replies.at(-1)?.type === "message" && replies.at(-1)?.content).toBe("slides updated");
      expect(entries.filter((e) => e.type === "message" && e.role === "user" && e.content === "edit the title")).toHaveLength(1);
      expect(entries.some((e) => e.type === "compaction")).toBe(true);
      if (selection === "tool") {
        expect(smallRequests.at(-1)).toContain('"toolCallId":"switch-small"');
      }
    },
  );

  it("reactive overflow recovery keeps the newest prompt exactly once", async () => {
    const faux = registerFauxProvider({ provider: "context-reactive-retry",
      models: [{ id: "model", name: "model", contextWindow: 200_000, maxTokens: 5 }] });
    cleanups.push(() => faux.unregister());
    const events: BusEvent[] = [];
    const store = new InMemorySessionStore();
    const stream = new InMemoryEventStream();
    stream.subscribe({}, (event) => events.push(event));
    const engine = new Engine({ providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() } });
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {},
      model: faux.getModel("model")!, compaction: { tailTurns: 1, autoContinue: false } });
    faux.setResponses([fauxAssistantMessage("old inspection " + "x".repeat(300_000))]);
    await settled(events, (await session.prompt("inspect the slides")).queueItemId);
    let retry = "";
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 289792 tokens > 200000 maximum" }),
      fauxAssistantMessage("## Goal\n- Edit slides\n## Progress\n- Inspection complete"),
      (context) => { retry = JSON.stringify(context); return fauxAssistantMessage("recovered"); },
    ]);
    await settled(events, (await session.prompt("unique edit request")).queueItemId);
    expect(retry.split("unique edit request")).toHaveLength(2);
    expect(retry).toContain("previous-context");
  });

  it.each(["base", "role"])("rejects oversized %s instructions without a smaller-provider call and releases the queue", async (source) => {
    const large = registerFauxProvider({ provider: `context-large-noop-${source}`,
      models: [{ id: "large", name: "large", contextWindow: 1_000_000, maxTokens: 5 }] });
    const small = registerFauxProvider({ provider: `context-small-noop-${source}`,
      models: [{ id: "small", name: "small", contextWindow: 200_000, maxTokens: 5 }] });
    cleanups.push(() => large.unregister(), () => small.unregister());
    const largeModel = large.getModel("large")!;
    const smallModel = small.getModel("small")!;
    const smallSpec = `${smallModel.provider}/${smallModel.id}`;
    const bundled = catalog.bundledModel;
    vi.spyOn(catalog, "bundledModel").mockImplementation((provider, id) =>
      provider === smallModel.provider && id === smallModel.id ? smallModel : bundled(provider, id),
    );
    const events: BusEvent[] = [];
    const store = new InMemorySessionStore();
    const stream = new InMemoryEventStream();
    stream.subscribe({}, (event) => events.push(event));
    const engine = new Engine({ providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() } });
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {},
      model: largeModel, systemPrompt: source === "base" ? "instructions ".repeat(70_000) : "Base instructions.",
      roles: [loadRoleFromMarkdown(`---\nname: slides\ndescription: Edit slides\nmodel: ${smallSpec}\n---\n${"instructions ".repeat(70_000)}`)],
      resolveModel: async (spec) => ({ model: spec === smallSpec ? smallModel : largeModel, apiKey: "mock" }),
      compaction: { autoContinue: false } });
    large.setResponses([fauxAssistantMessage("ready", source === "role" ? { usage: {
      input: 100, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 105,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } } : {}), fauxAssistantMessage("recovered on the larger model")]);
    small.setResponses([fauxAssistantMessage("must not be called")]);
    await settled(events, (await session.prompt("hello")).queueItemId);
    await session.thread().setModel(smallSpec);
    const blocked = await session.thread().submitPrompt("edit slides", source === "role" ? { role: "slides" } : {});
    await settled(events, blocked.queueItemId);
    expect(small.getPendingResponseCount()).toBe(1);
    const blockedItem = await store.getQueueItem(session.id, blocked.queueItemId);
    expect(blockedItem?.status).toBe("settled");
    expect(blockedItem?.outcome?.outcome).toBe("failed");
    expect(events.some((e) => e.event.type === "error" && e.event.error.includes("Run /compact"))).toBe(true);
    await session.thread().setModel(null);
    const recovered = await session.prompt("try again");
    await settled(events, recovered.queueItemId);
    expect((await store.getQueueItem(session.id, recovered.queueItemId))?.outcome?.outcome).toBe("completed");
  });

  it("cancelled preparation does not exhaust the compaction failure limit", async () => {
    const large = registerFauxProvider({ provider: "context-large-cancel",
      models: [{ id: "large", name: "large", contextWindow: 1_000_000, maxTokens: 5 }] });
    const small = registerFauxProvider({ provider: "context-small-cancel",
      models: [{ id: "small", name: "small", contextWindow: 200_000, maxTokens: 5 }] });
    cleanups.push(() => large.unregister(), () => small.unregister());
    const largeModel = large.getModel("large")!;
    const smallModel = small.getModel("small")!;
    const smallSpec = `${smallModel.provider}/${smallModel.id}`;
    const events: BusEvent[] = [];
    const store = new InMemorySessionStore();
    const stream = new InMemoryEventStream();
    stream.subscribe({}, (event) => events.push(event));
    const engine = new Engine({ providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() } });
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: largeModel,
      resolveModel: async (spec) => ({ model: spec === smallSpec ? smallModel : largeModel, apiKey: "mock" }),
      compaction: { tailTurns: 1, autoContinue: false } });
    large.setResponses([fauxAssistantMessage("x".repeat(600_000)), fauxAssistantMessage("y".repeat(560_000))]);
    await settled(events, (await session.prompt("inspect")).queueItemId);
    await settled(events, (await session.prompt("inspect more")).queueItemId);
    await session.thread().setModel(smallSpec);
    for (let attempt = 0; attempt < 3; attempt++) {
      let started = false;
      small.setResponses([(_context, options) => new Promise<never>((_resolve, reject) => {
        started = true;
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })]);
      const receipt = await session.prompt("edit the slides");
      const deadline = Date.now() + 4000;
      while (!started) {
        if (Date.now() > deadline) throw new Error("summarizer did not start");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await session.thread().abortSubmission(receipt.queueItemId);
      await settled(events, receipt.queueItemId);
      expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome?.outcome).toBe("aborted");
    }
    small.setResponses([
      fauxAssistantMessage("## Goal\n- Edit slides\n## Progress\n- Inspection complete"),
      fauxAssistantMessage("slides updated after cancellation"),
    ]);
    const recovered = await session.prompt("try again");
    await settled(events, recovered.queueItemId);
    expect((await store.getQueueItem(session.id, recovered.queueItemId))?.outcome?.outcome).toBe("completed");
    expect(small.getPendingResponseCount()).toBe(0);
  });
});
