import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import {
  pluginCatalogTools,
  type ActionPlugin,
  type Credential,
  type CredentialProvider,
  type DecisionGateRequest,
  type DecisionResolution,
  type PluginAction,
  type PolicyDecision,
  type PolicyInvocationRecord,
  type PolicyResolveInput,
  type PolicyResolver,
  type Sandbox,
  type SessionEntry,
  type ToolContext,
} from "../src/index.js";

// ── Fixtures ───────────────────────────────────────────────────────

function makeAction(over: Partial<PluginAction> = {}): PluginAction {
  return {
    id: "github.get_issue",
    name: "Get Issue",
    description: "Read an issue.",
    riskLevel: "low",
    parameters: Type.Object({ n: Type.Integer() }),
    execute: async () => ({ success: true, data: { ok: true } }),
    ...over,
  };
}

function makePlugin(action: PluginAction): ActionPlugin {
  return { service: "github", actions: [action] };
}

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

type FakeSandbox = Partial<Sandbox> & { id: string };

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

/** Records onInvocation calls; each helper returns a resolver + its capture buffers. */
function makeResolver(
  over: Partial<PolicyResolver> & { decision?: PolicyDecision } = {},
): {
  resolver: PolicyResolver;
  resolveInputs: PolicyResolveInput[];
  invocations: PolicyInvocationRecord[];
  onResolutionCalls: Array<{ input: PolicyResolveInput; resolution: DecisionResolution }>;
} {
  const resolveInputs: PolicyResolveInput[] = [];
  const invocations: PolicyInvocationRecord[] = [];
  const onResolutionCalls: Array<{ input: PolicyResolveInput; resolution: DecisionResolution }> = [];
  const decision: PolicyDecision = over.decision ?? {
    mode: "allow",
    provenance: { baseMode: "allow", source: "test" },
  };
  const resolver: PolicyResolver = {
    resolve:
      over.resolve ??
      (async (input) => {
        resolveInputs.push(input);
        return decision;
      }),
    onResolution:
      over.onResolution ??
      (async (input, _d, resolution) => {
        onResolutionCalls.push({ input, resolution });
      }),
    onInvocation:
      over.onInvocation ??
      (async (record) => {
        invocations.push(record);
      }),
  };
  return { resolver, resolveInputs, invocations, onResolutionCalls };
}

// ── Absent-resolver pins (byte-identical) ──────────────────────────

describe("policyResolver seam: absent resolver", () => {
  it("low-risk allow executes without touching any policy machinery", async () => {
    let executed = false;
    const [, callTool] = pluginCatalogTools({
      plugins: [makePlugin(makeAction({ execute: async () => { executed = true; return { success: true, data: { ok: true } }; } }))],
    });
    const result = await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx(),
    );
    expect(executed).toBe(true);
    expect(result.text).toContain("ok");
  });

  it("critical-risk gate uses the default (undefined) actions — fromRequest defaults them", async () => {
    let gateReq: DecisionGateRequest | undefined;
    const [, callTool] = pluginCatalogTools({
      plugins: [makePlugin(makeAction({ riskLevel: "critical" }))],
    });
    await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx({
        requestDecision: async (req) => {
          gateReq = req;
          return { actionId: "approve", resolvedBy: "u1", resolvedAt: Date.now() };
        },
      }),
    );
    expect(gateReq).toBeDefined();
    // Absent resolver must NOT inject explicit actions — the engine defaults them.
    expect(gateReq?.actions).toBeUndefined();
    // And no provenance leaks into the gate context.
    expect((gateReq?.context as Record<string, unknown>)?.provenance).toBeUndefined();
  });

  it("deny text is unchanged when a plugin declares defaultApprovalMode=deny", async () => {
    const plugin: ActionPlugin = {
      service: "github",
      defaultApprovalMode: "deny",
      actions: [makeAction()],
    };
    const [, callTool] = pluginCatalogTools({ plugins: [plugin] });
    const result = await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx(),
    );
    expect(result.text).toBe("denied: github.get_issue is blocked by org policy");
  });
});

// ── Present resolver ───────────────────────────────────────────────

describe("policyResolver seam: resolve()", () => {
  it("receives the exact PolicyResolveInput with appliesIn=session", async () => {
    const { resolver, resolveInputs } = makeResolver();
    const [, callTool] = pluginCatalogTools({ plugins: [makePlugin(makeAction())] });
    await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 7 }, summary: "s" },
      makeCtx({ policyResolver: resolver, userId: "U", orgId: "O", sessionId: "S", threadId: "T" }),
    );
    expect(resolveInputs).toHaveLength(1);
    expect(resolveInputs[0]).toEqual({
      service: "github",
      actionId: "github.get_issue",
      riskLevel: "low",
      params: { n: 7 },
      userId: "U",
      orgId: "O",
      sessionId: "S",
      threadId: "T",
      appliesIn: "session",
    });
  });

  it("allow → straight through, one completed record with durationMs + resolvedMode allow", async () => {
    const { resolver, invocations } = makeResolver();
    let executed = false;
    const [, callTool] = pluginCatalogTools({
      plugins: [makePlugin(makeAction({ execute: async () => { executed = true; return { success: true, data: { ok: 1 } }; } }))],
    });
    const result = await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "hello" },
      makeCtx({ policyResolver: resolver }),
    );
    expect(executed).toBe(true);
    expect(result.text).toContain("ok");
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe("completed");
    expect(invocations[0].resolvedMode).toBe("allow");
    expect(invocations[0].provenance.source).toBe("test");
    expect(invocations[0].summary).toBe("hello");
    expect(typeof invocations[0].durationMs).toBe("number");
  });

  it("deny → refusal text + one denied record, execute never runs", async () => {
    let executed = false;
    const { resolver, invocations } = makeResolver({
      decision: { mode: "deny", provenance: { baseMode: "deny", source: "org_policy_42" } },
    });
    const [, callTool] = pluginCatalogTools({
      plugins: [makePlugin(makeAction({ execute: async () => { executed = true; return { success: true, data: {} }; } }))],
    });
    const result = await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx({ policyResolver: resolver }),
    );
    expect(executed).toBe(false);
    expect(result.text).toBe("denied: github.get_issue is blocked by org policy");
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe("denied");
    expect(invocations[0].resolvedMode).toBe("deny");
    expect(invocations[0].provenance.source).toBe("org_policy_42");
  });
});

describe("policyResolver seam: require_approval gate", () => {
  it("opens a gate with provenance in context + default actions plus stripped extras", async () => {
    let gateReq: DecisionGateRequest | undefined;
    const { resolver } = makeResolver({
      decision: {
        mode: "require_approval",
        provenance: { baseMode: "require_approval", source: "risk_high" },
        extraGateActions: [
          { id: "approve_always", label: "Always allow", style: "primary", approves: true },
        ],
      },
    });
    const [, callTool] = pluginCatalogTools({ plugins: [makePlugin(makeAction())] });
    await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx({
        policyResolver: resolver,
        requestDecision: async (req) => {
          gateReq = req;
          return { actionId: "approve", resolvedBy: "u1", resolvedAt: Date.now() };
        },
      }),
    );
    expect((gateReq?.context as Record<string, unknown>)?.provenance).toEqual({
      baseMode: "require_approval",
      source: "risk_high",
    });
    // Default approve/deny plus the extra, with `approves` stripped.
    expect(gateReq?.actions).toEqual([
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
      { id: "approve_always", label: "Always allow", style: "primary" },
    ]);
  });

  it("approve → executes; completed record shows resolvedMode require_approval", async () => {
    let executed = false;
    const { resolver, invocations, onResolutionCalls } = makeResolver({
      decision: { mode: "require_approval", provenance: { baseMode: "require_approval", source: "s" } },
    });
    const [, callTool] = pluginCatalogTools({
      plugins: [makePlugin(makeAction({ execute: async () => { executed = true; return { success: true, data: {} }; } }))],
    });
    await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx({
        policyResolver: resolver,
        requestDecision: async () => ({ actionId: "approve", resolvedBy: "u1", resolvedAt: Date.now() }),
      }),
    );
    expect(executed).toBe(true);
    expect(onResolutionCalls).toHaveLength(1);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe("completed");
    expect(invocations[0].resolvedMode).toBe("require_approval");
  });

  it("extra action with approves:true is treated as approval AFTER onResolution", async () => {
    const order: string[] = [];
    let executed = false;
    const { resolver } = makeResolver({
      decision: {
        mode: "require_approval",
        provenance: { baseMode: "require_approval", source: "s" },
        extraGateActions: [{ id: "grant", label: "Grant", approves: true }],
      },
      onResolution: async () => { order.push("onResolution"); },
    });
    const [, callTool] = pluginCatalogTools({
      plugins: [makePlugin(makeAction({ execute: async () => { order.push("execute"); executed = true; return { success: true, data: {} }; } }))],
    });
    await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx({
        policyResolver: resolver,
        requestDecision: async () => ({ actionId: "grant", resolvedBy: "u1", resolvedAt: Date.now() }),
      }),
    );
    expect(executed).toBe(true);
    expect(order).toEqual(["onResolution", "execute"]);
  });

  it("user deny → refusal + rejected record, execute never runs", async () => {
    let executed = false;
    const { resolver, invocations } = makeResolver({
      decision: { mode: "require_approval", provenance: { baseMode: "require_approval", source: "s" } },
    });
    const [, callTool] = pluginCatalogTools({
      plugins: [makePlugin(makeAction({ execute: async () => { executed = true; return { success: true, data: {} }; } }))],
    });
    const result = await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx({
        policyResolver: resolver,
        requestDecision: async () => ({ actionId: "deny", resolvedBy: "u1", resolvedAt: Date.now() }),
      }),
    );
    expect(executed).toBe(false);
    expect(result.text).toContain("did not approve");
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe("rejected");
  });

  it("onResolution throw → treated as not-approved, refusal mentions approval failed", async () => {
    let executed = false;
    const { resolver, invocations } = makeResolver({
      decision: { mode: "require_approval", provenance: { baseMode: "require_approval", source: "s" } },
      onResolution: async () => { throw new Error("db down"); },
    });
    const [, callTool] = pluginCatalogTools({
      plugins: [makePlugin(makeAction({ execute: async () => { executed = true; return { success: true, data: {} }; } }))],
    });
    const result = await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx({
        policyResolver: resolver,
        requestDecision: async () => ({ actionId: "approve", resolvedBy: "u1", resolvedAt: Date.now() }),
      }),
    );
    expect(executed).toBe(false);
    expect(result.text.toLowerCase()).toContain("approval");
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe("rejected");
  });
});

describe("policyResolver seam: fail-closed + audit edges", () => {
  it("resolve() throw → fails closed to require_approval with provenance source resolver_error", async () => {
    let gateReq: DecisionGateRequest | undefined;
    const { invocations } = makeResolver();
    const resolver: PolicyResolver = {
      resolve: async () => { throw new Error("resolver exploded"); },
      onInvocation: async (r) => { invocations.push(r); },
    };
    const [, callTool] = pluginCatalogTools({ plugins: [makePlugin(makeAction())] });
    const result = await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx({
        policyResolver: resolver,
        requestDecision: async (req) => {
          gateReq = req;
          return { actionId: "deny", resolvedBy: "u1", resolvedAt: Date.now() };
        },
      }),
    );
    expect(gateReq).toBeDefined();
    expect((gateReq?.context as Record<string, unknown>)?.provenance).toMatchObject({ source: "resolver_error" });
    expect(result.text).toContain("did not approve");
    expect(invocations[0].status).toBe("rejected");
    expect(invocations[0].provenance.source).toBe("resolver_error");
  });

  it("execute throw → error record with durationMs + error text", async () => {
    const { resolver, invocations } = makeResolver();
    const [, callTool] = pluginCatalogTools({
      plugins: [makePlugin(makeAction({ execute: async () => { throw new Error("boom"); } }))],
    });
    const result = await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx({ policyResolver: resolver }),
    );
    expect(result.text).toContain("boom");
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe("error");
    expect(typeof invocations[0].durationMs).toBe("number");
    expect(invocations[0].error).toContain("boom");
  });

  it("invalid params → one error record, execute never runs", async () => {
    let executed = false;
    const { resolver, invocations } = makeResolver();
    const [, callTool] = pluginCatalogTools({
      plugins: [makePlugin(makeAction({ execute: async () => { executed = true; return { success: true, data: {} }; } }))],
    });
    const result = await callTool.execute(
      { tool_id: "github.get_issue", params: { n: "not-int" }, summary: "s" },
      makeCtx({ policyResolver: resolver }),
    );
    expect(executed).toBe(false);
    expect(result.text).toContain("invalid params");
    expect(invocations).toHaveLength(1);
    expect(invocations[0].status).toBe("error");
  });

  it("onInvocation throwing never breaks call_tool", async () => {
    const resolver: PolicyResolver = {
      resolve: async () => ({ mode: "allow", provenance: { baseMode: "allow", source: "t" } }),
      onInvocation: async () => { throw new Error("sink down"); },
    };
    const [, callTool] = pluginCatalogTools({ plugins: [makePlugin(makeAction())] });
    const result = await callTool.execute(
      { tool_id: "github.get_issue", params: { n: 1 }, summary: "s" },
      makeCtx({ policyResolver: resolver }),
    );
    expect(result.text).toContain("ok");
  });
});
