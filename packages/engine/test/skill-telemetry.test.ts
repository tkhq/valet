import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type SkillContextAttributionFact,
  type SkillInvocationFact,
  type SkillSource,
  type ToolDef,
  skillInvocationsInContext,
} from "../src/index.js";

function skill(invocation: "context" | "prompt" = "context"): SkillSource {
  return {
    name: "review",
    content: "Review the change.",
    source: "user",
    key: "stored:skill-1",
    storedSkillId: "skill-1",
    contentSha: "sha-1",
    origin: "local",
    invocation,
  };
}

function harness() {
  const store = new InMemorySessionStore();
  const stream = new InMemoryEventStream();
  const events: BusEvent[] = [];
  const invocations: SkillInvocationFact[] = [];
  const attributions: SkillContextAttributionFact[] = [];
  stream.subscribe({}, (event) => events.push(event));
  const engine = new Engine({
    providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() },
  });
  return {
    engine,
    events,
    invocations,
    attributions,
    skillTelemetry: {
      recordInvocation: async (fact: SkillInvocationFact) => {
        invocations.push(fact);
      },
      recordContextAttributions: async (facts: SkillContextAttributionFact[]) => {
        attributions.push(...facts);
      },
    },
  };
}

async function waitForIdle(events: BusEvent[], threadId: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    if (
      events.some(
        ({ event }) =>
          event.type === "status" &&
          event.threadId === threadId &&
          event.status === "idle",
      )
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out while waiting for the telemetry test session to become idle.");
}

describe("skill usage telemetry", () => {
  it("restores only skill bodies that compaction kept in live context", () => {
    const fact: SkillInvocationFact = {
      id: "ski-1", createdAt: 1, sessionId: "s1", threadId: "t1",
      invokerUserId: "u1", invocationEntryId: null, path: "slash_context",
      skillKey: "stored:skill-1", skillName: "review", storedSkillId: "skill-1",
      pluginName: null, origin: "local", contentSha: "sha-1",
      injectedCharacters: 18, estimatedBodyTokens: 5,
    };
    const message = {
      id: "entry-1", sessionId: "s1", threadId: "t1", parentId: null,
      type: "message" as const, role: "user" as const, content: "Review the change.",
      metadata: { skillInvocation: fact }, createdAt: 1,
    };
    expect(skillInvocationsInContext([message])).toEqual([fact]);
    expect(skillInvocationsInContext([
      message,
      {
        id: "compact-1", sessionId: "s1", threadId: "t1", parentId: null,
        type: "compaction", summary: "Earlier work.", coveredEntryIds: ["entry-1"],
        tokenCountBefore: 10, tokenCountAfter: 2, createdAt: 2,
      },
    ])).toEqual([]);
  });
  it.each([
    ["context", "slash_context"],
    ["prompt", "slash_prompt"],
  ] as const)("records slash %s invocations before their first model request", async (invocation, path) => {
    const faux = registerFauxProvider({ provider: `skill-slash-${invocation}` });
    faux.setResponses([fauxAssistantMessage("done")]);
    const h = harness();
    const session = await h.engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      skills: [skill(invocation)],
      skillTelemetry: h.skillTelemetry,
    });

    const receipt = await session.prompt("/skill:review", {
      author: { id: "u1", name: "User" },
    });
    await waitForIdle(h.events, receipt.threadId);

    expect(h.invocations).toHaveLength(1);
    expect(h.invocations[0]).toMatchObject({
      path,
      skillKey: "stored:skill-1",
      invokerUserId: "u1",
    });
    expect(h.attributions).toHaveLength(1);
    expect(h.attributions[0]?.skillInvocationId).toBe(h.invocations[0]?.id);
    faux.unregister();
  });

  it("records Thread.skill as actorless when the host supplies no author", async () => {
    const faux = registerFauxProvider({ provider: "skill-host" });
    faux.setResponses([fauxAssistantMessage("done")]);
    const h = harness();
    const session = await h.engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      skills: [skill()],
      skillTelemetry: h.skillTelemetry,
    });

    const receipt = await session.thread().skill("review");
    await waitForIdle(h.events, receipt.threadId);

    expect(h.invocations[0]).toMatchObject({
      path: "host_thread_skill",
      invokerUserId: null,
    });
    expect(h.attributions).toHaveLength(1);
    faux.unregister();
  });

  it("does not attribute a queued slash skill to the turn that is already running", async () => {
    const faux = registerFauxProvider({ provider: "skill-queued" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("pause", {}, { id: "pause-call" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage("skill done"),
    ]);
    let releasePause: (() => void) | undefined;
    let startedPause: (() => void) | undefined;
    const pauseStarted = new Promise<void>((resolve) => {
      startedPause = resolve;
    });
    const pauseReleased = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const pause: ToolDef = {
      name: "pause",
      description: "Pause this test turn.",
      parameters: Type.Object({}),
      execute: async () => {
        startedPause?.();
        await pauseReleased;
        return { text: "continue" };
      },
    };
    const h = harness();
    const session = await h.engine.createSession({
      userId: "u1", orgId: "o1", workspace: "/workspace", sandbox: {},
      model: faux.getModel(), tools: [pause], skills: [skill()],
      skillTelemetry: h.skillTelemetry,
    });
    await session.prompt("Start the first turn.", { author: { id: "u1" } });
    await pauseStarted;
    const skillReceipt = await session.prompt("/skill:review", { author: { id: "u1" } });
    releasePause?.();
    await session.thread().awaitResult(skillReceipt.queueItemId, { timeoutMs: 5_000 });

    expect(h.invocations).toHaveLength(1);
    expect(h.attributions).toHaveLength(1);
    expect(h.attributions[0]?.skillInvocationId).toBe(h.invocations[0]?.id);
    faux.unregister();
  });

  it("attributes a model-tool skill only to later requests that carry its result", async () => {
    const faux = registerFauxProvider({ provider: "skill-tool" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("load_review", {}, { id: "skill-call" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const loadedSkill = skill();
    const tool: ToolDef = {
      name: "load_review",
      description: "Load review instructions.",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        await ctx.recordSkillInvocation?.(loadedSkill, "model_tool", loadedSkill.content);
        return { text: loadedSkill.content };
      },
    };
    const h = harness();
    const session = await h.engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      tools: [tool],
      skillTelemetry: h.skillTelemetry,
    });

    const receipt = await session.prompt("Review this.", { author: { id: "u1" } });
    await waitForIdle(h.events, receipt.threadId);

    expect(h.invocations).toHaveLength(1);
    expect(h.invocations[0]).toMatchObject({ path: "model_tool" });
    expect(h.invocations[0]?.id).toContain(":skill-call");
    expect(h.attributions).toHaveLength(1);
    expect(h.attributions[0]?.skillInvocationId).toBe(h.invocations[0]?.id);
    faux.unregister();
  });
});
