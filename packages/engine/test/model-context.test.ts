import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pi from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  loadRoleFromMarkdown,
  type PromptOptions,
  type ResolvedModel,
  type Session,
} from "../src/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const small = pi.registerFauxProvider({ provider: "model-context-small" });
  const medium = pi.registerFauxProvider({ provider: "model-context-medium" });
  cleanups.push(() => small.unregister(), () => medium.unregister());
  const store = new InMemorySessionStore();
  const providers = {
    store,
    stream: new InMemoryEventStream(),
    sandboxProvider: new VirtualSandboxProvider(),
  };
  const engine = new Engine({ providers });
  const prompts: string[] = [];
  const capture = (reply: pi.AssistantMessage = pi.fauxAssistantMessage("done")) =>
    (ctx: pi.Context) => {
      prompts.push(getCurrentSystemPrompt(ctx.messages));
      return reply;
    };
  const resolveModel = async (spec: string): Promise<ResolvedModel | null> => {
    if (spec === "s") return { model: small.getModel() };
    if (spec === "m") return { model: medium.getModel() };
    return null;
  };
  const options = {
    userId: "u1", orgId: "o1", workspace: "/", sandbox: {},
    model: small.getModel(), modelSpec: "s", resolveModel,
    systemPrompt: "Base instructions.",
  };
  return { engine, providers, store, small, medium, prompts, capture, options };
}

async function run(session: Session, opts: PromptOptions = {}) {
  const thread = await session.ensureDefaultThread();
  const receipt = await thread.submitPrompt("work", opts);
  const result = await thread.awaitResult(receipt.queueItemId, { timeoutMs: 3000 });
  expect(result.outcome).toBe("completed");
}

const switchTo = (model: string) => pi.fauxAssistantMessage(
  [pi.fauxToolCall("switch_model", { model })], { stopReason: "toolUse" },
);

describe("runtime model context delivered to the provider", () => {
  it("reports assignment and actual model without changing stored instructions or transcript", async () => {
    const s = setup();
    s.small.setResponses([s.capture(), s.capture()]);
    const session = await s.engine.createSession(s.options);
    await run(session);
    await run(session);

    const prompt = s.prompts[0];
    expect(prompt).toContain("Base instructions.\n\n## Thread started");
    expect(prompt).toContain("\n\n## Runtime model");
    expect(prompt).toContain("Assigned selection: s");
    expect(prompt).toContain("Active selection: s");
    expect(prompt).toContain("Current provider: model-context-small");
    expect(prompt).toContain("Current model: faux-1");
    expect(prompt).toContain("Temporary override: none");
    expect(prompt?.match(/## Runtime model/g)).toHaveLength(1);
    expect(s.prompts[1]).toBe(prompt);
    expect(session.options.systemPrompt).toBe("Base instructions.");
    expect(JSON.stringify(await session.readEntries("web:default"))).not.toContain("## Runtime model");
  });

  it("reports a switch on the next call and resets to the assignment next turn", async () => {
    const s = setup();
    s.small.setResponses([s.capture(switchTo("m")), s.capture()]);
    s.medium.setResponses([s.capture()]);
    const session = await s.engine.createSession(s.options);
    await run(session);
    await run(session);

    expect(s.prompts).toHaveLength(3);
    expect(s.prompts[1]).toContain("Assigned selection: s");
    expect(s.prompts[1]).toContain("Active selection: m");
    expect(s.prompts[1]).toContain("Current provider: model-context-medium");
    expect(s.prompts[1]).toContain("Temporary override: switch_model; expires when this turn ends");
    expect(s.prompts[1]?.match(/## Runtime model/g)).toHaveLength(1);
    expect(s.prompts[2]).toBe(s.prompts[0]);
    const thread = await session.ensureDefaultThread();
    expect((await s.store.getThread(session.id, thread.id))?.model).toBe("s");
  });

  it("keeps the context unchanged when a switch fails", async () => {
    const s = setup();
    s.small.setResponses([s.capture(switchTo("unavailable")), s.capture()]);
    const session = await s.engine.createSession(s.options);
    await run(session);

    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[1]).toBe(s.prompts[0]);
    expect(s.prompts[1]).toContain("Active selection: s");
    expect(s.prompts[1]).toContain("Temporary override: none");
  });

  it("reports a submission assignment over the thread pin", async () => {
    const s = setup();
    s.medium.setResponses([s.capture()]);
    const session = await s.engine.createSession(s.options);
    await run(session, { model: "m" });

    expect(s.prompts[0]).toContain("Assigned selection: m");
    expect(s.prompts[0]).toContain("Active selection: m");
    expect(s.prompts[0]).toContain("Current provider: model-context-medium");
    expect(s.prompts[0]).toContain("Temporary override: submission model; expires when this turn ends");
  });

  it("uses the persisted thread assignment after restore", async () => {
    const s = setup();
    s.medium.setResponses([s.capture()]);
    const session = await s.engine.createSession(s.options);
    const thread = await session.ensureDefaultThread();
    await thread.setModel("m");
    const restored = await new Engine({ providers: s.providers }).restoreSession({
      sessionId: session.id, options: s.options,
    });
    await run(restored);

    expect(s.prompts[0]).toContain("Assigned selection: m");
    expect(s.prompts[0]).toContain("Current provider: model-context-medium");
    expect(s.prompts[0]).toContain("Temporary override: none");
  });

  it("keeps this turn's assignment when the user changes the next turn's pin", async () => {
    const s = setup();
    const session = await s.engine.createSession(s.options);
    const thread = await session.ensureDefaultThread();
    s.small.setResponses([
      async (ctx) => {
        s.prompts.push(getCurrentSystemPrompt(ctx.messages));
        await thread.setModel("m", "set_via_api");
        return pi.fauxAssistantMessage([pi.fauxToolCall("list_threads", {})], { stopReason: "toolUse" });
      },
      s.capture(),
    ]);
    s.medium.setResponses([s.capture()]);
    await run(session);
    await run(session);

    expect(s.prompts).toHaveLength(3);
    expect(s.prompts[1]).toBe(s.prompts[0]);
    expect(s.prompts[1]).toContain("Assigned selection: s");
    expect(s.prompts[1]).toContain("Current provider: model-context-small");
    expect(s.prompts[2]).toContain("Assigned selection: m");
    expect(s.prompts[2]).toContain("Current provider: model-context-medium");
  });

  it("preserves a concrete assignment without guessing a tier", async () => {
    const s = setup();
    s.small.setResponses([s.capture()]);
    const session = await s.engine.createSession({
      ...s.options, modelSpec: "custom-provider/concrete-id",
      resolveModel: async () => ({ model: s.small.getModel() }),
    });
    await run(session);

    expect(s.prompts[0]).toContain("Assigned selection: custom-provider/concrete-id");
    expect(s.prompts[0]).toContain("Current provider: model-context-small");
    expect(s.prompts[0]).toContain("Current model: faux-1");
    expect(s.prompts[0]).not.toContain("Assigned selection: s");
  });

  it("reports a successful role override and an agent switch over it, then clears both", async () => {
    const s = setup();
    // Roles use the static model catalog. Intercept that model's API at the
    // transport boundary so the actual role lookup runs without network I/O.
    const roleModel = pi.getModel("anthropic", "claude-opus-4-7");
    const originalApi = pi.getApiProvider(roleModel.api);
    const fauxApi = pi.getApiProvider(s.medium.api);
    if (!originalApi || !fauxApi) throw new Error("test provider is not registered");
    pi.registerApiProvider({
      api: roleModel.api,
      stream: (model, context, options) => fauxApi.stream({ ...model, api: s.medium.api }, context, options),
      streamSimple: (model, context, options) => fauxApi.streamSimple({ ...model, api: s.medium.api }, context, options),
    });
    cleanups.push(() => pi.registerApiProvider(originalApi));
    s.medium.setResponses([s.capture(switchTo("s"))]);
    s.small.setResponses([s.capture(), s.capture()]);
    const session = await s.engine.createSession({
      ...s.options,
      roles: [loadRoleFromMarkdown("---\nname: reviewer\ndescription: Review code\nmodel: anthropic/claude-opus-4-7\n---\nReview instructions.")],
    });
    await run(session, { role: "reviewer" });
    await run(session);

    expect(s.prompts[0]).toContain("Assigned selection: s");
    expect(s.prompts[0]).toContain("Active selection: anthropic/claude-opus-4-7");
    expect(s.prompts[0]).toContain("Current provider: anthropic");
    expect(s.prompts[0]).toContain("Current model: claude-opus-4-7");
    expect(s.prompts[0]).toContain("Temporary override: role model; expires when this turn ends");
    expect(s.prompts[1]).toContain("Active selection: s");
    expect(s.prompts[1]).toContain("Current provider: model-context-small");
    expect(s.prompts[1]).toContain("Temporary override: switch_model; expires when this turn ends");
    expect(s.prompts[2]).toContain("Temporary override: none");
    expect(s.prompts[2]).not.toContain("Review instructions.");
    expect(s.prompts[2]).not.toContain("anthropic/claude-opus-4-7");
  });

  it("does not claim a role model whose lookup fails", async () => {
    const s = setup();
    s.small.setResponses([s.capture()]);
    const session = await s.engine.createSession({
      ...s.options,
      roles: [loadRoleFromMarkdown("---\nname: reviewer\ndescription: Review code\nmodel: unknown-role/missing\n---\nReview instructions.")],
    });
    await run(session, { role: "reviewer" });

    expect(s.prompts[0]).toContain("Active selection: s");
    expect(s.prompts[0]).toContain("Current provider: model-context-small");
    expect(s.prompts[0]).toContain("Temporary override: none");
  });

  describe("thread started block (TKAI-584)", () => {
    // Mon 2026-10-12 09:35 PDT = 16:35 UTC. Fixed value, no real clock in assertions.
    const T0 = Date.UTC(2026, 9, 12, 16, 35, 20);
    const block = (prompt: string | undefined) => prompt?.match(/## Thread started[\s\S]*?(?=\n\n## Runtime model)/)?.[0];

    async function startedAt(s: ReturnType<typeof setup>, userTimezone?: string) {
      const session = await s.engine.createSession({ ...s.options, ...(userTimezone ? { userTimezone } : {}) });
      const thread = await session.ensureDefaultThread();
      const data = await s.store.getThread(session.id, thread.id);
      await s.store.saveThread(session.id, { ...data!, createdAt: T0 });
      // Restore without the timezone option: the thread's own persisted state must supply it.
      return new Engine({ providers: s.providers }).restoreSession({ sessionId: session.id, options: s.options });
    }

    it("renders the persisted creation time with weekday, UTC and user-local time", async () => {
      const s = setup();
      s.small.setResponses([s.capture()]);
      await run(await startedAt(s, "America/Los_Angeles"));

      const b = block(s.prompts[0]);
      expect(b).toContain("Thread started (UTC): 2026-10-12T16:35:00Z (Monday)");
      expect(b).toContain("Thread started (user local): Monday 2026-10-12 09:35 PDT (America/Los_Angeles)");
      expect(b).toContain("It is not the current time");
      expect(b).toContain("date the snapshot was built");
      expect(b).not.toContain("older");
      expect(b).not.toContain("Current time");
      expect(b).toContain("date -u");
    });

    it("is byte-identical across calls", async () => {
      const s = setup();
      s.small.setResponses([s.capture(), s.capture()]);
      const session = await startedAt(s, "America/Los_Angeles");
      await run(session);
      await run(session);

      expect(block(s.prompts[0])).toBeDefined();
      expect(block(s.prompts[1])).toBe(block(s.prompts[0]));
      expect(s.prompts[1]).toBe(s.prompts[0]);
      expect(JSON.stringify(await session.readEntries("web:default"))).not.toContain("Thread started");
    });

    it("survives a restart with the same bytes", async () => {
      const s = setup();
      s.small.setResponses([s.capture(), s.capture()]);
      await run(await startedAt(s, "America/Los_Angeles"));
      const again = await new Engine({ providers: s.providers }).restoreSession({
        sessionId: (await s.store.listSessions("u1"))[0]!.id,
        options: s.options,
      });
      await run(again);

      expect(block(s.prompts[1])).toBe(block(s.prompts[0]));
    });

    it("takes the start time from the persisted createdAt after a rebuild, not from when the agent was built", async () => {
      const s = setup();
      s.small.setResponses([s.capture(), s.capture()]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      const session = await startedAt(s, "America/Los_Angeles");
      await run(session);
      // Three days later a new engine rehydrates the thread and builds a new agent.
      vi.setSystemTime(T0 + 3 * 24 * 3_600_000);
      const rebuilt = await new Engine({ providers: s.providers }).restoreSession({ sessionId: session.id, options: s.options });
      await run(rebuilt);

      expect(block(s.prompts[1])).toContain("Thread started (UTC): 2026-10-12T16:35:00Z (Monday)");
      expect(s.prompts[1]).toBe(s.prompts[0]);
    });

    it("stamps the timezone at creation: a later change leaves the thread alone and a new thread uses it", async () => {
      const s = setup();
      s.small.setResponses([s.capture(), s.capture(), s.capture()]);
      let zone: string | undefined = "America/Los_Angeles";
      const options = { ...s.options, userTimezone: zone, resolveUserTimezone: async () => zone };
      const session = await s.engine.createSession(options);
      const first = await session.ensureDefaultThread();
      const stored = await s.store.getThread(session.id, first.id);
      await s.store.saveThread(session.id, { ...stored!, createdAt: T0 });

      zone = "Asia/Tokyo";
      const restored = await new Engine({ providers: s.providers }).restoreSession({ sessionId: session.id, options });
      const existing = await restored.ensureDefaultThread();
      await existing.awaitResult((await existing.submitPrompt("work", {})).queueItemId, { timeoutMs: 3000 });
      const next = await restored.createThread("web:second");
      await next.awaitResult((await next.submitPrompt("work", {})).queueItemId, { timeoutMs: 3000 });

      expect(block(s.prompts[0])).toContain("Monday 2026-10-12 09:35 PDT (America/Los_Angeles)");
      expect(block(s.prompts[1])).toContain("(Asia/Tokyo)");
      expect(block(s.prompts[1])).not.toContain("America/Los_Angeles");
    });

    it("keeps the last known timezone when the resolver fails", async () => {
      const s = setup();
      s.small.setResponses([s.capture()]);
      const session = await s.engine.createSession({
        ...s.options, userTimezone: "Europe/Paris", resolveUserTimezone: async () => { throw new Error("db down"); },
      });
      const thread = await session.createThread("web:second");
      await thread.awaitResult((await thread.submitPrompt("work", {})).queueItemId, { timeoutMs: 3000 });
      expect(block(s.prompts[0])).toContain("(Europe/Paris)");
    });

    it("states the timezone is unknown when unset or invalid", async () => {
      for (const tz of [undefined, "Not/AZone"]) {
        const s = setup();
        s.small.setResponses([s.capture()]);
        await run(await startedAt(s, tz));
        expect(block(s.prompts[0])).toContain("Thread started (user local): unknown");
        expect(block(s.prompts[0])).toContain("Do not guess it");
      }
    });

    /**
     * Serialize a captured engine transcript through the real pi-ai Anthropic
     * serializer, without a network call. `onPayload` runs after `buildParams`
     * and before the request, so it sees the exact `system`, `tools` and
     * `messages` with their `cache_control` markers.
     */
    async function anthropicPayload(ctx: pi.Context): Promise<AnthropicPayload> {
      let captured: AnthropicPayload | undefined;
      const stream = pi.streamSimple(pi.getModel("anthropic", "claude-opus-4-7"), ctx, {
        apiKey: "sk-ant-test",
        cacheRetention: "long",
        onPayload: (params) => {
          captured = structuredClone(params) as AnthropicPayload;
          throw new Error("stop before the network");
        },
      });
      await stream.result();
      if (!captured) throw new Error("the Anthropic serializer did not run");
      return captured;
    }

    interface AnthropicBlock { cache_control?: unknown; [key: string]: unknown }
    interface AnthropicPayload {
      system?: AnthropicBlock[];
      tools?: AnthropicBlock[];
      messages: Array<{ role: string; content: string | AnthropicBlock[] }>;
    }

    const withoutCacheMarkers = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value, (key, v) => (key === "cache_control" ? undefined : v)));

    it("keeps the serialized Anthropic system block and history cache prefix identical across calls at different clock times", async () => {
      const s = setup();
      const ctxs: pi.Context[] = [];
      const record = (reply: pi.AssistantMessage) => (ctx: pi.Context) => {
        ctxs.push(structuredClone(ctx));
        // Move the wall clock between model calls on the same thread.
        vi.setSystemTime(Date.now() + 25 * 60_000 + 24 * 3_600_000);
        return reply;
      };
      s.small.setResponses([
        record(pi.fauxAssistantMessage([pi.fauxToolCall("list_threads", {})], { stopReason: "toolUse" })),
        record(pi.fauxAssistantMessage("done")),
      ]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      const session = await s.engine.createSession({ ...s.options, userTimezone: "America/Los_Angeles" });
      await run(session);
      expect(ctxs).toHaveLength(2);

      const [first, second] = [await anthropicPayload(ctxs[0]!), await anthropicPayload(ctxs[1]!)];

      // Sanity: the clock moved, and the payload is one system block with a cache marker after it.
      expect(Date.now()).toBeGreaterThan(T0 + 24 * 3_600_000);
      expect(first.system).toHaveLength(1);
      expect(first.system![0]!.cache_control).toBeDefined();
      expect(String(first.system![0]!.text)).toContain("Thread started (UTC): 2026-10-12T16:35:00Z (Monday)");

      // The full system block (text and cache marker) and the tools are byte-identical.
      expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));
      expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));

      // The history prefix call 1 cached is byte-identical in call 2. Only the marker moves to the new tail.
      expect(second.messages.length).toBeGreaterThan(first.messages.length);
      expect(JSON.stringify(withoutCacheMarkers(second.messages.slice(0, first.messages.length))))
        .toBe(JSON.stringify(withoutCacheMarkers(first.messages)));
      const marked = (p: AnthropicPayload) => JSON.stringify(p.messages).split('"cache_control"').length - 1;
      expect(marked(first)).toBe(1);
      expect(marked(second)).toBe(1);
    });

    it("keeps the whole Runtime model section unchanged between calls in steady state", async () => {
      const s = setup();
      const record = (reply: pi.AssistantMessage) => (ctx: pi.Context) => {
        s.prompts.push(getCurrentSystemPrompt(ctx.messages));
        vi.setSystemTime(Date.now() + 25 * 60_000);
        return reply;
      };
      s.small.setResponses([
        record(pi.fauxAssistantMessage([pi.fauxToolCall("list_threads", {})], { stopReason: "toolUse" })),
        record(pi.fauxAssistantMessage("done")),
        record(pi.fauxAssistantMessage("done")),
      ]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      const session = await s.engine.createSession({ ...s.options, userTimezone: "America/Los_Angeles" });
      await run(session);
      await run(session);

      const runtime = (prompt: string | undefined) => prompt?.slice(prompt.indexOf("## Runtime model"));
      expect(s.prompts).toHaveLength(3);
      expect(runtime(s.prompts[0])).toContain("Temporary override: none");
      expect(runtime(s.prompts[1])).toBe(runtime(s.prompts[0]));
      expect(runtime(s.prompts[2])).toBe(runtime(s.prompts[0]));
      expect(s.prompts[2]).toBe(s.prompts[0]);
    });
  });
});
