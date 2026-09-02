/**
 * Turn-level transient-error retry (TKAI-319): unattended sessions re-run a
 * turn that settled with a transient provider error; interactive sessions
 * surface it untouched.
 */
import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  getModel,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
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
    // The retry announced itself.
    expect(
      events.some((e) => e.event.type === "error" && e.event.code === "turn_transient_retry"),
    ).toBe(true);
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

  it("fails over to an equivalent model on another provider from attempt 2 (TKAI-326)", async () => {
    const primary = registerFauxProvider({
      provider: "failover-primary",
      models: [{ id: "pm", name: "pm", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    const backup = registerFauxProvider({
      provider: "failover-backup",
      models: [{ id: "bm", name: "bm", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    const err = () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: Overloaded" });
    primary.setResponses([err, err]); // initial call + the attempt-1 same-model retry
    backup.setResponses([fauxAssistantMessage("failover response")]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: primary.getModel("pm")!,
      modelSpec: "failover-primary/pm",
      purpose: "child",
      turnRetry: { maxAttempts: 2, backoffMs: [1, 1] },
      resolveModel: async (spec) => {
        if (spec === "failover-primary/pm")
          return { model: primary.getModel("pm")!, canonicalId: spec };
        if (spec === "failover-backup/bm")
          return { model: backup.getModel("bm")!, canonicalId: spec };
        return null;
      },
      resolveFailoverModels: async () => ["failover-backup/bm"],
    });
    const receipt = await session.prompt("do the thing");
    await waitFor(() => backup.getPendingResponseCount() === 0);
    await waitFor(
      () =>
        events.filter((e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId)
          .length >= 2,
    );

    const entries = await store.getEntries(session.id, receipt.threadId);
    const lastAssistant = [...entries]
      .reverse()
      .find((e) => e.type === "message" && e.role === "assistant");
    expect(lastAssistant?.type === "message" && lastAssistant.content).toBe("failover response");
    const failovers = events.filter((e) => e.event.type === "turn_failover");
    expect(failovers).toHaveLength(1);
    expect(failovers[0]!.event).toMatchObject({
      threadId: receipt.threadId,
      fromModel: "failover-primary/pm",
      toModel: "failover-backup/bm",
    });
    // Attempt 1 was still a same-model retry.
    expect(
      events.filter((e) => e.event.type === "error" && e.event.code === "turn_transient_retry"),
    ).toHaveLength(1);

    // Per-turn only: the NEXT turn resolves the original spec and runs on
    // the primary again (its queue holds the only pending response).
    primary.setResponses([fauxAssistantMessage("back on primary")]);
    const receipt2 = await session.prompt("again");
    await waitFor(() => primary.getPendingResponseCount() === 0);
    await waitFor(
      () =>
        events.filter((e) => e.event.type === "turn_end" && e.event.threadId === receipt2.threadId)
          .length >= 1,
    );
    const entries2 = await store.getEntries(session.id, receipt2.threadId);
    const lastAssistant2 = [...entries2]
      .reverse()
      .find((e) => e.type === "message" && e.role === "assistant");
    expect(lastAssistant2?.type === "message" && lastAssistant2.content).toBe("back on primary");
    primary.unregister();
    backup.unregister();
  });

  it("allowProviderFailover: false keeps every retry on the original model", async () => {
    const primary = registerFauxProvider({
      provider: "failover-optout",
      models: [{ id: "pm", name: "pm", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    const err = () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: Overloaded" });
    primary.setResponses([err, err, err]); // initial + 2 same-model retries
    let lookups = 0;
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: primary.getModel("pm")!,
      purpose: "child",
      turnRetry: { maxAttempts: 2, backoffMs: [1, 1] },
      allowProviderFailover: false,
      resolveFailoverModels: async () => {
        lookups++;
        return ["anywhere/else"];
      },
    });
    await session.prompt("do the thing");
    await waitFor(() => primary.getPendingResponseCount() === 0);
    await waitFor(
      () =>
        events.filter((e) => e.event.type === "error" && e.event.code === "turn_transient_retry")
          .length >= 2,
    );
    expect(lookups).toBe(0);
    expect(events.some((e) => e.event.type === "turn_failover")).toBe(false);
    primary.unregister();
  });

  it("skips unusable failover candidates and lands on the first resolvable one", async () => {
    const primary = registerFauxProvider({
      provider: "failover-skip-primary",
      models: [{ id: "pm", name: "pm", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    const backup = registerFauxProvider({
      provider: "failover-skip-backup",
      models: [{ id: "bm", name: "bm", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    const err = () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: Overloaded" });
    primary.setResponses([err, err]);
    backup.setResponses([fauxAssistantMessage("second candidate wins")]);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: primary.getModel("pm")!,
      modelSpec: "failover-skip-primary/pm",
      purpose: "child",
      turnRetry: { maxAttempts: 2, backoffMs: [1, 1] },
      resolveModel: async (spec) => {
        if (spec === "failover-skip-primary/pm")
          return { model: primary.getModel("pm")!, canonicalId: spec };
        if (spec === "failover-skip-backup/bm")
          return { model: backup.getModel("bm")!, canonicalId: spec };
        if (spec === "dead/candidate") throw new Error("provider dead is disabled");
        return null;
      },
      resolveFailoverModels: async () => ["unknown/candidate", "dead/candidate", "failover-skip-backup/bm"],
    });
    const receipt = await session.prompt("do the thing");
    await waitFor(() => backup.getPendingResponseCount() === 0);
    await waitFor(() =>
      events.some((e) => e.event.type === "turn_failover" && e.event.threadId === receipt.threadId),
    );
    const failover = events.find((e) => e.event.type === "turn_failover");
    expect(failover?.event.type === "turn_failover" && failover.event.toModel).toBe(
      "failover-skip-backup/bm",
    );
    primary.unregister();
    backup.unregister();
  });

  it("failover reasons about a role's model override, not the layered default", async () => {
    // A role's model frontmatter mutates the streaming model directly —
    // `turnModelSpec` cannot see it. Failover must ask for equivalents of
    // the model that is REALLY failing (the role's), or it can hand the
    // turn back to the melting-down provider. Shadow the role model's api
    // with a scripted faux so the builtin registry model streams our
    // responses (a later registerApiProvider registration wins).
    const roleModel = getModel("openai", "gpt-4.1")!;
    const shadow = registerFauxProvider({ api: roleModel.api, provider: "openai" });
    const err = () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: Overloaded" });
    shadow.setResponses([err, err]); // role-model call + attempt-1 retry
    const sessionDefault = registerFauxProvider({
      provider: "failover-role-primary",
      models: [{ id: "pm", name: "pm", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    const backup = registerFauxProvider({
      provider: "failover-role-backup",
      models: [{ id: "bm", name: "bm", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    backup.setResponses([fauxAssistantMessage("role failover response")]);
    const specsSeen: string[] = [];
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: sessionDefault.getModel("pm")!,
      modelSpec: "failover-role-primary/pm",
      purpose: "child",
      turnRetry: { maxAttempts: 2, backoffMs: [1, 1] },
      roles: [{ name: "cheap", content: "Prefer the cheap model.", model: "openai/gpt-4.1" }],
      resolveModel: async (spec) => {
        if (spec === "failover-role-primary/pm")
          return { model: sessionDefault.getModel("pm")!, canonicalId: spec };
        if (spec === "failover-role-backup/bm")
          return { model: backup.getModel("bm")!, canonicalId: spec };
        return null;
      },
      resolveFailoverModels: async (spec) => {
        specsSeen.push(spec);
        return ["failover-role-backup/bm"];
      },
    });
    const receipt = await session.prompt("do the thing", { role: "cheap" });
    await waitFor(() => backup.getPendingResponseCount() === 0);
    await waitFor(() =>
      events.some((e) => e.event.type === "turn_failover" && e.event.threadId === receipt.threadId),
    );
    // The candidate lookup and the event both name the role's model — the
    // one that actually failed — not the session default.
    expect(specsSeen).toEqual(["openai/gpt-4.1"]);
    const failover = events.find((e) => e.event.type === "turn_failover");
    expect(failover?.event.type === "turn_failover" && failover.event.fromModel).toBe(
      "openai/gpt-4.1",
    );
    shadow.unregister();
    sessionDefault.unregister();
    backup.unregister();
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
