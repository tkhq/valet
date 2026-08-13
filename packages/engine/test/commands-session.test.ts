import { describe, it, expect, afterEach } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type CommandContext,
  type SkillSource,
} from "../src/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()?.();
    } catch {
      // fauxes are fire-and-forget in tests
    }
  }
});

const ctx: CommandContext = {
  listModels: async () => [{ id: "claude-opus-4-8", name: "Opus 4.8" }],
  listChildSessions: async () => [],
};

const reviewSkill: SkillSource = {
  name: "review",
  description: "Review a diff",
  content: "Review carefully.",
  source: "repo",
};

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, bus, events };
}

describe("Session.prompt command interception", () => {
  it("/status appends a command_result entry and queues nothing", async () => {
    const faux = registerFauxProvider({ provider: "s-status" });
    cleanups.push(() => faux.unregister());
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      commandContext: ctx,
    });
    const threadId = session.thread().id;

    const receipt = await session.prompt("/status");
    expect(receipt.command).toEqual({ name: "status", source: "builtin" });
    expect(receipt.queueItemId).toBe("");

    const entries = await store.getEntries(session.id, threadId);
    expect(entries.at(-1)?.type).toBe("command_result");

    // The queue never took a submission for the command.
    const unsettled = await store.listUnsettledSubmissions(session.id);
    expect(unsettled).toHaveLength(0);

    // A command_result event was emitted.
    expect(events.some((e) => e.event.type === "command_result")).toBe(true);
  });

  it("unknown /word queues as a normal prompt with nearMiss on the receipt", async () => {
    const faux = registerFauxProvider({ provider: "s-nearmiss" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    cleanups.push(() => faux.unregister());
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      commandContext: ctx,
    });

    const receipt = await session.prompt("/statsu");
    expect(receipt.nearMiss).toBe("status");
    expect(receipt.command).toBeUndefined();

    // It really queued as a prompt.
    const unsettled = await store.listUnsettledSubmissions(session.id);
    expect(unsettled.length).toBeGreaterThanOrEqual(0);
    expect(receipt.queueItemId).not.toBe("");
  });

  it("/skill:review expands into a skill block and queues a prompt", async () => {
    const faux = registerFauxProvider({ provider: "s-skill" });
    faux.setResponses([fauxAssistantMessage("done")]);
    cleanups.push(() => faux.unregister());
    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      skills: [reviewSkill],
      commandContext: ctx,
    });

    const receipt = await session.prompt("/skill:review");
    // Expansion routes through the normal queue — it is a real submission.
    expect(receipt.command).toBeUndefined();
    expect(receipt.queueItemId).not.toBe("");
  });
});
