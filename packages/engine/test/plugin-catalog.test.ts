import { describe, it, expect } from "vitest";
import { ObjectOptions, Type } from "typebox";
import type { TObject } from "typebox";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  pluginCatalogTools,
  pinnedToolName,
  prepareActionArgs,
  MAX_PINNED_ACTIONS,
  RESOLVE_TTL_MS,
  Engine,
  InMemoryCredentialStore,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type ActionPlugin,
  type BusEvent,
  type Credential,
  type CredentialProvider,
  DecisionGateExpiredError,
  type DecisionGateRequest,
  type DecisionResolution,
  type PinnedActionSpec,
  type PluginAction,
  type PluginActionContext,
  type PluginActionResult,
  type PluginStore,
  type ScopedPluginStore,
  type PolicyDecision,
  type PolicyInvocationRecord,
  type PolicyResolver,
  type Sandbox,
  type SessionEntry,
  type ToolContext,
} from "../src/index.js";

function makeMockPlugin(): {
  plugin: ActionPlugin;
  calls: Array<{ id: string; args: unknown; ctx: PluginActionContext }>;
} {
  const calls: Array<{ id: string; args: unknown; ctx: PluginActionContext }> = [];

  const getIssue: PluginAction = {
    id: "github.get_issue",
    name: "Get Issue",
    description: "Read an issue.",
    riskLevel: "low",
    parameters: Type.Object({
      owner: Type.String(),
      repo: Type.String(),
      issueNumber: Type.Integer(),
    }),
    execute: async (args, ctx): Promise<PluginActionResult> => {
      calls.push({ id: getIssue.id, args, ctx });
      return { success: true, data: { number: 42, title: "Test issue" } };
    },
  };

  const createIssue: PluginAction = {
    id: "github.create_issue",
    name: "Create Issue",
    description: "Create a new issue.",
    riskLevel: "medium",
    parameters: Type.Object({
      owner: Type.String(),
      repo: Type.String(),
      title: Type.String(),
      body: Type.Optional(Type.String()),
    }),
    execute: async (args, ctx) => {
      calls.push({ id: createIssue.id, args, ctx });
      return { success: true, data: { number: 99, html_url: "https://x" } };
    },
  };

  const deleteRepo: PluginAction = {
    id: "github.delete_repo",
    name: "Delete Repo",
    description: "Permanently delete a repo.",
    riskLevel: "critical",
    parameters: Type.Object({ owner: Type.String(), repo: Type.String() }),
    execute: async (args, ctx) => {
      calls.push({ id: deleteRepo.id, args, ctx });
      return { success: true, data: { deleted: true } };
    },
  };

  const plugin: ActionPlugin = {
    service: "github",
    actions: [getIssue, createIssue, deleteRepo],
    requiresCredential: true,
  };
  return { plugin, calls };
}

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const credentials = new InMemoryCredentialStore();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, credentials, sandboxProvider } });
  return { engine, events, credentials };
}

async function waitForIdle(events: BusEvent[], threadId: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (
    !events.some(
      (e) => e.event.type === "status" && e.event.threadId === threadId && e.event.status === "idle",
    )
  ) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for idle");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("pluginCatalogTools: registration", () => {
  it("returns exactly two engine-visible tools regardless of plugin count", () => {
    const { plugin } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });
    expect(tools.map((t) => t.name).sort()).toEqual(["call_tool", "list_tools"]);
  });

  it("two plugins still produce just list_tools + call_tool", () => {
    const a = makeMockPlugin();
    const b = makeMockPlugin();
    const tools = pluginCatalogTools({
      plugins: [
        { ...a.plugin, service: "github" },
        { ...b.plugin, service: "gmail" },
      ],
    });
    expect(tools.map((t) => t.name).sort()).toEqual(["call_tool", "list_tools"]);
  });

  it("names every service (static and dynamic) in the list_tools description", () => {
    const a = makeMockPlugin();
    const dynamic: ActionPlugin = {
      service: "linear",
      actions: [],
      resolveActions: async () => [],
    };
    const tools = pluginCatalogTools({
      plugins: [{ ...a.plugin, service: "github" }, dynamic],
    });
    const listTool = tools.find((t) => t.name === "list_tools");
    expect(listTool?.description).toContain("Available services: github, linear.");
  });

  it("omits the service line when the catalog is empty", () => {
    const tools = pluginCatalogTools({ plugins: [] });
    const listTool = tools.find((t) => t.name === "list_tools");
    expect(listTool?.description).not.toContain("Available services:");
  });
});

describe("pluginCatalogTools: list_tools", () => {
  it("returns the catalog with TypeBox parameters preserved as JSON Schema", async () => {
    const { plugin } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "list1" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_tools", {}, { id: "t1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const { engine, events, credentials } = makeEngine();
    // makeMockPlugin declares requiresCredential — connect it so these
    // schema/filtering assertions see the full catalog.
    await credentials.save({ type: "user", id: "u" }, "github", { accessToken: "tok" });
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("list");
    await waitForIdle(events, receipt.threadId);

    const toolEnd = events.find((e) => e.event.type === "tool_end");
    if (!toolEnd || toolEnd.event.type !== "tool_end") throw new Error("no tool_end");
    const payload = JSON.parse(toolEnd.event.result) as {
      tools: Array<{
        tool_id: string;
        riskLevel: string;
        params: { type: string; properties: Record<string, { type: string }> };
      }>;
      total: number;
    };
    expect(payload.total).toBe(3);
    const ids = payload.tools.map((t) => t.tool_id).sort();
    expect(ids).toEqual([
      "github.create_issue",
      "github.delete_repo",
      "github.get_issue",
    ]);
    const getIssue = payload.tools.find((t) => t.tool_id === "github.get_issue");
    expect(getIssue?.params.type).toBe("object");
    expect(getIssue?.params.properties.issueNumber.type).toBe("integer");

    faux.unregister();
  });

  it("filters by service and substring query", async () => {
    const { plugin } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "list2" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_tools", { query: "delete" }, { id: "t2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const { engine, events, credentials } = makeEngine();
    // Connected: this test asserts filtering, not the unconnected-hiding.
    await credentials.save({ type: "user", id: "u" }, "github", { accessToken: "tok" });
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("find delete tool");
    await waitForIdle(events, receipt.threadId);

    const toolEnd = events.find((e) => e.event.type === "tool_end");
    if (!toolEnd || toolEnd.event.type !== "tool_end") throw new Error("no tool_end");
    const payload = JSON.parse(toolEnd.event.result) as {
      tools: Array<{ tool_id: string }>;
    };
    expect(payload.tools.map((t) => t.tool_id)).toEqual(["github.delete_repo"]);

    faux.unregister();
  });

  it("emits a warning when a service has no credential", async () => {
    const { plugin } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "list3" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("list_tools", {}, { id: "t3" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("list");
    await waitForIdle(events, receipt.threadId);

    const toolEnd = events.find((e) => e.event.type === "tool_end");
    if (!toolEnd || toolEnd.event.type !== "tool_end") throw new Error("no tool_end");
    const payload = JSON.parse(toolEnd.event.result) as {
      tools: Array<{ tool_id: string }>;
      warnings?: Array<{ service: string; reason: string }>;
    };
    expect(payload.warnings?.[0]?.service).toBe("github");
    // requiresCredential + no credential → tools hidden from the
    // unfiltered listing, and the warning names the fix.
    expect(payload.tools).toEqual([]);
    expect(payload.warnings?.[0]?.reason).toMatch(/tools hidden/);

    faux.unregister();
  });

  it("an explicit service filter still returns an unconnected service's tools (schema inspection)", async () => {
    const { plugin } = makeMockPlugin();
    const [listTool] = pluginCatalogTools({ plugins: [plugin] });

    const result = await listTool.execute({ service: "github" }, makeCtx());
    const payload = JSON.parse(result.text) as {
      tools: Array<{ tool_id: string }>;
      warnings?: Array<{ service: string; reason: string }>;
    };
    expect(payload.tools.length).toBeGreaterThan(0);
    expect(payload.warnings?.[0]).toEqual({ service: "github", reason: "no credential connected" });
  });

  it("credential-less plugins are never probed or warned about", async () => {
    const workflowsAction: PluginAction = {
      id: "workflows.list_workflows",
      name: "List Workflows",
      description: "List workflows.",
      riskLevel: "low",
      parameters: Type.Object({}),
      execute: async () => ({ success: true, data: {} }),
    };
    const workflowsPlugin: ActionPlugin = { service: "workflows", actions: [workflowsAction] };
    const [listTool] = pluginCatalogTools({ plugins: [workflowsPlugin] });

    const result = await listTool.execute({}, makeCtx());
    const payload = JSON.parse(result.text) as {
      tools: Array<{ tool_id: string }>;
      warnings?: Array<{ service: string; reason: string }>;
    };
    expect(payload.tools.map((t) => t.tool_id)).toEqual(["workflows.list_workflows"]);
    expect(payload.warnings).toBeUndefined();
  });

  it("survives a throwing credential probe: that service hides with a warning, others list normally", async () => {
    const { plugin: githubPlugin } = makeMockPlugin();
    const gmailAction: PluginAction = {
      id: "gmail.send",
      name: "Send Email",
      description: "Send an email.",
      riskLevel: "low",
      parameters: Type.Object({ to: Type.String() }),
      execute: async () => ({ success: true, data: {} }),
    };
    const gmailPlugin: ActionPlugin = {
      service: "gmail",
      actions: [gmailAction],
      requiresCredential: true,
    };

    const [listTool] = pluginCatalogTools({ plugins: [githubPlugin, gmailPlugin] });
    const ctx = makeCtx({
      credentials: {
        get: async (service?: string): Promise<Credential | null> => {
          if (service === "github") throw new Error("GitHub App not installed");
          if (service === "gmail") return { accessToken: "gmail-token" };
          return null;
        },
        request: async (): Promise<Credential> => {
          throw new Error("not implemented in test stub");
        },
      },
    });

    const result = await listTool.execute({}, ctx);
    const payload = JSON.parse(result.text) as {
      tools: Array<{ tool_id: string }>;
      warnings?: Array<{ service: string; reason: string }>;
    };

    // The throwing github probe didn't abort list_tools — github hides
    // (treated as unconnected) while gmail lists normally.
    expect(payload.tools.map((t) => t.tool_id)).toEqual(["gmail.send"]);

    // github got a hidden-warning (probe threw); gmail did not (credential resolved).
    const githubWarning = payload.warnings?.find((w) => w.service === "github");
    expect(githubWarning?.reason).toMatch(/tools hidden/);
    const gmailWarning = payload.warnings?.find((w) => w.service === "gmail");
    expect(gmailWarning).toBeUndefined();
  });
});

describe("pluginCatalogTools: call_tool", () => {
  it("dispatches by tool_id and returns rendered data with credentials available", async () => {
    const { plugin, calls } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "call1" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            {
              tool_id: "github.get_issue",
              params: { owner: "o", repo: "r", issueNumber: 42 },
              summary: "fetch issue 42",
            },
            { id: "tc1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ok"),
    ]);

    const { engine, events, credentials } = makeEngine();
    await credentials.save({ type: "user", id: "u" }, "github", {
      type: "oauth2",
      accessToken: "ghp_secret",
    });
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("get issue");
    await waitForIdle(events, receipt.threadId);

    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("github.get_issue");
    expect(calls[0].args).toEqual({ owner: "o", repo: "r", issueNumber: 42 });
    expect(calls[0].ctx.actionId).toBe("github.get_issue");
    expect(calls[0].ctx.service).toBe("github");
    expect(calls[0].ctx.summary).toBe("fetch issue 42");

    // Plugin called credentials.get() with no arg → defaults to "github"
    const cred = await calls[0].ctx.credentials.get();
    expect(cred?.accessToken).toBe("ghp_secret");

    const toolEnd = events.find((e) => e.event.type === "tool_end");
    if (!toolEnd || toolEnd.event.type !== "tool_end") throw new Error("no tool_end");
    expect(toolEnd.event.result).toContain("Test issue");
    expect(toolEnd.event.result).toContain("42");

    faux.unregister();
  });

  it("binds ctx.pluginStore to the action's own plugin and round-trips a doc", async () => {
    const { plugin, calls } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    // Record which plugin name the factory was asked for, and hand back a
    // trivial in-memory store so the action can round-trip a doc.
    const factoryCalls: string[] = [];
    const backing = new Map<string, unknown>();
    const makeScoped = (): ScopedPluginStore => ({
      get: async <T,>(collection: string, key: string) => {
        const doc = backing.get(`${collection}/${key}`);
        return doc === undefined
          ? null
          : { key, doc: doc as T, revision: 1, createdAt: 0, updatedAt: 0 };
      },
      put: async <T,>(collection: string, key: string, doc: T) => {
        backing.set(`${collection}/${key}`, doc);
        return { key, doc, revision: 1, createdAt: 0, updatedAt: 0 };
      },
      list: async () => ({ items: [], nextCursor: null }),
      delete: async () => false,
    });
    const fakeStoreFor = (pluginName: string): PluginStore => {
      factoryCalls.push(pluginName);
      const scoped = makeScoped();
      return {
        scope: () => scoped,
        global: () => scoped,
        org: () => scoped,
        team: () => scoped,
        user: () => scoped,
        session: () => scoped,
      };
    };

    const faux = registerFauxProvider({ provider: "call-store" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            {
              tool_id: "github.get_issue",
              params: { owner: "o", repo: "r", issueNumber: 7 },
              summary: "fetch issue 7",
            },
            { id: "tc-store" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ok"),
    ]);

    const { engine, events, credentials } = makeEngine();
    await credentials.save({ type: "user", id: "u" }, "github", {
      type: "oauth2",
      accessToken: "ghp_secret",
    });
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
      pluginStoreFactory: fakeStoreFor,
    });
    const receipt = await session.prompt("get issue");
    await waitForIdle(events, receipt.threadId);

    expect(calls).toHaveLength(1);
    // The factory was asked for the action's OWN plugin name.
    expect(factoryCalls).toEqual(["github"]);
    const store = calls[0].ctx.pluginStore;
    expect(store).toBeDefined();
    // Round-trip a doc through the bound store.
    await store!.org("o").put("settings", "k", { v: 1 });
    const got = await store!.org("o").get<{ v: number }>("settings", "k");
    expect(got?.doc).toEqual({ v: 1 });

    faux.unregister();
  });

  it("unknown tool_id → tool result text reports it without dispatching", async () => {
    const { plugin, calls } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "call2" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            { tool_id: "github.does_not_exist", params: {}, summary: "should fail" },
            { id: "tc-bad" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ack"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("call missing tool");
    await waitForIdle(events, receipt.threadId);

    expect(calls).toHaveLength(0);
    const toolEnd = events.find((e) => e.event.type === "tool_end");
    expect(
      toolEnd && toolEnd.event.type === "tool_end" && toolEnd.event.result,
    ).toContain("unknown tool_id");

    faux.unregister();
  });

  it("PluginActionResult.success=false → tool result surfaces the error text", async () => {
    const failing: ActionPlugin = {
      service: "test",
      actions: [
        {
          id: "test.fail",
          name: "Fail",
          description: "always fails",
          riskLevel: "low",
          parameters: Type.Object({}),
          execute: async () => ({ success: false, error: "boom 500" }),
        },
      ],
    };
    const tools = pluginCatalogTools({ plugins: [failing] });

    const faux = registerFauxProvider({ provider: "call3" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            { tool_id: "test.fail", params: {}, summary: "trigger fail" },
            { id: "tc-fail" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ack"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    const receipt = await session.prompt("trigger fail");
    await waitForIdle(events, receipt.threadId);

    const toolEnd = events.find((e) => e.event.type === "tool_end");
    expect(
      toolEnd && toolEnd.event.type === "tool_end" && toolEnd.event.result,
    ).toContain("boom 500");

    faux.unregister();
  });

  it("critical-risk action opens an approval gate; deny short-circuits to denial text", async () => {
    const { plugin, calls } = makeMockPlugin();
    const tools = pluginCatalogTools({ plugins: [plugin] });

    const faux = registerFauxProvider({ provider: "call4" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "call_tool",
            {
              tool_id: "github.delete_repo",
              params: { owner: "o", repo: "r" },
              summary: "delete the repo",
            },
            { id: "tc-del" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("acknowledged"),
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      tools,
    });
    void session.prompt("delete the repo");

    const start = Date.now();
    while (!events.some((e) => e.event.type === "decision_gate")) {
      if (Date.now() - start > 2000) throw new Error("gate timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
    const gate = events.find((e) => e.event.type === "decision_gate");
    if (!gate || gate.event.type !== "decision_gate") throw new Error("no gate");
    await session.resolveDecision(gate.event.gate.id, {
      actionId: "deny",
      resolvedBy: "u",
      resolvedAt: Date.now(),
    });

    const start2 = Date.now();
    while (
      !events.some(
        (e) => e.event.type === "tool_end" && e.event.tool === "call_tool",
      )
    ) {
      if (Date.now() - start2 > 2000) throw new Error("tool_end timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls).toHaveLength(0);
    const toolEnd = events.find((e) => e.event.type === "tool_end");
    expect(
      toolEnd && toolEnd.event.type === "tool_end" && toolEnd.event.result,
    ).toContain("did not approve");

    faux.unregister();
  });
});

// ── Direct-invocation ctx helper (mirrors task-tool.test.ts / bash-job-mode.test.ts) ──

type FakeSandbox = Partial<Sandbox> & { id: string };

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const sandbox: FakeSandbox = { id: "sb-1" };
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials,
    sandbox: sandbox as Sandbox,
    requestDecision: async (): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...overrides,
  };
}

function makeDynamicPlugin(
  service: string,
  resolveActions: ActionPlugin["resolveActions"],
): ActionPlugin {
  return { service, actions: [], resolveActions };
}

describe("pluginCatalogTools: dynamic actions (resolveActions)", () => {
  it("list_tools merges resolveActions results with static actions", async () => {
    const { plugin: staticPlugin } = makeMockPlugin();
    const dynamicAction: PluginAction = {
      id: "notion.search_pages",
      name: "Search Pages",
      description: "Search Notion pages.",
      riskLevel: "low",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({ success: true, data: { pages: [] } }),
    };
    const dynamicPlugin = makeDynamicPlugin("notion", async () => [dynamicAction]);

    const [listTool] = pluginCatalogTools({ plugins: [staticPlugin, dynamicPlugin] });
    // Connected ctx: the flagged static plugin would otherwise hide.
    const result = await listTool.execute(
      {},
      makeCtx({
        credentials: {
          get: async (): Promise<Credential | null> => ({ accessToken: "tok" }),
          request: async (): Promise<Credential> => {
            throw new Error("not implemented in test stub");
          },
        },
      }),
    );
    const payload = JSON.parse(result.text) as { tools: Array<{ tool_id: string }> };
    const ids = payload.tools.map((t) => t.tool_id).sort();
    expect(ids).toEqual([
      "github.create_issue",
      "github.delete_repo",
      "github.get_issue",
      "notion.search_pages",
    ]);
  });

  it("resolveActions failure surfaces a warning without throwing, static tools still listed", async () => {
    const { plugin: staticPlugin } = makeMockPlugin();
    const dynamicPlugin = makeDynamicPlugin("notion", async () => {
      throw new Error("upstream 500");
    });

    const [listTool] = pluginCatalogTools({ plugins: [staticPlugin, dynamicPlugin] });
    // Connected ctx: the flagged static plugin would otherwise hide.
    const result = await listTool.execute(
      {},
      makeCtx({
        credentials: {
          get: async (): Promise<Credential | null> => ({ accessToken: "tok" }),
          request: async (): Promise<Credential> => {
            throw new Error("not implemented in test stub");
          },
        },
      }),
    );
    const payload = JSON.parse(result.text) as {
      tools: Array<{ tool_id: string }>;
      warnings?: Array<{ service: string; reason: string }>;
    };
    expect(payload.tools.map((t) => t.tool_id).sort()).toEqual([
      "github.create_issue",
      "github.delete_repo",
      "github.get_issue",
    ]);
    const warning = payload.warnings?.find((w) => w.service === "notion");
    expect(warning?.reason).toMatch(/action discovery failed/);
  });

  it("caches resolveActions within RESOLVE_TTL_MS and refetches after it elapses", async () => {
    let now = 1_000_000;
    let calls = 0;
    const dynamicAction: PluginAction = {
      id: "notion.search_pages",
      name: "Search Pages",
      description: "Search Notion pages.",
      riskLevel: "low",
      parameters: Type.Object({}),
      execute: async () => ({ success: true, data: {} }),
    };
    const dynamicPlugin = makeDynamicPlugin("notion", async () => {
      calls++;
      return [dynamicAction];
    });

    const [listTool] = pluginCatalogTools({
      plugins: [dynamicPlugin],
      clock: () => now,
    });

    await listTool.execute({}, makeCtx());
    expect(calls).toBe(1);

    await listTool.execute({}, makeCtx());
    expect(calls).toBe(1);

    now += RESOLVE_TTL_MS + 1;
    await listTool.execute({}, makeCtx());
    expect(calls).toBe(2);
  });

  it("call_tool resolves and executes a dynamic-only tool_id", async () => {
    let executed: unknown;
    const dynamicAction: PluginAction = {
      id: "notion.search_pages",
      name: "Search Pages",
      description: "Search Notion pages.",
      riskLevel: "low",
      parameters: Type.Object({ query: Type.String() }),
      execute: async (args) => {
        executed = args;
        return { success: true, data: { ok: true } };
      },
    };
    const dynamicPlugin = makeDynamicPlugin("notion", async () => [dynamicAction]);

    const [, callTool] = pluginCatalogTools({ plugins: [dynamicPlugin] });
    const result = await callTool.execute(
      { tool_id: "notion.search_pages", params: { query: "roadmap" }, summary: "search" },
      makeCtx(),
    );
    expect(executed).toEqual({ query: "roadmap" });
    expect(result.text).toContain("ok");
  });
});

describe("pluginCatalogTools: call_tool param validation", () => {
  it("rejects params that fail the schema and does not call execute", async () => {
    let executeCalled = false;
    const plugin: ActionPlugin = {
      service: "test",
      actions: [
        {
          id: "test.needs_num",
          name: "Needs Num",
          description: "requires a number",
          riskLevel: "low",
          parameters: Type.Object({ n: Type.Number() }),
          execute: async () => {
            executeCalled = true;
            return { success: true, data: {} };
          },
        },
      ],
    };
    const [, callTool] = pluginCatalogTools({ plugins: [plugin] });
    const result = await callTool.execute(
      { tool_id: "test.needs_num", params: { n: "not a number" }, summary: "bad call" },
      makeCtx(),
    );
    expect(result.text).toContain("invalid params for test.needs_num");
    expect(executeCalled).toBe(false);
  });

  it("applies TypeBox default annotations before execute", async () => {
    let received: unknown;
    const plugin: ActionPlugin = {
      service: "test",
      actions: [
        {
          id: "test.with_default",
          name: "With Default",
          description: "has a defaulted param",
          riskLevel: "low",
          parameters: Type.Object({ n: Type.Optional(Type.Number({ default: 25 })) }),
          execute: async (args) => {
            received = args;
            return { success: true, data: {} };
          },
        },
      ],
    };
    const [, callTool] = pluginCatalogTools({ plugins: [plugin] });
    await callTool.execute(
      { tool_id: "test.with_default", params: {}, summary: "use default" },
      makeCtx(),
    );
    expect(received).toEqual({ n: 25 });
  });
});

describe("pluginCatalogTools: approval gate terminal outcomes", () => {
  function gatedPlugin(): ActionPlugin {
    return {
      service: "test",
      actions: [
        {
          id: "test.dangerous",
          name: "Dangerous",
          description: "requires approval",
          riskLevel: "critical",
          parameters: Type.Object({}),
          execute: async () => ({ success: true, data: { ran: true } }),
        },
      ],
    };
  }

  it("gate expiry renders a terminal do-not-retry result, not a retryable error", async () => {
    const [, callTool] = pluginCatalogTools({ plugins: [gatedPlugin()] });
    const result = await callTool.execute(
      { tool_id: "test.dangerous", params: {}, summary: "try it" },
      makeCtx({
        requestDecision: async (): Promise<DecisionResolution> => {
          throw new DecisionGateExpiredError("g-x");
        },
      }),
    );
    expect(result.text).toContain("expired");
    expect(result.text).toContain("do not call test.dangerous again");
  });

  it("passes the qualified action id as dedupeKey so args variants share terminal outcomes", async () => {
    let seen: DecisionGateRequest | undefined;
    const [, callTool] = pluginCatalogTools({ plugins: [gatedPlugin()] });
    await callTool.execute(
      { tool_id: "test.dangerous", params: {}, summary: "try it" },
      makeCtx({
        requestDecision: async (req): Promise<DecisionResolution> => {
          seen = req;
          return { actionId: "deny", resolvedBy: "u1", resolvedAt: Date.now() };
        },
      }),
    );
    expect(seen?.dedupeKey).toBe("test.dangerous");
    expect(seen?.resumeKey?.startsWith("test.dangerous:")).toBe(true);
  });

  it("denial text tells the model the decision is final for the turn", async () => {
    const [, callTool] = pluginCatalogTools({ plugins: [gatedPlugin()] });
    const result = await callTool.execute(
      { tool_id: "test.dangerous", params: {}, summary: "try it" },
      makeCtx({
        requestDecision: async (): Promise<DecisionResolution> => ({
          actionId: "deny",
          resolvedBy: "u1",
          resolvedAt: Date.now(),
        }),
      }),
    );
    expect(result.text).toContain("final for the current turn");
  });
});

describe("prepareActionArgs", () => {
  it("does not mutate the caller's params object when applying defaults", () => {
    const schema = Type.Object({ n: Type.Optional(Type.Number({ default: 25 })) });
    const params = {};
    const result = prepareActionArgs(schema, params);
    expect(result.ok).toBe(true);
    expect(params).toEqual({});
  });
});

// ── pinned actions ───────────────────────────────────────────────

describe("pinnedToolName", () => {
  it("replaces the dot with a double underscore", () => {
    expect(pinnedToolName("workflows.patch_workflow")).toBe("workflows__patch_workflow");
    expect(pinnedToolName("github.create_issue")).toBe("github__create_issue");
    expect(pinnedToolName("a.b")).toBe("a__b");
  });

  it("produces names Anthropic accepts", () => {
    const anthropicToolName = /^[a-zA-Z0-9_-]{1,128}$/;
    for (const id of ["workflows.patch_workflow", "gmail.send_message", "a1.b2_c3"]) {
      const name = pinnedToolName(id);
      expect(name).toBeDefined();
      expect(name).toMatch(anthropicToolName);
    }
  });

  it("is injective: no two accepted ids map to one name", () => {
    // Every pairing that could collide under a naive transform: the dot
    // moving across the boundary, and underscores next to it.
    const ids = [
      "a.b_c",
      "a_b.c",
      "ab.c",
      "a.bc",
      "workflows.patch_workflow",
      "workflows_patch.workflow",
    ];
    const names = ids.map((id) => pinnedToolName(id));
    expect(names.every((n) => n !== undefined)).toBe(true);
    expect(new Set(names).size).toBe(ids.length);
  });

  it("refuses an id that cannot map to a unique legal name", () => {
    // A dash and an uppercase letter are legal in an MCP-proxied action id
    // but not in this transform's domain; a double underscore or an edge
    // underscore would put a second `__` in the result and break the
    // inverse; no dot and two dots are not `service.action` at all.
    expect(pinnedToolName("linear.create-issue")).toBeUndefined();
    expect(pinnedToolName("Linear.createIssue")).toBeUndefined();
    expect(pinnedToolName("a.b__c")).toBeUndefined();
    expect(pinnedToolName("a__b.c")).toBeUndefined();
    expect(pinnedToolName("a._b")).toBeUndefined();
    expect(pinnedToolName("a_.b")).toBeUndefined();
    expect(pinnedToolName("nodot")).toBeUndefined();
    expect(pinnedToolName("a.b.c")).toBeUndefined();
    expect(pinnedToolName("")).toBeUndefined();
    expect(pinnedToolName(`${"a".repeat(120)}.${"b".repeat(10)}`)).toBeUndefined();
  });
});

/** A plugin whose one action records every call, for pin/call parity checks. */
function makePinnablePlugin(): {
  plugin: ActionPlugin;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const plugin: ActionPlugin = {
    service: "workflows",
    actions: [
      {
        id: "workflows.patch_workflow",
        name: "Patch workflow",
        description: "Edit a workflow without re-sending the whole definition.",
        riskLevel: "medium",
        parameters: Type.Object({
          workflow_id: Type.String(),
          name: Type.Optional(Type.String({ default: "untitled" })),
        }),
        execute: async (args): Promise<PluginActionResult> => {
          calls.push(args);
          return { success: true, data: { workflowId: args.workflow_id } };
        },
      },
    ],
  };
  return { plugin, calls };
}

const PATCH_PIN: PinnedActionSpec = { actionId: "workflows.patch_workflow" };

describe("pluginCatalogTools: pinning", () => {
  it("leaves the default tool list untouched when nothing is pinned", () => {
    const { plugin } = makePinnablePlugin();
    expect(pluginCatalogTools({ plugins: [plugin] }).map((t) => t.name)).toEqual([
      "list_tools",
      "call_tool",
    ]);
    expect(pluginCatalogTools({ plugins: [plugin], pins: [] }).map((t) => t.name)).toEqual([
      "list_tools",
      "call_tool",
    ]);
  });

  it("appends one direct tool per accepted pin, after the catalog pair", () => {
    const { plugin } = makePinnablePlugin();
    const tools = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    expect(tools.map((t) => t.name)).toEqual([
      "list_tools",
      "call_tool",
      "workflows__patch_workflow",
    ]);
  });

  it("publishes every property of the action's own schema, plus a summary argument", () => {
    const { plugin } = makePinnablePlugin();
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    const own = plugin.actions[0]?.parameters as TObject;
    const published = pinned?.parameters as TObject;
    for (const key of Object.keys(own.properties)) {
      expect(published.properties[key]).toBe(own.properties[key]);
    }
    // The model needs a place to write the sentence the approval gate and
    // the audit record show. `call_tool` takes one; so does this route.
    expect(published.properties.summary).toBeDefined();
    expect(published.required ?? []).not.toContain("summary");
    expect(pinned?.riskLevel).toBe("medium");
  });

  it("leaves the action's own schema object untouched", () => {
    // `list_tools` publishes the same object, and the slash-command path
    // validates against it. A mutation here would reach both.
    const { plugin } = makePinnablePlugin();
    const own = plugin.actions[0]?.parameters as TObject;
    pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    expect(Object.keys(own.properties)).toEqual(["workflow_id", "name"]);
  });

  it("keeps an action's own summary parameter and adds nothing", () => {
    // The action already owns the name, so adding an argument would shadow
    // a real parameter and drop it from the call.
    const plugin: ActionPlugin = {
      service: "workflows",
      actions: [
        {
          id: "workflows.patch_workflow",
          name: "Patch workflow",
          description: "Edit a workflow.",
          riskLevel: "medium",
          parameters: Type.Object({ summary: Type.String() }),
          execute: async (): Promise<PluginActionResult> => ({ success: true }),
        },
      ],
    };
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    expect(pinned?.parameters).toBe(plugin.actions[0]?.parameters);
  });

  it("keeps the object schema's own keywords when it adds the summary argument", () => {
    const plugin: ActionPlugin = {
      service: "workflows",
      actions: [
        {
          id: "workflows.patch_workflow",
          name: "Patch workflow",
          description: "Edit a workflow.",
          riskLevel: "medium",
          parameters: Type.Object(
            { workflow_id: Type.String() },
            { additionalProperties: false, description: "Patch arguments." },
          ),
          execute: async (): Promise<PluginActionResult> => ({ success: true }),
        },
      ],
    };
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    // `ToolDef.parameters` is a `TSchema`; this action declares an object, so
    // narrowing to `TObject` is what lets the test read its keywords.
    const published = pinned?.parameters as TObject;
    const options = ObjectOptions(published);
    expect(options.additionalProperties).toBe(false);
    expect(options.description).toBe("Patch arguments.");
    expect(published.required).toEqual(["workflow_id"]);
  });

  it("does not set requiresApproval — the gate belongs to the policy path", () => {
    const { plugin } = makePinnablePlugin();
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    expect(pinned?.requiresApproval).toBeUndefined();
  });

  it("carries the host guidance and names the call_tool equivalent", () => {
    const { plugin } = makePinnablePlugin();
    const [, , pinned] = pluginCatalogTools({
      plugins: [plugin],
      pins: [
        {
          actionId: "workflows.patch_workflow",
          guidance: "Apply the edit with this tool BEFORE you describe it.",
        },
      ],
    });
    expect(pinned?.description).toContain("Edit a workflow without re-sending");
    expect(pinned?.description).toContain("Apply the edit with this tool BEFORE you describe it.");
    expect(pinned?.description).toContain("`workflows.patch_workflow` through call_tool");
  });

  it("keeps a pinned action listed in list_tools and names its direct tool", async () => {
    const { plugin } = makePinnablePlugin();
    const [listTool] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    const result = await listTool.execute({}, makeCtx());
    const payload = JSON.parse(result.text) as {
      tools: Array<{ tool_id: string; direct_tool?: string }>;
    };
    const row = payload.tools.find((t) => t.tool_id === "workflows.patch_workflow");
    expect(row?.direct_tool).toBe("workflows__patch_workflow");
  });

  it("omits direct_tool for actions that are not pinned", async () => {
    const { plugin } = makeMockPlugin();
    const [listTool] = pluginCatalogTools({ plugins: [plugin] });
    const result = await listTool.execute(
      { service: "github" },
      makeCtx({
        credentials: {
          get: async (): Promise<Credential | null> => ({ accessToken: "tok" }),
          request: async (): Promise<Credential> => {
            throw new Error("not implemented in test stub");
          },
        },
      }),
    );
    const payload = JSON.parse(result.text) as {
      tools: Array<{ tool_id: string; direct_tool?: string }>;
    };
    expect(payload.tools.every((t) => t.direct_tool === undefined)).toBe(true);
  });
});

describe("pluginCatalogTools: pin rejection", () => {
  /** Collects rejections so a test can assert both the refusal and the fix text. */
  function pinsWith(
    plugins: ActionPlugin[],
    pins: PinnedActionSpec[],
    reservedToolNames?: string[],
  ): { names: string[]; rejected: Array<{ actionId: string; reason: string }> } {
    const rejected: Array<{ actionId: string; reason: string }> = [];
    const tools = pluginCatalogTools({
      plugins,
      pins,
      reservedToolNames,
      onPinRejected: (actionId, reason) => rejected.push({ actionId, reason }),
    });
    return { names: tools.map((t) => t.name), rejected };
  }

  it("refuses an id no plugin declares, and keeps the tool list unchanged", () => {
    const { plugin } = makePinnablePlugin();
    const { names, rejected } = pinsWith([plugin], [{ actionId: "workflows.no_such_action" }]);
    expect(names).toEqual(["list_tools", "call_tool"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.actionId).toBe("workflows.no_such_action");
    expect(rejected[0]?.reason).toMatch(/no plugin declares this action/);
  });

  it("refuses an id outside the name-mapping domain", () => {
    const plugin: ActionPlugin = {
      service: "linear",
      actions: [
        {
          id: "linear.create-issue",
          name: "Create issue",
          description: "Create an issue.",
          riskLevel: "low",
          parameters: Type.Object({}),
          execute: async () => ({ success: true }),
        },
      ],
    };
    const { names, rejected } = pinsWith([plugin], [{ actionId: "linear.create-issue" }]);
    expect(names).toEqual(["list_tools", "call_tool"]);
    expect(rejected[0]?.reason).toMatch(/cannot become a tool name/);
  });

  it("refuses a dynamically resolved action, which has no catalog entry at build", () => {
    const dynamicPlugin = makeDynamicPlugin("notion", async () => [
      {
        id: "notion.search_pages",
        name: "Search Pages",
        description: "Search Notion pages.",
        riskLevel: "low",
        parameters: Type.Object({}),
        execute: async () => ({ success: true }),
      },
    ]);
    const { names, rejected } = pinsWith([dynamicPlugin], [{ actionId: "notion.search_pages" }]);
    expect(names).toEqual(["list_tools", "call_tool"]);
    expect(rejected[0]?.reason).toMatch(/dynamically resolved action cannot be pinned/);
  });

  it("refuses the same pin twice, so no two tools share a name", () => {
    const { plugin } = makePinnablePlugin();
    const { names, rejected } = pinsWith([plugin], [PATCH_PIN, PATCH_PIN]);
    expect(names).toEqual(["list_tools", "call_tool", "workflows__patch_workflow"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatch(/"workflows__patch_workflow" is already in use/);
  });

  it("refuses a pin whose mapped name the caller has already claimed", () => {
    const { plugin } = makePinnablePlugin();
    const { names, rejected } = pinsWith([plugin], [PATCH_PIN], ["workflows__patch_workflow"]);
    expect(names).toEqual(["list_tools", "call_tool"]);
    expect(rejected[0]?.reason).toMatch(/is already in use/);
  });

  it("refuses pins past MAX_PINNED_ACTIONS and names the ceiling", () => {
    const count = MAX_PINNED_ACTIONS + 2;
    const actions: PluginAction[] = Array.from({ length: count }, (_, i) => ({
      id: `bulk.action_${i}`,
      name: `Action ${i}`,
      description: `Action ${i}.`,
      riskLevel: "low" as const,
      parameters: Type.Object({}),
      execute: async () => ({ success: true }),
    }));
    const { names, rejected } = pinsWith(
      [{ service: "bulk", actions }],
      actions.map((a) => ({ actionId: a.id })),
    );
    expect(names).toHaveLength(2 + MAX_PINNED_ACTIONS);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]?.reason).toMatch(new RegExp(`ceiling of ${MAX_PINNED_ACTIONS} actions`));
  });

  it("keeps the good pins when one entry in the list is bad", () => {
    const { plugin } = makePinnablePlugin();
    const { names, rejected } = pinsWith(
      [plugin],
      [{ actionId: "workflows.bogus" }, PATCH_PIN],
    );
    expect(names).toEqual(["list_tools", "call_tool", "workflows__patch_workflow"]);
    expect(rejected).toHaveLength(1);
  });
});

describe("pinned tool: same execution path as call_tool", () => {
  /**
   * Drives one (actionId, args) pair through call_tool and through the
   * pinned tool with the same context, so a difference between the two
   * routes shows up as a failing assertion rather than as a security gap.
   */
  async function bothRoutes(
    plugin: ActionPlugin,
    params: Record<string, unknown>,
    ctxOverrides: Partial<ToolContext> = {},
  ): Promise<{ viaCallTool: string; viaPinned: string }> {
    const [, callTool, pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    if (!pinned) throw new Error("pin was refused");
    const viaCallTool = await callTool.execute(
      { tool_id: "workflows.patch_workflow", params, summary: "patch it" },
      makeCtx(ctxOverrides),
    );
    const viaPinned = await pinned.execute(params, makeCtx(ctxOverrides));
    return { viaCallTool: viaCallTool.text, viaPinned: viaPinned.text };
  }

  it("a deny decision blocks the pinned tool with the same text as call_tool", async () => {
    const { plugin, calls } = makePinnablePlugin();
    const resolver: PolicyResolver = {
      resolve: async (): Promise<PolicyDecision> => ({
        mode: "deny",
        provenance: { baseMode: "deny", source: "org_policy" },
      }),
    };
    const { viaCallTool, viaPinned } = await bothRoutes(
      plugin,
      { workflow_id: "wf-1" },
      { policyResolver: resolver },
    );
    expect(viaPinned).toBe(viaCallTool);
    expect(viaPinned).toContain("blocked by org policy");
    expect(calls).toHaveLength(0);
  });

  it("a require_approval decision opens a gate for the pinned tool too", async () => {
    const { plugin, calls } = makePinnablePlugin();
    const gates: Array<{ resumeKey?: string; body: string }> = [];
    const resolver: PolicyResolver = {
      resolve: async (): Promise<PolicyDecision> => ({
        mode: "require_approval",
        provenance: { baseMode: "require_approval", source: "org_policy" },
      }),
    };
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    const result = await pinned?.execute(
      { workflow_id: "wf-1" },
      makeCtx({
        policyResolver: resolver,
        requestDecision: async (req): Promise<DecisionResolution> => {
          gates.push({ resumeKey: req.resumeKey, body: req.body ?? "" });
          return { actionId: "deny" };
        },
      }),
    );
    expect(gates).toHaveLength(1);
    // The gate is keyed and described by the fully-qualified action id, so
    // one admin rule covers both routes and the audit trail correlates.
    expect(gates[0]?.resumeKey).toContain("workflows.patch_workflow");
    expect(gates[0]?.body).toContain("tool_id=workflows.patch_workflow");
    expect(gates[0]?.body).toContain("wf-1");
    expect(result?.text).toContain("did not approve");
    expect(calls).toHaveLength(0);
  });

  it("rejects schema-violating args before execute, same text as call_tool", async () => {
    const { plugin, calls } = makePinnablePlugin();
    const { viaCallTool, viaPinned } = await bothRoutes(plugin, { workflow_id: 7 });
    expect(viaPinned).toBe(viaCallTool);
    expect(viaPinned).toContain("invalid params for workflows.patch_workflow");
    expect(calls).toHaveLength(0);
  });

  it("applies schema defaults on the pinned route", async () => {
    const { plugin, calls } = makePinnablePlugin();
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    await pinned?.execute({ workflow_id: "wf-1" }, makeCtx());
    expect(calls).toEqual([{ workflow_id: "wf-1", name: "untitled" }]);
  });

  it("treats non-object args as an empty call, so validation still runs", async () => {
    const { plugin, calls } = makePinnablePlugin();
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    const result = await pinned?.execute("not an object", makeCtx());
    expect(result?.text).toContain("invalid params for workflows.patch_workflow");
    expect(calls).toHaveLength(0);
  });

  it("succeeds with the same result text and the same audit record as call_tool", async () => {
    const { plugin } = makePinnablePlugin();
    const records: PolicyInvocationRecord[] = [];
    const resolver: PolicyResolver = {
      resolve: async (): Promise<PolicyDecision> => ({
        mode: "allow",
        provenance: { baseMode: "allow", source: "risk_default" },
      }),
      onInvocation: async (record) => {
        records.push(record);
      },
    };
    const { viaCallTool, viaPinned } = await bothRoutes(
      plugin,
      { workflow_id: "wf-1" },
      { policyResolver: resolver },
    );
    expect(viaPinned).toBe(viaCallTool);
    expect(viaPinned).toContain("wf-1");

    // onInvocation is fire-and-forget, so let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(records).toHaveLength(2);
    const [fromCallTool, fromPinned] = records;
    for (const field of [
      "service",
      "actionId",
      "toolId",
      "riskLevel",
      "status",
      "resolvedMode",
      "resumeKey",
      "appliesIn",
    ] as const) {
      expect(fromPinned?.[field]).toEqual(fromCallTool?.[field]);
    }
    expect(fromPinned?.actionId).toBe("workflows.patch_workflow");
    // The only intended difference: this pinned call sent no summary, so the
    // route falls back to a derived one.
    expect(fromCallTool?.summary).toBe("patch it");
    expect(fromPinned?.summary).toBe("Patch workflow (workflows__patch_workflow)");
  });
});

describe("pinned tool: the model's summary", () => {
  /** Collects one audit record per invocation. */
  function recordingResolver(records: PolicyInvocationRecord[]): PolicyResolver {
    return {
      resolve: async (): Promise<PolicyDecision> => ({
        mode: "allow",
        provenance: { baseMode: "allow", source: "risk_default" },
      }),
      onInvocation: async (record) => {
        records.push(record);
      },
    };
  }

  it("writes the model's own sentence to the audit record", async () => {
    const { plugin } = makePinnablePlugin();
    const records: PolicyInvocationRecord[] = [];
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    await pinned?.execute(
      { workflow_id: "wf-1", summary: "Remove the approval node from the release workflow" },
      makeCtx({ policyResolver: recordingResolver(records) }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(records[0]?.summary).toBe("Remove the approval node from the release workflow");
  });

  it("shows the model's own sentence in the approval gate body", async () => {
    // A person asked to approve an action needs a statement of intent, not
    // a constant that repeats the tool name.
    const { plugin } = makePinnablePlugin();
    const bodies: string[] = [];
    const resolver: PolicyResolver = {
      resolve: async (): Promise<PolicyDecision> => ({
        mode: "require_approval",
        provenance: { baseMode: "require_approval", source: "org_policy" },
      }),
    };
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    await pinned?.execute(
      { workflow_id: "wf-1", summary: "Delete the nightly backup step" },
      makeCtx({
        policyResolver: resolver,
        requestDecision: async (req): Promise<DecisionResolution> => {
          bodies.push(req.body ?? "");
          return { actionId: "deny", resolvedBy: "tester", resolvedAt: 0 };
        },
      }),
    );
    expect(bodies[0]?.startsWith("Delete the nightly backup step\n")).toBe(true);
  });

  it("keeps the summary out of the action's arguments and out of the audit params", async () => {
    const { plugin, calls } = makePinnablePlugin();
    const records: PolicyInvocationRecord[] = [];
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    await pinned?.execute(
      { workflow_id: "wf-1", summary: "Rename it" },
      makeCtx({ policyResolver: recordingResolver(records) }),
    );
    await new Promise((r) => setTimeout(r, 0));
    // The action receives schema defaults: `name` was not sent, so
    // `prepareActionArgs` supplied it.
    expect(calls).toEqual([{ workflow_id: "wf-1", name: "untitled" }]);
    // The audit record does NOT carry those defaults. `invokeAction` builds
    // the record from the arguments as received, and `prepareActionArgs` runs
    // afterwards inside `executeAction`, so the record answers "what was
    // asked for" rather than "what ran". That is the shared behaviour of
    // every path — `call_tool` and the slash-command path record the same
    // way — so the pinned tool matching it is the point.
    //
    // What this test actually guards is the summary: it must reach neither
    // the action's arguments nor the audit params.
    expect(records[0]?.params).toEqual({ workflow_id: "wf-1" });
  });

  it("falls back to the derived summary when the model sends a blank one", async () => {
    const { plugin } = makePinnablePlugin();
    const records: PolicyInvocationRecord[] = [];
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    await pinned?.execute(
      { workflow_id: "wf-1", summary: "   " },
      makeCtx({ policyResolver: recordingResolver(records) }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(records[0]?.summary).toBe("Patch workflow (workflows__patch_workflow)");
  });

  it("distinguishes two calls to one action by purpose", async () => {
    // The audit trail's whole point on this route: a constant summary makes
    // two different edits indistinguishable after the fact.
    const { plugin } = makePinnablePlugin();
    const records: PolicyInvocationRecord[] = [];
    const [, , pinned] = pluginCatalogTools({ plugins: [plugin], pins: [PATCH_PIN] });
    const ctx = makeCtx({ policyResolver: recordingResolver(records) });
    await pinned?.execute({ workflow_id: "wf-1", summary: "Add a Slack notify step" }, ctx);
    await pinned?.execute({ workflow_id: "wf-1", summary: "Drop the approval gate" }, ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(records.map((r) => r.summary)).toEqual([
      "Add a Slack notify step",
      "Drop the approval gate",
    ]);
  });
});
