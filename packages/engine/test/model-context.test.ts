import { afterEach, describe, expect, it } from "vitest";
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
      prompts.push(ctx.systemPrompt ?? "");
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
    expect(prompt).toContain("Base instructions.\n\n## Runtime model");
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
        s.prompts.push(ctx.systemPrompt ?? "");
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
});
