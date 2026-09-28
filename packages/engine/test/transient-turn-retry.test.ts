/**
 * Turn-level transient-error retry (TKAI-319): unattended sessions re-run a
 * turn that settled with a transient provider error; interactive sessions
 * surface it untouched.
 */
import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
} from "@earendil-works/pi-ai/compat";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  formatTransientRetryMessage,
  type BusEvent,
  type ToolDef,
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

// Message copy the retry event carries (TKAI-325). The old text embedded
// the provider's raw JSON error blob verbatim and named no corrective
// action — these tests pin the replacement.
describe("formatTransientRetryMessage (TKAI-325)", () => {
  const rawAnthropicError =
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CeecukWxUPBswkk1ZCLgg"}';

  it("names the upstream cause, the wait, the counter, and the corrective action — never the raw JSON", () => {
    const msg = formatTransientRetryMessage({
      provider: "anthropic",
      errorMessage: rawAnthropicError,
      waitMs: 30_000,
      attempt: 2,
      maxAttempts: 2,
    });
    expect(msg).toContain("Anthropic's API");
    expect(msg).toContain("30s");
    expect(msg).toContain("attempt 2/2");
    expect(msg).toContain("If retries fail");
    expect(msg).toContain("switch to a different model");
    expect(msg).toContain("req_011CeecukWxUPBswkk1ZCLgg");
    // No raw JSON — a support escalation only needs the request id.
    expect(msg).not.toContain('"type":"error"');
    expect(msg).not.toContain("overloaded_error");
    expect(msg).not.toContain("{");
  });

  it("omits the request ID clause when the upstream error carries none", () => {
    const msg = formatTransientRetryMessage({
      provider: "openai",
      errorMessage: "429 rate limit exceeded",
      waitMs: 10_000,
      attempt: 1,
      maxAttempts: 2,
    });
    expect(msg).toContain("Openai's API");
    expect(msg).toContain("If retries fail, switch to a different model");
    expect(msg).not.toContain("request ID");
  });

  it("handles a missing error message without crashing", () => {
    const msg = formatTransientRetryMessage({
      provider: "anthropic",
      errorMessage: undefined,
      waitMs: 10_000,
      attempt: 1,
      maxAttempts: 2,
    });
    expect(msg).toContain("Anthropic's API");
    expect(msg).toContain("attempt 1/2");
    expect(msg).not.toContain("request ID");
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
    // The retry announced itself with human-readable text — no raw JSON,
    // provider named, corrective action stated (TKAI-325).
    const retryEvent = events.find(
      (e) => e.event.type === "error" && e.event.code === "turn_transient_retry",
    )?.event;
    expect(retryEvent).toBeDefined();
    if (retryEvent && retryEvent.type === "error") {
      expect(retryEvent.error).toContain("API");
      expect(retryEvent.error).toContain("If retries fail");
      expect(retryEvent.error).not.toContain('"type":"error"');
      expect(retryEvent.error).not.toContain("{");
    }
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
          (e) => e.event.type === "error" && e.event.code === "turn_transient_retry",
        ).length >= 2,
    );
    const retries = events.filter(
      (e) => e.event.type === "error" && e.event.code === "turn_transient_retry",
    );
    expect(retries).toHaveLength(2);
    faux.unregister();
  });

  it("keeps a fallback tool result and does not retry after its provider error", async () => {
    const primary = registerFauxProvider({
      provider: "failover-primary-tool",
      models: [{ id: "m", name: "m", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    const fallback = registerFauxProvider({
      provider: "failover-fallback-tool",
      models: [{ id: "m", name: "m", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    primary.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "no credits remaining" }),
      fauxAssistantMessage("must not run"),
    ]);
    fallback.setResponses([
      fauxAssistantMessage([fauxToolCall("mark", {}, { id: "mark-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
    ]);
    let toolCalls = 0;
    const markerTool: ToolDef = {
      name: "mark",
      description: "records a side effect",
      parameters: Type.Object({}),
      execute: async () => {
        toolCalls++;
        return { text: "marked" };
      },
    };
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: primary.getModel("m")!,
      purpose: "child",
      turnRetry: { maxAttempts: 1, backoffMs: [1] },
      tools: [markerTool],
      resolveModelFailover: async () => ({ candidates: [{ model: fallback.getModel("m")! }], enabled: true }),
    });
    const receipt = await session.prompt("run the marker");
    await waitFor(() =>
      events.filter((e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId).length >= 2,
    );

    expect(toolCalls).toBe(1);
    expect(primary.getPendingResponseCount()).toBe(1);
    const entries = await store.getEntries(session.id, receipt.threadId);
    const toolAssistant = entries.find((entry) =>
      entry.type === "message" && entry.role === "assistant" && entry.parts?.some((part) => part.type === "tool_call"),
    );
    expect(toolAssistant).toBeDefined();
    if (toolAssistant?.type !== "message") throw new Error("missing tool assistant message");
    const toolCall = toolAssistant.parts?.find((part) => part.type === "tool_call");
    expect(toolCall).toMatchObject({ status: "completed", result: { text: "marked" } });
    const lastAssistant = [...entries].reverse().find(
      (entry) => entry.type === "message" && entry.role === "assistant",
    );
    expect(lastAssistant).toMatchObject({ stopReason: "error" });
    expect(events.some((e) => e.event.type === "error" && e.event.code === "turn_transient_retry")).toBe(false);
    primary.unregister();
    fallback.unregister();
  });


  it("surfaces an actionable error when no equivalent candidate exists", async () => {
    const faux = registerFauxProvider({ provider: "failover-none" });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "no credits remaining" }),
    ]);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(),
      resolveModelFailover: async () => ({ candidates: [], enabled: true }),
    });
    const receipt = await session.prompt("help");
    await waitFor(() => events.some((event) =>
      event.event.type === "error" && event.event.code === "model_failover_unavailable" && event.event.threadId === receipt.threadId,
    ));
    const errors = events.filter((event) => event.event.type === "error").map((event) =>
      event.event.type === "error" ? event.event.error : "",
    );
    expect(errors.some((error) =>
      error.includes("The selected model (failover-none/") &&
      error.includes("No equivalent model is available.") &&
      error.includes("Select another model in the model picker."),
    )).toBe(true);
    expect(errors).not.toContain("no credits remaining");
    faux.unregister();
  });

  it("surfaces the disabled fallback state instead of the provider exhaustion text", async () => {
    const faux = registerFauxProvider({ provider: "failover-disabled" });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "no credits remaining" }),
    ]);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(),
      resolveModelFailover: async () => ({ candidates: [], enabled: false }),
    });
    await session.prompt("help");
    await waitFor(() => events.some((event) =>
      event.event.type === "error" && event.event.code === "model_failover_unavailable",
    ));
    const unavailable = events.find((event) =>
      event.event.type === "error" && event.event.code === "model_failover_unavailable",
    )?.event;
    expect(unavailable?.type === "error" && unavailable.error).toContain("Provider fallback is disabled.");
    faux.unregister();
  });

  it("surfaces an actionable error after every fallback candidate is unusable", async () => {
    const primary = registerFauxProvider({ provider: "failover-exhausted-primary" });
    const fallback = registerFauxProvider({ provider: "failover-exhausted-fallback" });
    primary.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "no credits remaining" })]);
    fallback.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" })]);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: primary.getModel(),
      resolveModelFailover: async () => ({ candidates: [{ model: fallback.getModel() }], enabled: true }),
    });
    await session.prompt("help");
    await waitFor(() => events.some((event) =>
      event.event.type === "error" && event.event.code === "model_failover_unavailable",
    ));
    expect(events.filter((event) => event.event.type === "error" && event.event.code === "model_failover_unavailable")).toHaveLength(1);
    primary.unregister();
    fallback.unregister();
  });

  it("uses a user-selected model on the turn after failover exhaustion", async () => {
    const failed = registerFauxProvider({ provider: "failover-switch-failed" });
    const selected = registerFauxProvider({ provider: "failover-switch-selected" });
    failed.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "no credits remaining" })]);
    selected.setResponses([fauxAssistantMessage("switched model succeeded")]);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: failed.getModel(), modelSpec: "failed",
      resolveModel: async (spec) => spec === "failed"
        ? { model: failed.getModel() }
        : spec === "selected" ? { model: selected.getModel() } : null,
      resolveModelFailover: async () => ({ candidates: [], enabled: true }),
    });
    const thread = await session.ensureDefaultThread();
    const first = await thread.submitPrompt("fail", {});
    await waitFor(() => events.some((event) =>
      event.event.type === "error" && event.event.code === "model_failover_unavailable" && event.event.threadId === first.threadId,
    ));
    await thread.setModel("selected");
    const second = await thread.submitPrompt("succeed", {});
    await waitFor(() => events.some((event) =>
      event.event.type === "turn_end" && event.event.threadId === second.threadId && event.event.reason === "end_turn",
    ));
    const entries = await thread.readEntries();
    expect(entries.at(-1)).toMatchObject({ type: "message", role: "assistant", content: "switched model succeeded" });
    failed.unregister();
    selected.unregister();
  });

  it("an interactive session does not auto-retry", async () => {
    const faux = registerFauxProvider({
      provider: "retry-interactive",
      models: [{ id: "m", name: "m", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: Overloaded" }),
    ]);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("m")!,
      purpose: "interactive",
    });
    const receipt = await session.prompt("do the thing");
    await waitFor(() =>
      events.some((e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId),
    );
    expect(
      events.some((e) => e.event.type === "error" && e.event.code === "turn_transient_retry"),
    ).toBe(false);
    expect(faux.getPendingResponseCount()).toBe(0);
    faux.unregister();
  });
});
