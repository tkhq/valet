import { describe, it, expect, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@mariozechner/pi-ai";
import type { Context } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "../src/index.js";

// ── Fake sandbox + provider (delayed create, matches sandbox-attachment.test.ts idiom) ──

function makeFakeSandbox(id: string): Sandbox {
  const files = new Map<string, string>();
  return {
    id,
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: no such file: ${path}`);
      return content;
    },
    readBinary: async (_path: string) => new Uint8Array(),
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    writeBinary: async (_path: string, _data: Uint8Array) => {},
    readdir: async (_path: string) => [],
    stat: async (_path: string) => ({ isFile: true, isDirectory: false, size: 0 }),
    mkdir: async (_path: string) => {},
    rm: async (_path: string) => {},
    exec: async (_command: string) => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** FakeProvider whose `create` resolves on command via an exposed deferred
 * queue — same idiom as sandbox-attachment.test.ts's FakeProvider. */
class FakeProvider implements SandboxProvider {
  readonly backend = "fake";
  createCalls = 0;
  private nextId = 1;
  private pending: Array<Deferred<Sandbox>> = [];
  private caps: SandboxCapabilities;

  constructor(caps: Partial<SandboxCapabilities> = {}) {
    this.caps = {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      coldStartEstimateMs: 5000,
      ...caps,
    };
  }

  capabilities(): SandboxCapabilities {
    return this.caps;
  }

  nextDeferred(): Deferred<Sandbox> {
    const d = defer<Sandbox>();
    this.pending.push(d);
    return d;
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls++;
    const d = this.pending.shift();
    if (!d) return makeFakeSandbox(`fake-${this.nextId++}`);
    return d.promise;
  }

  async restore(id: string): Promise<Sandbox> {
    return makeFakeSandbox(id);
  }

  async destroy(_id: string): Promise<void> {}

  async status(id: string): Promise<SandboxStatus> {
    return { id, state: "ready" };
  }
}

function makeEngine(sandboxProvider: SandboxProvider = new VirtualSandboxProvider()) {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({
    providers: { store, stream: bus, sandboxProvider },
  });
  return { engine, store, bus, events, sandboxProvider };
}

/**
 * Waits for a status event of the given kind for `threadId`. `events` is a
 * cumulative live-subscriber array (never trimmed), so a caller that waits
 * for the SAME status on the SAME thread more than once (e.g. two "idle"
 * turns) must pass `fromIndex` — otherwise a stale event from an earlier
 * turn satisfies the wait instantly.
 */
async function waitForStatus(
  events: BusEvent[],
  threadId: string,
  status: string,
  timeoutMs = 2000,
  fromIndex = 0,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events
        .slice(fromIndex)
        .some((e) => e.event.type === "status" && e.event.threadId === threadId && e.event.status === status);
      if (found) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for status=${status}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function waitForAsync(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitForAsync: timed out");
}

describe("lazy sandbox attachment integration", () => {
  it("1. instant agent: first message_start/text_delta arrive while attachment is still provisioning", async () => {
    const faux = registerFauxProvider({ provider: "lazy1" });
    faux.setResponses([fauxAssistantMessage("hello while cold")]);

    const provider = new FakeProvider();
    provider.nextDeferred(); // create() never resolves during this test
    const { engine, events } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    const receipt = await session.prompt("say hi");
    // Wait for the first message_start / text_delta to land.
    await waitForAsync(() =>
      events.some((e) => e.event.type === "message_start" && e.event.threadId === receipt.threadId),
    );
    await waitForAsync(() => events.some((e) => e.event.type === "text_delta"));

    // Provider create was kicked (warm-on-claim) but has not resolved yet.
    expect(provider.createCalls).toBe(1);
    expect(session.attachment.state).toBe("provisioning");

    faux.unregister();
  });

  it("2. warm kicked on claim: zero creates after createSession, exactly one after a no-tool turn", async () => {
    const faux = registerFauxProvider({ provider: "lazy2" });
    faux.setResponses([fauxAssistantMessage("no tools here")]);

    const provider = new FakeProvider();
    const { engine, events } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });
    expect(provider.createCalls).toBe(0);

    const receipt = await session.prompt("say hi");
    await waitForStatus(events, receipt.threadId, "idle");

    expect(provider.createCalls).toBe(1);

    faux.unregister();
  });

  it("3. cold hint composes with role overlay and disappears once ready", async () => {
    const faux = registerFauxProvider({ provider: "lazy3" });
    const capturedPrompts: (string | undefined)[] = [];
    const captureStep = (text: string) => async (context: Context) => {
      capturedPrompts.push(context.systemPrompt);
      return fauxAssistantMessage(text);
    };
    faux.setResponses([captureStep("first (cold)"), captureStep("second (warm)")]);

    const provider = new FakeProvider();
    const d = provider.nextDeferred();
    const { engine, events } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      systemPrompt: "base system prompt",
      roles: [{ name: "helper", content: "ROLE-TEXT" }],
    });

    const receipt1 = await session.prompt("first", { role: "helper" });
    await waitForStatus(events, receipt1.threadId, "idle");

    expect(capturedPrompts[0]).toContain("[workspace status]");
    expect(capturedPrompts[0]).toContain("ROLE-TEXT");
    expect(capturedPrompts[0]).toContain("base system prompt");

    // Let the sandbox become ready before the second turn.
    d.resolve(makeFakeSandbox("sb-1"));
    await waitForAsync(() => session.attachment.state === "ready");

    const fromIndex = events.length;
    const receipt2 = await session.prompt("second", { role: "helper" });
    await waitForStatus(events, receipt2.threadId, "idle", 2000, fromIndex);

    expect(capturedPrompts[1]).not.toContain("[workspace status]");
    expect(capturedPrompts[1]).toContain("ROLE-TEXT");

    faux.unregister();
  });

  it("4. tool waits then succeeds once create resolves mid-turn", async () => {
    const faux = registerFauxProvider({ provider: "lazy4" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "/note.txt" }, { id: "tc1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("read it"),
    ]);

    const provider = new FakeProvider();
    const d = provider.nextDeferred();
    const { engine, events } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    const sb = makeFakeSandbox("sb-1");
    await sb.writeFile("/note.txt", "hello from sandbox");
    setTimeout(() => d.resolve(sb), 100);

    const receipt = await session.prompt("read the note");
    await waitForStatus(events, receipt.threadId, "idle");

    const entries = await session.readEntries("web:default");
    const assistant = entries.find((e) => e.type === "message" && e.role === "assistant" && e.queueItemId === receipt.queueItemId);
    if (assistant?.type !== "message") throw new Error("unreachable");
    const toolCallPart = assistant.parts?.find((p) => p.type === "tool_call");
    if (toolCallPart?.type !== "tool_call") throw new Error("unreachable");
    expect(toolCallPart.status).toBe("completed");
    const resultObj = toolCallPart.result as { text?: unknown };
    expect(resultObj.text).toContain("hello from sandbox");

    faux.unregister();
  });

  it("5. tool provisioning-timeout: structured error, turn still completes, submission settles completed", async () => {
    const faux = registerFauxProvider({ provider: "lazy5" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "/note.txt" }, { id: "tc1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("gave up"),
    ]);

    const provider = new FakeProvider();
    provider.nextDeferred(); // never resolves
    const { engine, events, bus } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      sandboxReadyTimeoutMs: 100,
    });

    const receipt = await session.prompt("read the note");
    await waitForStatus(events, receipt.threadId, "idle");

    const entries = await session.readEntries("web:default");
    const assistant = entries.find((e) => e.type === "message" && e.role === "assistant" && e.queueItemId === receipt.queueItemId);
    if (assistant?.type !== "message") throw new Error("unreachable");
    const toolCallPart = assistant.parts?.find((p) => p.type === "tool_call");
    if (toolCallPart?.type !== "tool_call") throw new Error("unreachable");
    expect(toolCallPart.status).toBe("error");
    const resultObj = toolCallPart.result as { text?: unknown };
    expect(String(resultObj.text ?? "")).toContain("[workspace_provisioning]");

    expect(events.some((e) => e.event.type === "turn_end")).toBe(true);

    await waitForAsync(async () => {
      const { events: log } = await bus.read(session.id);
      const settled = log.find((e) => e.event.type === "submission_settled" && e.event.queueItemId === receipt.queueItemId);
      return (
        settled !== undefined &&
        settled.event.type === "submission_settled" &&
        settled.event.outcome.outcome === "completed"
      );
    });

    faux.unregister();
  });

  it("6. sandbox_status durable log has provisioning then ready exactly once each per epoch", async () => {
    const faux = registerFauxProvider({ provider: "lazy6" });
    faux.setResponses([fauxAssistantMessage("hi"), fauxAssistantMessage("hi again")]);

    const provider = new FakeProvider();
    const d = provider.nextDeferred();
    const { engine, events, bus } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    const receipt = await session.prompt("say hi");
    setTimeout(() => d.resolve(makeFakeSandbox("sb-1")), 20);
    await waitForStatus(events, receipt.threadId, "idle");
    await waitForAsync(() => session.attachment.state === "ready");

    // Re-emit the same transitions again (idempotency check): construct a
    // second prompt after ready — no new sandbox_status of the same key.
    const fromIndex = events.length;
    const receipt2 = await session.prompt("say hi again");
    await waitForStatus(events, receipt2.threadId, "idle", 2000, fromIndex);

    const { events: log } = await bus.read(session.id);
    const sandboxEvents = log.filter((e) => e.event.type === "sandbox_status");
    const provisioningEvents = sandboxEvents.filter(
      (e) => e.event.type === "sandbox_status" && e.event.state === "provisioning" && e.event.epoch === 1,
    );
    const readyEvents = sandboxEvents.filter(
      (e) => e.event.type === "sandbox_status" && e.event.state === "ready" && e.event.epoch === 1,
    );
    expect(provisioningEvents).toHaveLength(1);
    expect(readyEvents).toHaveLength(1);

    faux.unregister();
  });

  it("7. toData().sandboxId is undefined before provision, set after ready", async () => {
    const faux = registerFauxProvider({ provider: "lazy7" });
    faux.setResponses([fauxAssistantMessage("hi")]);

    const provider = new FakeProvider();
    const d = provider.nextDeferred();
    const { engine, events } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
    });

    expect((await session.toData()).sandboxId).toBeUndefined();

    const receipt = await session.prompt("say hi");
    d.resolve(makeFakeSandbox("sb-ready"));
    await waitForStatus(events, receipt.threadId, "idle");
    await waitForAsync(() => session.attachment.state === "ready");

    expect((await session.toData()).sandboxId).toBe("sb-ready");

    faux.unregister();
  });

  it("8. warmSandboxOnClaim:false — no-tool turn triggers zero creates and no cold hint", async () => {
    const faux = registerFauxProvider({ provider: "lazy8" });
    const capturedPrompts: (string | undefined)[] = [];
    const captureStep = (text: string) => async (context: Context) => {
      capturedPrompts.push(context.systemPrompt);
      return fauxAssistantMessage(text);
    };
    faux.setResponses([captureStep("no tools here")]);

    const provider = new FakeProvider();
    const { engine, events } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      systemPrompt: "base system prompt",
      warmSandboxOnClaim: false,
    });
    expect(provider.createCalls).toBe(0);

    const receipt = await session.prompt("say hi");
    await waitForStatus(events, receipt.threadId, "idle");

    expect(provider.createCalls).toBe(0);
    expect(session.attachment.state).not.toBe("ready");
    expect(capturedPrompts[0]).not.toContain("[workspace status]");

    faux.unregister();
  });

  it("9. warmSandboxOnClaim:false — a turn whose tool reads a file still lazily provisions and succeeds", async () => {
    const faux = registerFauxProvider({ provider: "lazy9" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "/note.txt" }, { id: "tc1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("read it"),
    ]);

    const provider = new FakeProvider();
    const d = provider.nextDeferred();
    const { engine, events } = makeEngine(provider);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      warmSandboxOnClaim: false,
    });
    expect(provider.createCalls).toBe(0);

    const sb = makeFakeSandbox("sb-1");
    await sb.writeFile("/note.txt", "hello from sandbox");
    setTimeout(() => d.resolve(sb), 100);

    const receipt = await session.prompt("read the note");
    await waitForStatus(events, receipt.threadId, "idle");

    expect(provider.createCalls).toBe(1);

    const entries = await session.readEntries("web:default");
    const assistant = entries.find((e) => e.type === "message" && e.role === "assistant" && e.queueItemId === receipt.queueItemId);
    if (assistant?.type !== "message") throw new Error("unreachable");
    const toolCallPart = assistant.parts?.find((p) => p.type === "tool_call");
    if (toolCallPart?.type !== "tool_call") throw new Error("unreachable");
    expect(toolCallPart.status).toBe("completed");
    const resultObj = toolCallPart.result as { text?: unknown };
    expect(resultObj.text).toContain("hello from sandbox");

    faux.unregister();
  });
});
