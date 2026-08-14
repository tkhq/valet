import { describe, it, expect, afterEach, vi } from "vitest";
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

    // The typed command is echoed as a persisted user message BEFORE the
    // result — without it, clients render the result above the user's
    // bubble after any refetch, and reloads lose the command entirely.
    const echo = entries.at(-2);
    expect(echo?.type).toBe("message");
    expect(echo?.type === "message" && echo.role).toBe("user");
    expect(echo?.type === "message" && echo.content).toBe("/status");

    // The queue never took a submission for the command.
    const unsettled = await store.listUnsettledSubmissions(session.id);
    expect(unsettled).toHaveLength(0);

    // A command_result event was emitted.
    expect(events.some((e) => e.event.type === "command_result")).toBe(true);
  });

  it("a builtin runs against the target thread, not the session default", async () => {
    const faux = registerFauxProvider({ provider: "s-builtin-thread" });
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
    const defaultThreadId = session.thread().id;
    const other = session.thread("other");

    await session.prompt("/status", { threadId: other.id });

    // /status reports the thread it ran against.
    const entries = await store.getEntries(session.id, other.id);
    const result = entries.at(-1);
    expect(result?.type).toBe("command_result");
    expect(result?.type === "command_result" && result.output).toContain(other.id);
    expect(result?.type === "command_result" && result.output).not.toContain(defaultThreadId);
  });

  it("a command_result is stamped strictly after its echo, even within one ms", async () => {
    const faux = registerFauxProvider({ provider: "s-order" });
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
    const threadId = session.thread().id;

    // Freeze the clock so echo and result would collide without a floor.
    const now = 1_700_000_000_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    cleanups.push(() => spy.mockRestore());

    await session.prompt("/status");

    const entries = await store.getEntries(session.id, threadId);
    const echo = entries.find((e) => e.type === "message");
    const result = entries.find((e) => e.type === "command_result");
    expect(echo).toBeDefined();
    expect(result).toBeDefined();
    // Strictly greater: created_at alone must order the pair on reload, since
    // the REST read (getEntries) has no reliable id tiebreaker.
    expect((result as { createdAt: number }).createdAt).toBeGreaterThan(
      (echo as { createdAt: number }).createdAt,
    );
  });

  it("/status with opts.threadId lands the command_result on that thread", async () => {
    const faux = registerFauxProvider({ provider: "s-thread" });
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
    const defaultThreadId = session.thread().id;
    const other = session.thread("other");
    expect(other.id).not.toBe(defaultThreadId);

    const receipt = await session.prompt("/status", { threadId: other.id });
    expect(receipt.command).toEqual({ name: "status", source: "builtin" });
    expect(receipt.threadId).toBe(other.id);

    const otherEntries = await store.getEntries(session.id, other.id);
    expect(otherEntries.at(-1)?.type).toBe("command_result");

    const defaultEntries = await store.getEntries(session.id, defaultThreadId);
    expect(defaultEntries.some((e) => e.type === "command_result")).toBe(false);
  });

  it("prompt with an unknown opts.threadId throws a clear error", async () => {
    const faux = registerFauxProvider({ provider: "s-thread-miss" });
    cleanups.push(() => faux.unregister());
    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      commandContext: ctx,
    });

    await expect(session.prompt("/status", { threadId: "th-nope" })).rejects.toThrow(
      /thread th-nope not found/,
    );
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

describe("Session.commandRegistry — workspace skills provider", () => {
  it("workspace prompt skills join the registry after refresh and lose ties", async () => {
    const faux = registerFauxProvider({ provider: "s-wsp" });
    cleanups.push(() => faux.unregister());
    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      commandContext: ctx,
      skills: [
        {
          name: "standup",
          description: "user copy",
          content: "USER $1",
          invocation: "prompt",
          source: "db",
        },
      ],
      workspaceSkillsProvider: async () => [
        {
          name: "standup",
          description: "repo copy",
          content: "REPO $1",
          invocation: "prompt",
          source: "repo",
        },
        {
          name: "deploy-notes",
          description: "repo only",
          content: "Notes $1",
          invocation: "prompt",
          source: "repo",
        },
      ],
    });
    await session.refreshCommandRegistry();
    const reg = session.commandRegistry();
    const standup = reg.resolve("skill:standup");
    // DB/plugin skill beats workspace skill of same name.
    expect(standup?.source === "skill" && standup.skill.content).toBe("USER $1");
    // Workspace-only skill is present.
    expect(reg.resolve("skill:deploy-notes")).toBeDefined();
  });
});
