import { describe, it, expect, afterEach, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
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

  it("returns /compact before summarization and joins a duplicate", async () => {
    let releaseSummary!: () => void;
    let summaryStarted!: () => void;
    const summaryStartedPromise = new Promise<void>((resolve) => { summaryStarted = resolve; });
    const summaryRelease = new Promise<void>((resolve) => { releaseSummary = resolve; });
    let summaryCalls = 0;
    const faux = registerFauxProvider({
      provider: "s-compact-async",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      async () => {
        summaryCalls++;
        summaryStarted();
        await summaryRelease;
        return fauxAssistantMessage(
          "## Goal\n- test\n\n## Progress\n### Done\n- prior turns\n\n## Next Steps\n- continue",
        );
      },
    ]);
    cleanups.push(() => faux.unregister());
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: { tailTurns: 1, autoContinue: false },
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      { id: "u-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "first prompt", createdAt: 1 },
      { id: "a-1", sessionId: session.id, threadId: thread.id, parentId: "u-1", type: "message", role: "assistant", content: "first response", createdAt: 2 },
      { id: "u-2", sessionId: session.id, threadId: thread.id, parentId: "a-1", type: "message", role: "user", content: "second prompt", createdAt: 3 },
      { id: "a-2", sessionId: session.id, threadId: thread.id, parentId: "u-2", type: "message", role: "assistant", content: "second response", createdAt: 4 },
    ]);

    const first = await session.prompt("/compact");
    expect(first.command).toEqual({ name: "compact", source: "builtin", status: "started" });
    await summaryStartedPromise;
    expect(thread.isCompacting()).toBe(true);
    expect((await store.getEntries(session.id, thread.id)).some((e) => e.type === "command_result")).toBe(false);

    const second = await session.prompt("/compact keep decisions");
    expect(second.command?.status).toBe("started");
    expect(summaryCalls).toBe(1);
    expect(events.filter((e) => e.event.type === "compaction_start")).toHaveLength(1);

    releaseSummary();
    for (let attempt = 0; attempt < 100; attempt++) {
      const results = (await store.getEntries(session.id, thread.id)).filter(
        (e) => e.type === "command_result",
      );
      if (results.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(1);
    const results = entries.filter((e) => e.type === "command_result");
    expect(results).toHaveLength(2);
    expect(results[1]?.type === "command_result" && results[1].output).toContain(
      "already in progress",
    );
    expect(results[1]?.type === "command_result" && results[1].output).not.toContain(
      "keep decisions",
    );
    expect(events.filter((e) => e.event.type === "compaction_end")).toHaveLength(1);
    expect(thread.isCompacting()).toBe(false);
  });

  it("gives a manual join one lifecycle when a proactive owner exits as noop", async () => {
    const faux = registerFauxProvider({ provider: "s-compact-join-noop" });
    cleanups.push(() => faux.unregister());
    const { engine, store, bus, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = session.thread();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(store, "getEntries").mockImplementationOnce(async () => {
      entered();
      await blocked;
      return [];
    });
    let activeAtEnd: boolean | undefined;
    bus.subscribe({}, (event) => {
      if (event.event.type === "compaction_end") activeAtEnd = thread.isCompacting();
    });

    const proactive = thread.compactThread({ mode: "proactive" });
    await enteredPromise;
    expect(thread.isCompacting()).toBe(false);
    const receipt = await session.prompt("/compact use these new instructions");
    expect(receipt.command?.status).toBe("started");
    expect(thread.isCompacting()).toBe(true);
    release();
    await expect(proactive).resolves.toBe("noop");
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await store.getEntries(session.id, thread.id)).some((e) => e.type === "command_result")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const entries = await store.getEntries(session.id, thread.id);
    const result = entries.find((e) => e.type === "command_result");
    expect(result?.type === "command_result" && result.output).toContain("already in progress");
    expect(result?.type === "command_result" && result.output).not.toContain(
      "use these new instructions",
    );
    expect(events.filter((e) => e.event.type === "compaction_start")).toHaveLength(1);
    expect(events.filter((e) => e.event.type === "compaction_end")).toHaveLength(1);
    expect(activeAtEnd).toBe(false);
  });

  it("clears a manual join lifecycle when a proactive owner fails", async () => {
    const faux = registerFauxProvider({ provider: "s-compact-join-failure" });
    cleanups.push(() => faux.unregister());
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = session.thread();
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const blocked = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(store, "getEntries").mockImplementationOnce(async () => {
      entered();
      await blocked;
      return [];
    });

    const proactive = thread.compactThread({ mode: "proactive" });
    const proactiveFailure = expect(proactive).rejects.toThrow("owner failed");
    await enteredPromise;
    const receipt = await session.prompt("/compact ignored instructions");
    expect(receipt.command?.status).toBe("started");
    reject(new Error("owner failed"));
    await proactiveFailure;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await store.getEntries(session.id, thread.id)).some((e) => e.type === "command_result")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const entries = await store.getEntries(session.id, thread.id);
    const result = entries.find((e) => e.type === "command_result");
    expect(result?.type === "command_result" && result.ok).toBe(false);
    expect(result?.type === "command_result" && result.output).toContain("Retry /compact");
    expect(
      events.some((e) => e.event.type === "error" && e.event.code === "compaction_failed"),
    ).toBe(true);
    expect(events.filter((e) => e.event.type === "compaction_start")).toHaveLength(1);
    expect(events.filter((e) => e.event.type === "compaction_end")).toHaveLength(1);
    expect(thread.isCompacting()).toBe(false);
  });

  it("persists an actionable /compact failure and clears lifecycle state", async () => {
    const faux = registerFauxProvider({
      provider: "s-compact-failure",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "summarizer unavailable" }),
    ]);
    cleanups.push(() => faux.unregister());
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: { tailTurns: 1, autoContinue: false },
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      { id: "u-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "first prompt", createdAt: 1 },
      { id: "a-1", sessionId: session.id, threadId: thread.id, parentId: "u-1", type: "message", role: "assistant", content: "first response", createdAt: 2 },
      { id: "u-2", sessionId: session.id, threadId: thread.id, parentId: "a-1", type: "message", role: "user", content: "second prompt", createdAt: 3 },
      { id: "a-2", sessionId: session.id, threadId: thread.id, parentId: "u-2", type: "message", role: "assistant", content: "second response", createdAt: 4 },
    ]);

    const receipt = await session.prompt("/compact");
    expect(receipt.command?.status).toBe("started");
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await store.getEntries(session.id, thread.id)).some((e) => e.type === "command_result")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const entries = await store.getEntries(session.id, thread.id);
    const result = entries.find((e) => e.type === "command_result");
    expect(result?.type === "command_result" && result.ok).toBe(false);
    expect(result?.type === "command_result" && result.output).toContain("summarizer unavailable");
    expect(result?.type === "command_result" && result.output).toContain("Retry /compact");
    const error = events.find(
      (e) => e.event.type === "error" && e.event.code === "compaction_failed",
    );
    expect(error?.event.type === "error" && error.event.error).toContain("Retry /compact");
    expect(events.filter((e) => e.event.type === "compaction_start")).toHaveLength(1);
    expect(events.filter((e) => e.event.type === "compaction_end")).toHaveLength(1);
    expect(thread.isCompacting()).toBe(false);
    expect(entries.filter((e) => e.type === "message" && e.role === "assistant")).toHaveLength(2);
  });

  it("the echo carries the submitting author — an authorless echo renders as 'You' to every member of a shared session", async () => {
    const faux = registerFauxProvider({ provider: "s-echo-author" });
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

    await session.prompt("/status", {
      author: { id: "u2", name: "Bob", email: "bob@example.com" },
    });

    const entries = await store.getEntries(session.id, threadId);
    const echo = entries.find((e) => e.type === "message" && e.role === "user");
    expect(echo?.type === "message" && echo.author).toEqual({
      id: "u2",
      name: "Bob",
      email: "bob@example.com",
    });
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

describe("Session.commandRegistry — skills provider", () => {
  it("refresh replaces the skill set from skillsProvider", async () => {
    const faux = registerFauxProvider({ provider: "s-msp" });
    cleanups.push(() => faux.unregister());
    const { engine } = makeEngine();
    // The provider simulates the host re-reading the skills table: one skill
    // existed at build; a second was created (and the first renamed away)
    // while the session sat in the host cache.
    let stored: SkillSource[] = [
      { name: "old-skill", description: "at build", content: "OLD", source: "db" },
    ];
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      commandContext: ctx,
      skills: stored,
      skillsProvider: async () => stored,
    });

    // Before any refresh, the construction-time set serves.
    expect(session.commandRegistry().resolve("skill:old-skill")).toBeDefined();

    stored = [
      { name: "new-skill", description: "created later", content: "NEW", source: "db" },
    ];
    await session.refreshCommandRegistry();
    const reg = session.commandRegistry();
    expect(reg.resolve("skill:new-skill")).toBeDefined();
    // Replace, not merge: the renamed/deleted skill drops out.
    expect(reg.resolve("skill:old-skill")).toBeUndefined();
    // The `skill` tool's lookup map sees the same refreshed set.
    expect(session.skills.get("new-skill")?.content).toBe("NEW");
    expect(session.skills.has("old-skill")).toBe(false);
  });

  it("a throwing skillsProvider keeps the previous skill set serving", async () => {
    const faux = registerFauxProvider({ provider: "s-msp2" });
    cleanups.push(() => faux.unregister());
    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      commandContext: ctx,
      skills: [{ name: "kept", description: "still here", content: "KEPT", source: "db" }],
      skillsProvider: async () => {
        throw new Error("db unavailable");
      },
    });

    await expect(session.refreshCommandRegistry()).rejects.toThrow("db unavailable");
    expect(session.commandRegistry().resolve("skill:kept")).toBeDefined();
    expect(session.skills.get("kept")?.content).toBe("KEPT");
  });
});
