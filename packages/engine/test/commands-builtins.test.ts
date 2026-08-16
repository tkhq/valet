import { describe, it, expect, afterEach } from "vitest";
import { registerFauxProvider, type FauxProvider } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  executeBuiltin,
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

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, bus };
}

const ctx: CommandContext = {
  listModels: async () => [{ id: "claude-opus-4-8", name: "Opus 4.8" }],
  listChildSessions: async () => [{ id: "c1", title: "child", status: "idle" }],
};

const reviewSkill: SkillSource = {
  name: "review",
  description: "Review a diff",
  content: "Review carefully.",
  source: "repo",
};

async function makeSession(faux: FauxProvider) {
  const { engine } = makeEngine();
  return engine.createSession({
    userId: "u1",
    orgId: "o1",
    workspace: "/workspace",
    sandbox: {},
    model: faux.getModel(),
    skills: [reviewSkill],
  });
}

describe("executeBuiltin", () => {
  it("/help lists every registered command including skills", async () => {
    const faux = registerFauxProvider({ provider: "b-help" });
    cleanups.push(() => faux.unregister());
    const session = await makeSession(faux);

    const r = await executeBuiltin("help", [], session, ctx, session.thread());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("/status");
    expect(r.output).toContain("/skill:review");
  });

  it("/model with no args lists choices", async () => {
    const faux = registerFauxProvider({ provider: "b-model-list" });
    cleanups.push(() => faux.unregister());
    const session = await makeSession(faux);

    const r = await executeBuiltin("model", [], session, ctx, session.thread());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("claude-opus-4-8");
  });

  it("/model with an unknown id fails with close matches", async () => {
    const faux = registerFauxProvider({ provider: "b-model-bad" });
    cleanups.push(() => faux.unregister());
    const session = await makeSession(faux);

    const r = await executeBuiltin("model", ["claude-oups"], session, ctx, session.thread());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("claude-opus-4-8");
  });

  it("/model without a CommandContext refuses with an explicit message", async () => {
    const faux = registerFauxProvider({ provider: "b-model-noctx" });
    cleanups.push(() => faux.unregister());
    const session = await makeSession(faux);

    const r = await executeBuiltin("model", [], session, undefined, session.thread());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("does not expose");
  });

  it("/model with a valid id switches without a CommandContext", async () => {
    const faux = registerFauxProvider({ provider: "b-model-switch" });
    cleanups.push(() => faux.unregister());
    const session = await makeSession(faux);

    // A registry id resolves through the internal resolver; the switch needs
    // no CommandContext — only the no-args listing does.
    const r = await executeBuiltin("model", ["claude-opus-4-7"], session, undefined, session.thread());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Model switched");
  });

  it("/stop reports idle when no turn is running", async () => {
    const faux = registerFauxProvider({ provider: "b-stop" });
    cleanups.push(() => faux.unregister());
    const session = await makeSession(faux);

    const r = await executeBuiltin("stop", [], session, ctx, session.thread());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("No agent turn is running.");
  });

  it("/clear reports zero when the queue is empty", async () => {
    const faux = registerFauxProvider({ provider: "b-clear" });
    cleanups.push(() => faux.unregister());
    const session = await makeSession(faux);

    const r = await executeBuiltin("clear", [], session, ctx, session.thread());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("already empty");
  });

  it("/status reports the active model and queue depth", async () => {
    const faux = registerFauxProvider({ provider: "b-status" });
    cleanups.push(() => faux.unregister());
    const session = await makeSession(faux);

    const r = await executeBuiltin("status", [], session, ctx, session.thread());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Queue");
    expect(r.output).toContain("0 pending");
  });

  it("/sessions lists child sessions", async () => {
    const faux = registerFauxProvider({ provider: "b-sessions" });
    cleanups.push(() => faux.unregister());
    const session = await makeSession(faux);

    const r = await executeBuiltin("sessions", [], session, ctx, session.thread());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("c1");
    expect(r.output).toContain("child");
  });

  it("/new-thread creates and reports a fresh thread id", async () => {
    const faux = registerFauxProvider({ provider: "b-newthread" });
    cleanups.push(() => faux.unregister());
    const session = await makeSession(faux);

    const r = await executeBuiltin("new-thread", [], session, ctx, session.thread());
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/th-/);
  });
});
