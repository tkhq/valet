import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type BusEvent, type CreateSessionOptions, type ResolvedModel, type ToolDef } from "../src/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function provider(id: string) {
  const faux = registerFauxProvider({ provider: id });
  cleanups.push(() => faux.unregister());
  return faux;
}
function setup() {
  const store = new InMemorySessionStore();
  const stream = new InMemoryEventStream();
  const events: BusEvent[] = [];
  stream.subscribe({}, (event) => events.push(event));
  const providers = { store, stream, sandboxProvider: new VirtualSandboxProvider() };
  const engine = new Engine({ providers });
  return { engine, store, events, providers };
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for settlement");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const failed = (errorMessage = "HTTP 503 Service Unavailable") => fauxAssistantMessage("", { stopReason: "error", errorMessage });

describe("automatic provider fallback", () => {
  it("continues an authored turn once, retains completed tools, switches keys, and restores selection", async () => {
    const primary = provider("fallback-primary");
    const backup = provider("fallback-backup");
    const seenKeys: Array<string | undefined> = [];
    const execute = vi.fn(async () => ({ text: "done once" }));
    primary.setResponses([
      fauxAssistantMessage([fauxToolCall("side_effect", {}, { id: "once" })], { stopReason: "toolUse" }),
      failed(),
      (_ctx, options) => { seenKeys.push(options?.apiKey); return fauxAssistantMessage("next turn primary"); },
    ]);
    backup.setResponses([ (context, options) => {
      seenKeys.push(options?.apiKey);
      expect(context.messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
      return fauxAssistantMessage("recovered");
    }]);
    const fallback = vi.fn<NonNullable<CreateSessionOptions["resolveFallbackModel"]>>(async () => ({ model: backup.getModel(), apiKey: "backup-key", canonicalId: "backup/spec" }));
    const { engine, store, events } = setup();
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, purpose: "orchestrator",
      model: primary.getModel(), modelSpec: "primary/spec",
      tools: [{ name: "side_effect", description: "Complete work", parameters: Type.Object({}), execute }],
      resolveModel: async () => ({ model: primary.getModel(), apiKey: "primary-key" }),
      resolveFallbackModel: fallback,
    });
    const receipt = await session.prompt("do work", { author: { id: "u" } });
    await waitFor(() => events.some(({ event }) => event.type === "submission_settled" && event.queueItemId === receipt.queueItemId));
    expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome?.outcome).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    const entries = await store.getEntries(session.id, receipt.threadId);
    expect(entries.filter((entry) => entry.type === "message" && entry.role === "user")).toHaveLength(1);
    expect(fallback.mock.calls[0]?.[0]).toMatchObject({ requestedSpec: "primary/spec", attemptedProviderIds: [primary.getModel().provider], failedModel: { apiKey: "primary-key" } });
    expect(events.some(({ event }) => event.type === "model_state" && event.model === `${backup.getModel().provider}/${backup.getModel().id}`)).toBe(true);
    expect(events.some(({ event }) => event.type === "error" && event.code === "turn_provider_fallback" && event.recoverable)).toBe(true);
    const next = await session.prompt("another turn", { author: { id: "u" } });
    await waitFor(() => events.some(({ event }) => event.type === "submission_settled" && event.queueItemId === next.queueItemId));
    expect(seenKeys).toEqual(["backup-key", "primary-key"]);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["429 rate limit exceeded", true], ["read ECONNRESET", true], ["insufficient_quota", true],
    ["Your credit balance is too low", true], ["You exceeded your current quota", true], ["billing_hard_limit_reached", true],
    ["invalid x-api-key: authentication_error", false], ["invalid_request_error: max_tokens required", false],
    ["403 forbidden", false], ["invalid input: 429", false], ["content_policy_violation", false], ["budget exceeded 429", false],
  ])("classifies %s without bypassing permanent failures", async (error, shouldFallback) => {
    const primary = provider("fallback-classification-primary");
    const backup = provider("fallback-classification-backup");
    primary.setResponses([failed(String(error))]);
    backup.setResponses([fauxAssistantMessage("recovered")]);
    const fallback = vi.fn(async (): Promise<ResolvedModel> => ({ model: backup.getModel() }));
    const { engine, store, events } = setup();
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: primary.getModel(), resolveFallbackModel: fallback });
    const receipt = await session.prompt("work", { author: { id: "u" } });
    await waitFor(() => events.some(({ event }) => event.type === "submission_settled" && event.queueItemId === receipt.queueItemId));
    expect(fallback).toHaveBeenCalledTimes(shouldFallback ? 1 : 0);
    expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome?.outcome).toBe(shouldFallback ? "completed" : "failed");
  });

  it("bounds provider attempts and settles exhausted recovery once", async () => {
    const providers = [provider("fallback-bound-a"), provider("fallback-bound-b"), provider("fallback-bound-c"), provider("fallback-bound-d")];
    providers.forEach((faux) => faux.setResponses([failed()]));
    const fallback = vi.fn<NonNullable<CreateSessionOptions["resolveFallbackModel"]>>(async ({ attemptedProviderIds }) => ({ model: providers[attemptedProviderIds.length]!.getModel() }));
    const { engine, store, events } = setup();
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: providers[0]!.getModel(), resolveFallbackModel: fallback });
    const receipt = await session.prompt("work");
    await waitFor(() => events.some(({ event }) => event.type === "submission_settled" && event.queueItemId === receipt.queueItemId));
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(providers[3]!.getPendingResponseCount()).toBe(1);
    expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome?.outcome).toBe("failed");
    expect(events.filter(({ event }) => event.type === "submission_settled" && event.queueItemId === receipt.queueItemId)).toHaveLength(1);
  });

  it.each(["same provider", "no candidate"])("does not retry quota errors when the resolver returns %s", async (result) => {
    const primary = provider("fallback-quota-primary");
    primary.setResponses([failed("insufficient_quota"), fauxAssistantMessage("must not retry")]);
    const fallback = vi.fn(async (): Promise<ResolvedModel | null> => result === "same provider" ? { model: primary.getModel() } : null);
    const { engine, store, events } = setup();
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: primary.getModel(),
      purpose: "child", turnRetry: { maxAttempts: 2, backoffMs: [1] }, resolveFallbackModel: fallback,
    });
    const receipt = await session.prompt("work");
    await waitFor(() => events.some(({ event }) => event.type === "submission_settled" && event.queueItemId === receipt.queueItemId));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(primary.getPendingResponseCount()).toBe(1);
    expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome?.outcome).toBe("failed");
  });

  it("recovers a provider failure after reactive overflow compaction", async () => {
    const primary = registerFauxProvider({ provider: "fallback-overflow-primary", models: [{ id: "m", name: "m", contextWindow: 200_000, maxTokens: 5 }] });
    cleanups.push(() => primary.unregister());
    const backup = provider("fallback-overflow-backup");
    const { engine, store, events } = setup();
    const fallback = vi.fn(async (): Promise<ResolvedModel> => ({ model: backup.getModel(), apiKey: "backup-key" }));
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: primary.getModel("m")!,
      compaction: { tailTurns: 1, autoContinue: false }, resolveFallbackModel: fallback,
    });
    primary.setResponses([fauxAssistantMessage("old work " + "x".repeat(300_000))]);
    const first = await session.prompt("inspect work");
    await waitFor(() => events.some(({ event }) => event.type === "submission_settled" && event.queueItemId === first.queueItemId));
    primary.setResponses([
      failed("prompt is too long: 289792 tokens > 200000 maximum"),
      fauxAssistantMessage("## Goal\n- Edit work\n## Progress\n- Inspection complete"),
      failed(),
    ]);
    backup.setResponses([(context, options) => {
      expect(options?.apiKey).toBe("backup-key");
      const request = JSON.stringify(context);
      expect(request.split("unique edit request")).toHaveLength(2);
      expect(request).toContain("previous-context");
      return fauxAssistantMessage("recovered after compaction");
    }]);
    const receipt = await session.prompt("unique edit request");
    await waitFor(() => events.some(({ event }) => event.type === "submission_settled" && event.queueItemId === receipt.queueItemId));
    expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome?.outcome).toBe("completed");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it.each(["resolved", "expired"] as const)("recovers a %s approval continuation after restart", async (gateStatus) => {
    const primary = provider(`fallback-replay-primary-${gateStatus}`);
    const backup = provider(`fallback-replay-backup-${gateStatus}`);
    primary.setResponses([
      fauxAssistantMessage([fauxToolCall("approved_work", {}, { id: "approved-call" })], { stopReason: "toolUse" }),
      failed(),
      fauxAssistantMessage("next turn primary"),
    ]);
    const seenKeys: Array<string | undefined> = [];
    backup.setResponses([(context, options) => {
      seenKeys.push(options?.apiKey);
      expect(context.messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
      return fauxAssistantMessage("recovered after restart");
    }]);
    const completedWork = vi.fn();
    const tool: ToolDef = {
      name: "approved_work", description: "Run approved work", parameters: Type.Object({}),
      execute: async (_args, context) => {
        await context.requestDecision({ type: "approval", title: "Approve work", body: "Approve the work.", resumeKey: "work" });
        completedWork();
        return { text: "completed once" };
      },
    };
    const fallback = vi.fn<NonNullable<CreateSessionOptions["resolveFallbackModel"]>>(async () => ({ model: backup.getModel(), apiKey: "backup-key" }));
    const options: CreateSessionOptions = {
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: primary.getModel(), modelSpec: "primary/spec",
      tools: [tool], resolveModel: async () => ({ model: primary.getModel(), apiKey: "primary-key" }), resolveFallbackModel: fallback,
    };
    const { engine, store, events, providers } = setup();
    const session = await engine.createSession(options);
    const receipt = await session.prompt("approved work", { author: { id: "u" } });
    await waitFor(() => events.some(({ event }) => event.type === "decision_gate"));
    const gateEvent = events.find(({ event }) => event.type === "decision_gate")?.event;
    if (gateEvent?.type !== "decision_gate") throw new Error("Expected approval gate");
    const gate = gateEvent.gate;
    const deadline = Date.now() + 4000;
    while ((await store.getQueueItem(session.id, receipt.queueItemId))?.status !== "blocked_on_decision_gate") {
      if (Date.now() > deadline) throw new Error("Expected a durable blocked submission");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    session.suspendTimers();
    const resolution = { actionId: "approve", resolvedBy: "u", resolvedAt: Date.now() };
    await store.saveDecisionGate(session.id, receipt.threadId, {
      ...gate, status: gateStatus, ...(gateStatus === "resolved" ? { resolution } : {}), updatedAt: Date.now(),
    });
    if (gateStatus === "resolved") {
      const entry = (await store.getEntries(session.id, receipt.threadId)).find((entry) => entry.type === "decision_gate" && entry.gate.id === gate.id);
      if (entry?.type !== "decision_gate") throw new Error("Expected persisted approval gate");
      entry.resolution = resolution;
      entry.gate = { ...entry.gate, status: "resolved", resolution };
      await store.updateEntry(session.id, receipt.threadId, entry);
    }
    const restarted = new Engine({ providers });
    const restored = await restarted.restoreSession({ sessionId: session.id, options });
    await waitFor(() => events.some(({ event }) => event.type === "submission_settled" && event.queueItemId === receipt.queueItemId));
    expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome?.outcome).toBe("completed");
    expect(completedWork).toHaveBeenCalledTimes(gateStatus === "resolved" ? 1 : 0);
    expect(seenKeys).toEqual(["backup-key"]);
    expect(fallback.mock.calls[0]?.[0]).toMatchObject({ requestedSpec: "primary/spec", failedModel: { apiKey: "primary-key" } });
    const next = await restored.prompt("next turn");
    await waitFor(() => events.some(({ event }) => event.type === "submission_settled" && event.queueItemId === next.queueItemId));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(primary.getPendingResponseCount()).toBe(0);
    restored.suspendTimers();
  });

  it.each(["thread", "submission"])("does not start a fallback after a %s abort while resolving it", async (scope) => {
    const primary = provider("fallback-abort-primary");
    const backup = provider("fallback-abort-backup");
    primary.setResponses([failed()]);
    backup.setResponses([fauxAssistantMessage("must not run")]);
    let release!: (model: ResolvedModel) => void;
    const pending = new Promise<ResolvedModel>((resolve) => { release = resolve; });
    const fallback = vi.fn(async () => pending);
    const { engine, store, events } = setup();
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: primary.getModel(), resolveFallbackModel: fallback });
    const receipt = await session.prompt("work");
    await waitFor(() => fallback.mock.calls.length === 1);
    const abort = scope === "thread" ? session.thread().abort() : session.thread().abortSubmission(receipt.queueItemId);
    release({ model: backup.getModel() });
    await abort;
    await waitFor(() => events.some(({ event }) => event.type === "submission_settled" && event.queueItemId === receipt.queueItemId));
    expect(backup.getPendingResponseCount()).toBe(1);
    expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome?.outcome).toBe("aborted");
  });
});
