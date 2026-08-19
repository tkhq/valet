import { describe, it, expect, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { Context } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  buildRepoInstructionsFragment,
  type BusEvent,
  type RepoInstructions,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "../src/index.js";

// ── Fake sandbox + provider (same idiom as lazy-attachment.test.ts) ──

function makeFakeSandbox(id: string): Sandbox {
  return {
    id,
    readFile: async (path: string) => {
      throw new Error(`ENOENT: no such file: ${path}`);
    },
    readBinary: async (_path: string) => new Uint8Array(),
    writeFile: async (_path: string, _content: string) => {},
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
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class FakeProvider implements SandboxProvider {
  readonly backend = "fake";
  private nextId = 1;
  private pending: Array<Deferred<Sandbox>> = [];

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
      coldStartEstimateMs: 5000,
    };
  }

  nextDeferred(): Deferred<Sandbox> {
    const d = defer<Sandbox>();
    this.pending.push(d);
    return d;
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
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

function makeEngine(sandboxProvider: SandboxProvider) {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({
    providers: { store, stream: bus, sandboxProvider },
  });
  return { engine, events };
}

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

async function waitForAsync(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitForAsync: timed out");
}

// ── Fragment builder (pure) ──

describe("buildRepoInstructionsFragment", () => {
  it("frames content with the preamble and its user-precedence sentence", () => {
    const fragment = buildRepoInstructionsFragment({ content: "Run make test.", nestedPaths: [] });
    expect(fragment).toContain("AGENTS.md instructions for coding agents");
    expect(fragment).toContain("Explicit user instructions in the conversation override them.");
    expect(fragment).toContain("Run make test.");
    expect(fragment).not.toContain("Other AGENTS.md files");
  });

  it("lists nested paths with the closest-file-wins rule, after the content", () => {
    const fragment = buildRepoInstructionsFragment({
      content: "ROOT-RULES",
      nestedPaths: ["/workspace/repo/packages/a/AGENTS.md", "/workspace/repo/packages/b/AGENTS.md"],
    });
    expect(fragment).toContain("- /workspace/repo/packages/a/AGENTS.md");
    expect(fragment).toContain("- /workspace/repo/packages/b/AGENTS.md");
    expect(fragment).toContain("the closest one to the edited file wins");
    expect(fragment.indexOf("ROOT-RULES")).toBeLessThan(fragment.indexOf("Other AGENTS.md files"));
  });

  it("carries only the nested list when the root has no file", () => {
    const fragment = buildRepoInstructionsFragment({
      content: "",
      nestedPaths: ["/workspace/repo/sub/AGENTS.md"],
    });
    expect(fragment).toContain("Other AGENTS.md files");
    expect(fragment).toContain("- /workspace/repo/sub/AGENTS.md");
  });

  it("returns empty for empty instructions", () => {
    expect(buildRepoInstructionsFragment({ content: "", nestedPaths: [] })).toBe("");
    expect(buildRepoInstructionsFragment({ content: "  \n ", nestedPaths: ["  "] })).toBe("");
  });
});

// ── Turn integration ──

describe("repo instructions turn overlay", () => {
  it("loads once ready and composes base → instructions → role; cold turn runs without it", async () => {
    const faux = registerFauxProvider({ provider: "agents1" });
    const capturedPrompts: (string | undefined)[] = [];
    const captureStep = (text: string) => async (context: Context) => {
      capturedPrompts.push(context.systemPrompt);
      return fauxAssistantMessage(text);
    };
    faux.setResponses([captureStep("first (cold)"), captureStep("second (warm)")]);

    const provider = new FakeProvider();
    const d = provider.nextDeferred();
    const { engine, events } = makeEngine(provider);

    const instructions: RepoInstructions = {
      content: "AGENTS-CONTENT",
      nestedPaths: ["/workspace/repo/sub/AGENTS.md"],
    };
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      systemPrompt: "base system prompt",
      roles: [{ name: "helper", content: "ROLE-TEXT" }],
      repoInstructionsProvider: async () => instructions,
    });

    // Turn 1 runs before the attachment is ready — no fragment (graceful
    // degradation, agents-md spec decision 4).
    const receipt1 = await session.prompt("first", { role: "helper" });
    await waitForStatus(events, receipt1.threadId, "idle");
    expect(capturedPrompts[0]).toContain("base system prompt");
    expect(capturedPrompts[0]).not.toContain("AGENTS-CONTENT");

    d.resolve(makeFakeSandbox("sb-1"));
    await waitForAsync(() => session.attachment.state === "ready");

    const fromIndex = events.length;
    const receipt2 = await session.prompt("second", { role: "helper" });
    await waitForStatus(events, receipt2.threadId, "idle", 2000, fromIndex);

    const prompt = capturedPrompts[1];
    expect(prompt).toContain("AGENTS-CONTENT");
    expect(prompt).toContain("/workspace/repo/sub/AGENTS.md");
    expect(prompt).toContain("ROLE-TEXT");
    // Composition order: base → repo instructions → role overlay.
    expect(prompt!.indexOf("base system prompt")).toBeLessThan(prompt!.indexOf("AGENTS-CONTENT"));
    expect(prompt!.indexOf("AGENTS-CONTENT")).toBeLessThan(prompt!.indexOf("ROLE-TEXT"));

    faux.unregister();
  });

  it("snapshots at turn start: a new value lands only after an explicit refresh", async () => {
    const faux = registerFauxProvider({ provider: "agents2" });
    const capturedPrompts: (string | undefined)[] = [];
    const captureStep = (text: string) => async (context: Context) => {
      capturedPrompts.push(context.systemPrompt);
      return fauxAssistantMessage(text);
    };
    faux.setResponses([
      captureStep("t1"),
      captureStep("t2"),
      captureStep("t3"),
      captureStep("t4"),
    ]);

    const provider = new FakeProvider();
    const d = provider.nextDeferred();
    const { engine, events } = makeEngine(provider);

    let current: RepoInstructions = { content: "VERSION-A", nestedPaths: [] };
    const providerSpy = vi.fn(async () => current);
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      systemPrompt: "base",
      repoInstructionsProvider: providerSpy,
    });

    // Warm up: turn 1 kicks provisioning; resolve and wait for ready.
    const receipt1 = await session.prompt("one");
    await waitForStatus(events, receipt1.threadId, "idle");
    d.resolve(makeFakeSandbox("sb-1"));
    await waitForAsync(() => session.attachment.state === "ready");

    // Turn 2: first load — VERSION-A.
    let fromIndex = events.length;
    const receipt2 = await session.prompt("two");
    await waitForStatus(events, receipt2.threadId, "idle", 2000, fromIndex);
    expect(capturedPrompts[1]).toContain("VERSION-A");

    // The provider now serves VERSION-B, but without a refresh the session
    // keeps its loaded snapshot — no per-turn re-read.
    current = { content: "VERSION-B", nestedPaths: [] };
    fromIndex = events.length;
    const receipt3 = await session.prompt("three");
    await waitForStatus(events, receipt3.threadId, "idle", 2000, fromIndex);
    expect(capturedPrompts[2]).toContain("VERSION-A");
    expect(capturedPrompts[2]).not.toContain("VERSION-B");

    // An explicit refresh (what the host's ready-transition hook does)
    // replaces the reference; the next turn carries VERSION-B.
    await session.refreshRepoInstructions();
    fromIndex = events.length;
    const receipt4 = await session.prompt("four");
    await waitForStatus(events, receipt4.threadId, "idle", 2000, fromIndex);
    expect(capturedPrompts[3]).toContain("VERSION-B");

    faux.unregister();
  });

  it("tolerates a throwing provider, then retries on the next turn", async () => {
    const faux = registerFauxProvider({ provider: "agents3" });
    const capturedPrompts: (string | undefined)[] = [];
    const captureStep = (text: string) => async (context: Context) => {
      capturedPrompts.push(context.systemPrompt);
      return fauxAssistantMessage(text);
    };
    faux.setResponses([captureStep("t1"), captureStep("t2")]);

    const provider = new FakeProvider();
    const d = provider.nextDeferred();
    d.resolve(makeFakeSandbox("sb-1"));
    const { engine, events } = makeEngine(provider);

    let shouldFail = true;
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      systemPrompt: "base",
      repoInstructionsProvider: async () => {
        if (shouldFail) throw new Error("scan exec failed");
        return { content: "AGENTS-CONTENT", nestedPaths: [] };
      },
    });
    await session.attachment.ensureReady({ timeoutMs: 2000 });

    // Turn 1: provider throws — the turn still runs, without the fragment.
    const receipt1 = await session.prompt("one");
    await waitForStatus(events, receipt1.threadId, "idle");
    expect(capturedPrompts[0]).toContain("base");
    expect(capturedPrompts[0]).not.toContain("AGENTS-CONTENT");

    // Turn 2: the failed load left the loaded flag unset, so ensure retries.
    shouldFail = false;
    const fromIndex = events.length;
    const receipt2 = await session.prompt("two");
    await waitForStatus(events, receipt2.threadId, "idle", 2000, fromIndex);
    expect(capturedPrompts[1]).toContain("AGENTS-CONTENT");

    faux.unregister();
  });

  it("caches a null result: a workspace without instructions is scanned once, not per turn", async () => {
    const faux = registerFauxProvider({ provider: "agents4" });
    faux.setResponses([fauxAssistantMessage("t1"), fauxAssistantMessage("t2")]);

    const provider = new FakeProvider();
    const d = provider.nextDeferred();
    d.resolve(makeFakeSandbox("sb-1"));
    const { engine, events } = makeEngine(provider);

    const providerSpy = vi.fn(async () => null);
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      systemPrompt: "base",
      repoInstructionsProvider: providerSpy,
    });
    await session.attachment.ensureReady({ timeoutMs: 2000 });

    const receipt1 = await session.prompt("one");
    await waitForStatus(events, receipt1.threadId, "idle");
    const fromIndex = events.length;
    const receipt2 = await session.prompt("two");
    await waitForStatus(events, receipt2.threadId, "idle", 2000, fromIndex);

    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(session.repoInstructions()).toBeNull();

    faux.unregister();
  });
});
