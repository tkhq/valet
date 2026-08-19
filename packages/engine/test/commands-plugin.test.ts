import { describe, it, expect, afterEach, vi } from "vitest";
import { Type } from "typebox";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  buildPluginCatalog,
  type ActionPlugin,
  type BusEvent,
  type CommandDef,
  type DecisionResolution,
  type PluginAction,
  type PluginActionResult,
  type PluginCatalog,
  type SessionEntry,
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

// ── fixture plugin: one echo action + one high-risk action ─────────

interface EchoFixture {
  catalog: PluginCatalog;
  actionPlugins: ActionPlugin[];
  commands: Array<{ pluginName: string; def: CommandDef }>;
}

function echoFixture(opts?: {
  requiresCredential?: boolean;
  defaultApprovalMode?: "allow" | "require_approval" | "deny";
}): EchoFixture {
  const echo: PluginAction = {
    id: "testplug.echo",
    name: "Echo",
    description: "Return the text argument unchanged.",
    riskLevel: "low",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args): Promise<PluginActionResult> => {
      const text = (args as { text: string }).text;
      return { success: true, data: { echoed: text } };
    },
  };

  const actionPlugin: ActionPlugin = {
    service: "testplug",
    actions: [echo],
    ...(opts?.requiresCredential !== undefined
      ? { requiresCredential: opts.requiresCredential }
      : {}),
    ...(opts?.defaultApprovalMode !== undefined
      ? { defaultApprovalMode: opts.defaultApprovalMode }
      : {}),
  };

  const echoCommand: CommandDef = {
    name: "echo",
    description: "Echo a string back.",
    argHint: "<text>",
    action: "testplug.echo",
    mapArgs: (args) => ({ text: args.join(" ") }),
  };

  const actionPlugins = [actionPlugin];
  return {
    catalog: buildPluginCatalog(actionPlugins),
    actionPlugins,
    commands: [{ pluginName: "testplug", def: echoCommand }],
  };
}

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, bus, events };
}

function lastEntry(entries: SessionEntry[]): SessionEntry | undefined {
  return entries.at(-1);
}

describe("Session.prompt plugin command execution", () => {
  it("executes an action-backed command and records the result", async () => {
    const faux = registerFauxProvider({ provider: "s-plugin-ok" });
    cleanups.push(() => faux.unregister());
    const { engine, store } = makeEngine();
    const fx = echoFixture();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      pluginCommands: fx.commands,
      pluginCatalog: fx.catalog,
    });
    const threadId = session.thread().id;

    const receipt = await session.prompt("/testplug:echo hello");
    expect(receipt.command).toEqual({ name: "testplug:echo", source: "plugin" });
    expect(receipt.queueItemId).toBe("");

    const last = lastEntry(await store.getEntries(session.id, threadId));
    expect(last?.type === "command_result" && last.ok).toBe(true);
    expect(last?.type === "command_result" ? last.output : "").toContain("hello");

    // The queue never took a submission for the command.
    const unsettled = await store.listUnsettledSubmissions(session.id);
    expect(unsettled).toHaveLength(0);
  });

  it("routes require_approval actions through the decision gate (denied)", async () => {
    const faux = registerFauxProvider({ provider: "s-plugin-deny" });
    cleanups.push(() => faux.unregister());
    const { engine, store } = makeEngine();
    const fx = echoFixture({ defaultApprovalMode: "require_approval" });
    const deny: DecisionResolution = {
      actionId: "deny",
      resolvedBy: "test",
      resolvedAt: Date.now(),
    };
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      pluginCommands: fx.commands,
      pluginCatalog: fx.catalog,
      commandRequestDecision: async () => deny,
    });
    const threadId = session.thread().id;

    const receipt = await session.prompt("/testplug:echo hello");
    expect(receipt.command).toEqual({ name: "testplug:echo", source: "plugin" });

    const last = lastEntry(await store.getEntries(session.id, threadId));
    expect(last?.type === "command_result" && last.ok).toBe(false);
    expect(last?.type === "command_result" ? last.output : "").toContain("Approval was denied");
  });

  it("routes require_approval actions through the decision gate (pending)", async () => {
    const faux = registerFauxProvider({ provider: "s-plugin-pending" });
    cleanups.push(() => faux.unregister());
    const { engine, store } = makeEngine();
    const fx = echoFixture({ defaultApprovalMode: "require_approval" });
    const pending: DecisionResolution = {
      actionId: "pending",
      resolvedBy: "test",
      resolvedAt: Date.now(),
    };
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      pluginCommands: fx.commands,
      pluginCatalog: fx.catalog,
      commandRequestDecision: async () => pending,
    });
    const threadId = session.thread().id;

    await session.prompt("/testplug:echo hello");
    const last = lastEntry(await store.getEntries(session.id, threadId));
    expect(last?.type === "command_result" && last.ok).toBe(false);
    expect(last?.type === "command_result" ? last.output : "").toContain("Approval is pending");
  });

  it("without a host hook, an approval opens a real gate; approve completes the command", async () => {
    const faux = registerFauxProvider({ provider: "s-plugin-gate-ok" });
    cleanups.push(() => faux.unregister());
    const { engine, store } = makeEngine();
    const fx = echoFixture({ defaultApprovalMode: "require_approval" });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      pluginCommands: fx.commands,
      pluginCatalog: fx.catalog,
      // No commandRequestDecision: the engine must open a session-level gate.
    });
    const threadId = session.thread().id;

    const receiptP = session.prompt("/testplug:echo gated");

    // The gate persists as a decision_gate entry before any resolution.
    let gateId = "";
    await vi.waitFor(async () => {
      const entries = await store.getEntries(session.id, threadId);
      const gateEntry = entries.find((e) => e.type === "decision_gate");
      expect(gateEntry).toBeDefined();
      if (gateEntry?.type === "decision_gate") gateId = gateEntry.gate.id;
    });

    await session.resolveDecision(gateId, {
      actionId: "approve",
      resolvedBy: "test-user",
      resolvedAt: Date.now(),
    });
    const receipt = await receiptP;
    expect(receipt.command).toEqual({ name: "testplug:echo", source: "plugin" });

    await vi.waitFor(async () => {
      const entries = await store.getEntries(session.id, threadId);
      const result = entries.find((e) => e.type === "command_result");
      expect(result?.type === "command_result" && result.ok).toBe(true);
      expect(result?.type === "command_result" ? result.output : "").toContain("gated");
    });
    // The durable gate row is resolved, not stuck pending.
    const gate = await store.getDecisionGate(session.id, gateId);
    expect(gate?.status).toBe("resolved");
  });

  it("without a host hook, denying the gate records the deny text", async () => {
    const faux = registerFauxProvider({ provider: "s-plugin-gate-no" });
    cleanups.push(() => faux.unregister());
    const { engine, store } = makeEngine();
    const fx = echoFixture({ defaultApprovalMode: "require_approval" });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      pluginCommands: fx.commands,
      pluginCatalog: fx.catalog,
    });
    const threadId = session.thread().id;

    const receiptP = session.prompt("/testplug:echo nope");
    let gateId = "";
    await vi.waitFor(async () => {
      const entries = await store.getEntries(session.id, threadId);
      const gateEntry = entries.find((e) => e.type === "decision_gate");
      expect(gateEntry).toBeDefined();
      if (gateEntry?.type === "decision_gate") gateId = gateEntry.gate.id;
    });
    await session.resolveDecision(gateId, {
      actionId: "deny",
      resolvedBy: "test-user",
      resolvedAt: Date.now(),
    });
    await receiptP;

    await vi.waitFor(async () => {
      const entries = await store.getEntries(session.id, threadId);
      const result = entries.find((e) => e.type === "command_result");
      expect(result?.type === "command_result" && result.ok).toBe(false);
      expect(result?.type === "command_result" ? result.output : "").toContain("Approval was denied");
    });
  });

  it("missing credentials produce a corrective error", async () => {
    const faux = registerFauxProvider({ provider: "s-plugin-cred" });
    cleanups.push(() => faux.unregister());
    const { engine, store } = makeEngine();

    // An action whose execute needs a connected credential; the empty
    // credential provider makes .get() return null, and the action throws
    // the engine's canonical "not connected" error.
    const needsCred: PluginAction = {
      id: "testplug.push",
      name: "Push",
      description: "Push something that needs a credential.",
      riskLevel: "low",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_args, ctx): Promise<PluginActionResult> => {
        await ctx.credentials.request("testplug", "push needs auth");
        return { success: true };
      },
    };
    const actionPlugin: ActionPlugin = {
      service: "testplug",
      actions: [needsCred],
      requiresCredential: true,
    };
    const command: CommandDef = {
      name: "push",
      description: "Push a string.",
      action: "testplug.push",
      mapArgs: (args) => ({ text: args.join(" ") }),
    };
    const catalog = buildPluginCatalog([actionPlugin]);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      pluginCommands: [{ pluginName: "testplug", def: command }],
      pluginCatalog: catalog,
    });
    const threadId = session.thread().id;

    await session.prompt("/testplug:push hi");
    const last = lastEntry(await store.getEntries(session.id, threadId));
    expect(last?.type === "command_result" && last.ok).toBe(false);
    const output = last?.type === "command_result" ? last.output : "";
    expect(output).toContain("Connect the testplug integration in Settings.");
  });
});
