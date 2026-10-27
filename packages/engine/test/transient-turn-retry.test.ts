/**
 * Turn-level transient-error retry (TKAI-319): a turn that settled with a
 * transient provider error re-runs. Unattended turns wait longer; a person's
 * prompt retries briefly, and a long provider-requested wait fails at once.
 */
import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  MESSAGE_TURN_ERROR_KEY,
  VirtualSandboxProvider,
  parseProviderRetryHintMs,
  type BusEvent,
  type MessageEntry,
  type PromptContent,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// The classifier is pi-ai's, not ours — these tests document the
// dependency behavior the retry relies on, so a pi-ai upgrade that shifts
// the taxonomy fails loudly here instead of silently changing retries.
describe("isRetryableAssistantError (pi-ai taxonomy, TKAI-319)", () => {
  const errored = (errorMessage: string) =>
    fauxAssistantMessage("", { stopReason: "error", errorMessage });

  it("classifies retryable shapes", () => {
    expect(isRetryableAssistantError(errored("overloaded_error: Overloaded"))).toBe(true);
    expect(isRetryableAssistantError(errored("429 rate limit exceeded"))).toBe(true);
    expect(isRetryableAssistantError(errored("HTTP 503 Service Unavailable"))).toBe(true);
    // Mid-stream drop — a hand-rolled classifier missed this one.
    expect(isRetryableAssistantError(errored("stream ended before message_stop"))).toBe(true);
  });

  it("keeps permanent failures permanent", () => {
    expect(isRetryableAssistantError(errored("invalid x-api-key: authentication_error"))).toBe(false);
    expect(isRetryableAssistantError(errored("insufficient_quota"))).toBe(false);
    expect(isRetryableAssistantError(errored("invalid_request_error: max_tokens required"))).toBe(false);
  });

  it("documents known upstream rough edges (fix belongs in pi-ai, not a local fork)", () => {
    // Raw ECONNRESET text is not in the retryable list — the transport
    // layer's own retry sits below us and covers SDK-level resets.
    expect(isRetryableAssistantError(errored("read ECONNRESET"))).toBe(false);
    // "500" substring-matches inside "1,500", so this quota error counts
    // as retryable. Bounded cost here (2 turn attempts); the pattern fix
    // belongs upstream where every consumer benefits.
    expect(
      isRetryableAssistantError(errored("reached its monthly limit of 1,500 requests")),
    ).toBe(true);
  });
});

describe("parseProviderRetryHintMs", () => {
  it("reads the wait each provider format names", () => {
    expect(parseProviderRetryHintMs("Limit 1000000, Used 842906, Requested 160830. Please try again in 224ms.")).toBe(224);
    expect(parseProviderRetryHintMs("Please try again in 1.722s. Visit the docs")).toBe(1722);
    expect(parseProviderRetryHintMs("Rate limit reached. Please try again in 6m0s.")).toBe(360_000);
    expect(parseProviderRetryHintMs("Server requested 45s retry delay (max 30s)")).toBe(45_000);
    expect(parseProviderRetryHintMs("429: retry after 3 seconds")).toBe(3_000);
  });

  it("names no wait when the text has none", () => {
    expect(parseProviderRetryHintMs("overloaded_error: Overloaded")).toBeUndefined();
    expect(parseProviderRetryHintMs(undefined)).toBeUndefined();
  });
});

describe("turn-level transient retry (TKAI-319)", () => {
  it("an unattended (child) session retries past a transient error and completes", async () => {
    const faux = registerFauxProvider({
      provider: "retry-unattended",
      models: [{ id: "m", name: "m", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: Overloaded" }),
      fauxAssistantMessage("recovered response"),
    ]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("m")!,
      purpose: "child",
      turnRetry: { maxAttempts: 2, backoffMs: [1, 1] },
    });
    const receipt = await session.prompt("do the thing");
    // The failed first attempt emits its own turn_end before the retry runs
    // — wait for the retry's completion, not the first turn_end.
    await waitFor(() => faux.getPendingResponseCount() === 0);
    await waitFor(
      () =>
        events.filter((e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId)
          .length >= 2,
    );

    const entries = await store.getEntries(session.id, receipt.threadId);
    const lastAssistant = [...entries].reverse().find(
      (e) => e.type === "message" && e.role === "assistant",
    );
    expect(lastAssistant?.type === "message" && lastAssistant.content).toBe("recovered response");
    // The retry is progress, not an error: no error event, and the event
    // names the provider, the reason and the attempt for the working line.
    const retryEvent = events.find((e) => e.event.type === "turn_retry")?.event;
    expect(retryEvent).toMatchObject({ action: "retry", reason: "overloaded", attempt: 1, maxAttempts: 2 });
    // Only the failed call's own "error" event, which clients treat as not
    // yet a failed turn. The retry itself sends no error.
    expect(events.filter((e) => e.event.type === "error" && e.event.code !== "error").map((e) => e.event)).toEqual([]);
    faux.unregister();
  });

  it("retries are bounded — a persistent outage settles as an error after maxAttempts", async () => {
    const faux = registerFauxProvider({
      provider: "retry-bounded",
      models: [{ id: "m", name: "m", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    const err = () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: Overloaded" });
    faux.setResponses([err, err, err]); // initial + 2 retries, all failing
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("m")!,
      purpose: "child",
      turnRetry: { maxAttempts: 2, backoffMs: [1, 1] },
    });
    await session.prompt("do the thing");
    await waitFor(() => faux.getPendingResponseCount() === 0);
    await waitFor(
      () =>
        events.filter(
          (e) => e.event.type === "turn_retry" && e.event.action === "retry",
        ).length >= 2,
    );
    const retries = events.filter(
      (e) => e.event.type === "turn_retry" && e.event.action === "retry",
    );
    expect(retries).toHaveLength(2);
    faux.unregister();
  });

  it.each<{ label: string; content: PromptContent }>([
    { label: "text", content: "go" },
    { label: "file attachment", content: { text: "Read this", attachments: [{ type: "file", path: "/workspace/nda.docx", bytes: 10, sha256: "abc", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "nda.docx" }] } },
    { label: "image only", content: { attachments: [{ type: "image", data: new Uint8Array([1]), mimeType: "image/png" }] } },
  ])("settles a person's prompt at once when the provider asks for a long wait, and accepts a fresh prompt ($label)", async ({ content }) => {
    const faux = registerFauxProvider({ provider: "retry-human-orchestrator" });
    faux.setResponses([
      // Five minutes is past a person's retry window, so the turn fails now
      // instead of holding the queued prompt behind a background wait.
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded. Please try again in 5m." }),
      fauxAssistantMessage("queued response"),
      fauxAssistantMessage("fresh response"),
    ]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(),
      purpose: "orchestrator", turnRetry: { backoffMs: [1] },
    });
    await session.thread().pause();
    const first = await session.prompt(content, { author: { id: "u" } });
    const queued = await session.prompt("already queued", { author: { id: "u" } });
    await session.thread().resume();
    await waitFor(() => events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === first.queueItemId));
    expect((await store.getQueueItem(session.id, first.queueItemId))?.outcome?.outcome).toBe("failed");
    expect(events.some((e) => e.event.type === "turn_retry" && e.event.action === "retry")).toBe(false);
    await waitFor(() => events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === queued.queueItemId));
    expect((await store.getQueueItem(session.id, queued.queueItemId))?.outcome?.outcome).toBe("completed");
    expect(await store.listUnsettledSubmissions(session.id)).toEqual([]);
    const next = await session.prompt("fresh request", { author: { id: "u" } });
    await waitFor(() => events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === next.queueItemId));
    expect((await store.getQueueItem(session.id, next.queueItemId))?.outcome?.outcome).toBe("completed");
    const entries = await session.readEntries("web:default");
    expect(entries.some((e) => e.type === "message" && e.queueItemId === next.queueItemId && e.content === "fresh response")).toBe(true);
    faux.unregister();
  });

  it("a person's prompt retries a transient error briefly and completes", async () => {
    const faux = registerFauxProvider({
      provider: "retry-interactive",
      models: [{ id: "m", name: "m", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: Overloaded" }),
      fauxAssistantMessage("recovered response"),
    ]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("m")!,
      purpose: "interactive",
      turnRetry: { backoffMs: [1] },
    });
    const receipt = await session.prompt("do the thing", { author: { id: "u" } });
    await waitFor(() => events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId));
    expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome?.outcome).toBe("completed");
    const retries = events.filter((e) => e.event.type === "turn_retry" && e.event.action === "retry");
    expect(retries).toHaveLength(1);
    const entries = await store.getEntries(session.id, receipt.threadId);
    const lastAssistant = [...entries].reverse().find((e) => e.type === "message" && e.role === "assistant");
    expect(lastAssistant?.type === "message" && lastAssistant.content).toBe("recovered response");
    faux.unregister();
  });

  it("waits the provider's short hint before a person's retry", async () => {
    const faux = registerFauxProvider({
      provider: "retry-interactive-hint",
      models: [{ id: "m", name: "m", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Rate limit reached. Please try again in 300ms." }),
      fauxAssistantMessage("after the hint"),
    ]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel("m")!,
      purpose: "interactive", turnRetry: { backoffMs: [1] },
    });
    const started = Date.now();
    const receipt = await session.prompt("do the thing", { author: { id: "u" } });
    await waitFor(() => events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId));
    // The 1ms backoff alone would retry at once; the provider asked for 300ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome?.outcome).toBe("completed");
    faux.unregister();
  });

  it("does not retry a person's prompt past the provider's long hint", async () => {
    const faux = registerFauxProvider({
      provider: "retry-interactive-long-hint",
      models: [{ id: "m", name: "m", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Rate limit reached. Please try again in 6m0s." }),
      fauxAssistantMessage("must not run"),
    ]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel("m")!,
      purpose: "interactive", turnRetry: { backoffMs: [1] },
    });
    const receipt = await session.prompt("do the thing", { author: { id: "u" } });
    await waitFor(() => events.some((e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId));
    expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome?.outcome).toBe("failed");
    expect(events.some((e) => e.event.type === "turn_retry" && e.event.action === "retry")).toBe(false);
    expect(faux.getPendingResponseCount()).toBe(1);
    faux.unregister();
  });

  it("keeps the provider error on the failed assistant entry for a reload", async () => {
    const faux = registerFauxProvider({
      provider: "retry-error-entry",
      models: [{ id: "m", name: "m", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    const providerError =
      "429 Rate limit reached for m on tokens per min (TPM): Limit 30000, Used 29000, Requested 2500. Please try again in 2.5s.";
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: providerError })]);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("m")!,
      purpose: "interactive",
      turnRetry: { maxAttempts: 0 },
    });
    const receipt = await session.prompt("do the thing");
    await waitFor(() =>
      events.some((e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId),
    );
    const entries = await session.readEntries(receipt.threadId);
    const failed = entries.find((e): e is MessageEntry => e.type === "message" && e.role === "assistant");
    expect(failed?.stopReason).toBe("error");
    expect(failed?.metadata?.[MESSAGE_TURN_ERROR_KEY]).toBe(providerError);
    faux.unregister();
  });
});
