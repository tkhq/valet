import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import {
  pluginCatalogTools,
  prepareActionArgs,
  matchesToolPattern,
  RESOLVE_TTL_MS,
  Engine,
  InMemoryCredentialStore,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type ActionPlugin,
  type ApprovalOverrideRule,
  type BusEvent,
  type Credential,
  type CredentialProvider,
  type DecisionResolution,
  type PluginAction,
  type PluginActionContext,
  type PluginActionResult,
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

describe("prepareActionArgs", () => {
  it("does not mutate the caller's params object when applying defaults", () => {
    const schema = Type.Object({ n: Type.Optional(Type.Number({ default: 25 })) });
    const params = {};
    const result = prepareActionArgs(schema, params);
    expect(result.ok).toBe(true);
    expect(params).toEqual({});
  });
});

describe("matchesToolPattern", () => {
  it("* matches any qualified id", () => {
    expect(matchesToolPattern("*", "github.merge_pull_request")).toBe(true);
    expect(matchesToolPattern("*", "linear.create_issue")).toBe(true);
    expect(matchesToolPattern("*", "svc.act")).toBe(true);
  });

  it("github.* matches github service tools and not others", () => {
    expect(matchesToolPattern("github.*", "github.merge_pull_request")).toBe(true);
    expect(matchesToolPattern("github.*", "github.get_issue")).toBe(true);
    expect(matchesToolPattern("github.*", "linear.create_issue")).toBe(false);
  });

  it("exact id match", () => {
    expect(matchesToolPattern("github.create_issue", "github.create_issue")).toBe(true);
    expect(matchesToolPattern("github.create_issue", "github.delete_repo")).toBe(false);
  });

  it("dot in pattern is literal — github.x does not match githubax", () => {
    expect(matchesToolPattern("github.x", "githubax")).toBe(false);
  });

  it("a.b*c does not treat . as regex-any", () => {
    // The pattern a.b*c should match a.bXXXc but not a_bXXXc (dot is literal)
    expect(matchesToolPattern("a.b*c", "a.bXXXc")).toBe(true);
    expect(matchesToolPattern("a.b*c", "aXbXXXc")).toBe(false);
  });

  it("wildcard matches across dots", () => {
    expect(matchesToolPattern("github.*", "github.some.deeply.nested")).toBe(true);
  });
});

describe("pluginCatalogTools: approval overrides", () => {
  function makeLowRiskPlugin(): ActionPlugin {
    return {
      service: "svc",
      actions: [
        {
          id: "svc.act",
          name: "Act",
          description: "a low-risk action",
          riskLevel: "low",
          parameters: Type.Object({}),
          execute: async () => ({ success: true, data: { ran: true } }),
        },
      ],
    };
  }

  it("wildcard deny rule blocks a low-risk (default allow) action", async () => {
    const plugin = makeLowRiskPlugin();
    const overrides: ApprovalOverrideRule[] = [{ match: "*", mode: "deny" }];
    const [, callTool] = pluginCatalogTools({ plugins: [plugin], approvalOverrides: overrides });

    const result = await callTool.execute(
      { tool_id: "svc.act", params: {}, summary: "test" },
      makeCtx(),
    );
    expect(result.text).toContain("blocked by org policy");
  });

  it("non-matching deny rule leaves the action allowed", async () => {
    const plugin = makeLowRiskPlugin();
    const overrides: ApprovalOverrideRule[] = [{ match: "svc.other", mode: "deny" }];
    const [, callTool] = pluginCatalogTools({ plugins: [plugin], approvalOverrides: overrides });

    const result = await callTool.execute(
      { tool_id: "svc.act", params: {}, summary: "test" },
      makeCtx(),
    );
    expect(result.text).toContain("ran");
    expect(result.text).not.toContain("blocked");
  });

  it("first-match-wins: allow before wildcard deny lets specific action through", async () => {
    const plugin = makeLowRiskPlugin();
    const overrides: ApprovalOverrideRule[] = [
      { match: "svc.act", mode: "allow" },
      { match: "*", mode: "deny" },
    ];
    const [, callTool] = pluginCatalogTools({ plugins: [plugin], approvalOverrides: overrides });

    const result = await callTool.execute(
      { tool_id: "svc.act", params: {}, summary: "test" },
      makeCtx(),
    );
    expect(result.text).toContain("ran");
    expect(result.text).not.toContain("blocked");
  });

  it("no override → existing riskLevel default applies (low → allow)", async () => {
    const plugin = makeLowRiskPlugin();
    const [, callTool] = pluginCatalogTools({ plugins: [plugin] });

    const result = await callTool.execute(
      { tool_id: "svc.act", params: {}, summary: "test" },
      makeCtx(),
    );
    expect(result.text).toContain("ran");
  });
});
