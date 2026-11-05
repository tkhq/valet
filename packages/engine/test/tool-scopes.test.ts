import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import { builtinTools, Engine, InMemoryEventStream, InMemorySessionStore, pluginCatalogTools, UNATTENDED_WORKFLOW_DECISION, VirtualSandboxProvider, type DecisionResolution, type PolicyResolver, type ToolDef } from "../src/index.js";
import { CONTINUATION_TOOL_SCOPE_KEY, UNATTENDED_WORKFLOW_KEY } from "@valet/shared";

describe.each(["user", "team"] as const)("%s task scopes", (ownerType) => {
  it("persists a continuation ceiling per thread and replaces it for a new task", async () => {
    const faux = registerFauxProvider({ provider: `scope-continuation-${ownerType}` });
    try {
      const store = new InMemorySessionStore();
      const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
      const options = { userId: "alice", orgId: "org", owner: { type: ownerType, id: ownerType === "user" ? "alice" : "team" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [] };
      const session = await engine.createSession(options);
      const scoped = await session.createThread("scoped");
      const other = await session.createThread("other");
      faux.setResponses([fauxAssistantMessage("done")]);
      const receipt = await scoped.submitPrompt("inspect", { metadata: { toolScope: { tools: [], actions: [] } } });
      await scoped.awaitResult(receipt.queueItemId);
      expect((await store.getThread(session.id, scoped.id))?.metadata?.[CONTINUATION_TOOL_SCOPE_KEY]).toEqual({ tools: [], actions: [] });
      expect((await store.getThread(session.id, other.id))?.metadata?.[CONTINUATION_TOOL_SCOPE_KEY]).toBeUndefined();
      const fresh = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
      const restored = await fresh.restoreSession({ sessionId: session.id, options });
      expect(restored.threadById(scoped.id)?.toThreadData().metadata?.[CONTINUATION_TOOL_SCOPE_KEY]).toEqual({ tools: [], actions: [] });
      faux.setResponses([fauxAssistantMessage("done")]);
      const restoredThread = restored.threadById(scoped.id);
      if (!restoredThread) throw new Error("restored thread missing");
      const next = await restoredThread.submitPrompt("new task", {});
      await restoredThread.awaitResult(next.queueItemId);
      expect((await store.getThread(session.id, scoped.id))?.metadata?.[CONTINUATION_TOOL_SCOPE_KEY]).toEqual({});
    } finally { faux.unregister(); }
  });

  it("offers newly selected tools on the next model call in the same submission", async () => {
    const faux = registerFauxProvider({ provider: `scope-refresh-${ownerType}` });
    const store = new InMemorySessionStore();
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    let writes = 0;
    const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: ownerType, id: ownerType === "user" ? "alice" : "team" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [],
      initialToolFocus: () => ({ tools: ["focus_tools"] }),
      tools: [
        { name: "focus_tools", description: "Focus", parameters: Type.Object({}), execute: async (_, ctx) => { await ctx.setToolFocus?.(undefined); return { text: "general" }; } },
        { name: "write_record", description: "Write", parameters: Type.Object({}), execute: async () => { writes++; return { text: "saved" }; } },
      ],
    });
    const thread = await session.createThread("editor");
    expect((await store.getThread(session.id, thread.id))?.metadata?.toolScope).toEqual({ tools: ["focus_tools"] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("focus_tools", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("write_record", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const receipt = await session.prompt("repair", { threadId: thread.id });
    await thread.awaitResult(receipt.queueItemId);
    expect(writes).toBe(1);
    faux.unregister();
  });

  it("keeps a submission ceiling when collect mode combines messages", async () => {
    const faux = registerFauxProvider({ provider: `scope-collect-${ownerType}` });
    const store = new InMemorySessionStore();
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    let writes = 0;
    const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: ownerType, id: ownerType === "user" ? "alice" : "team" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [], collectWindowMs: 10,
      tools: [{ name: "write_record", description: "Write", parameters: Type.Object({}), execute: async () => { writes++; return { text: "saved" }; } }],
    });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("write_record", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    const receipt = await session.prompt("write", { queueMode: "collect", metadata: { toolScope: { tools: [], actions: [] } } });
    await session.thread().awaitResult(receipt.queueItemId);
    expect(writes).toBe(0);
    const items = await store.getEntries(session.id, receipt.threadId);
    expect(JSON.stringify(items)).not.toContain('"text":"saved"');
    faux.unregister();
  });

  it("isolates thread focus and refuses a stale same-batch write", async () => {
    const faux = registerFauxProvider({ provider: `scope-${ownerType}` });
    const store = new InMemorySessionStore();
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    const writes: string[] = [];
    const tools: ToolDef[] = [
      { name: "focus_tools", description: "Focus", parameters: Type.Object({}), execute: async (_, ctx) => {
        await ctx.setToolFocus?.({ tools: ["focus_tools"] }); return { text: "focused" };
      } },
      { name: "change_record", description: "Change", parameters: Type.Object({}), execute: async (_, ctx) => {
        writes.push(ctx.threadId); return { text: "changed" };
      } },
    ];
    const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: ownerType, id: ownerType === "user" ? "alice" : "owner" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [], tools });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("focus_tools", {}), fauxToolCall("change_record", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("finished"),
    ]);
    const first = await session.prompt("diagnose", { threadId: session.thread("private:alice").id });
    await session.thread("private:alice").awaitResult(first.queueItemId);
    expect(writes).toEqual([]);
    expect(JSON.stringify(await session.thread("private:alice").readEntries())).toContain("outside this task");
    faux.setResponses([fauxAssistantMessage([fauxToolCall("change_record", {})], { stopReason: "toolUse" }), fauxAssistantMessage("finished")]);
    const second = await session.prompt("change", { threadId: session.thread("private:bob").id });
    await session.thread("private:bob").awaitResult(second.queueItemId);
    expect(writes).toEqual([second.threadId]);
    const focused = await store.getThread(session.id, first.threadId);
    expect(focused?.metadata?.toolScope).toEqual({ tools: ["focus_tools"] });
    await Promise.all([
      session.thread("private:alice").setToolFocus({ actions: ["github.get_issue"] }),
      session.thread("private:bob").setToolFocus({ actions: ["slack.search"] }),
    ]);
    expect(session.thread("private:alice").effectiveToolScope()).toEqual({ actions: ["github.get_issue"] });
    expect(session.thread("private:bob").effectiveToolScope()).toEqual({ actions: ["slack.search"] });
    faux.unregister();
  });

  it("preserves a session ceiling on restore and ignores a broader focus", async () => {
    const faux = registerFauxProvider({ provider: `scope-restore-${ownerType}` });
    const store = new InMemorySessionStore();
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    const options = { userId: "alice", orgId: "org", owner: { type: ownerType, id: ownerType === "user" ? "alice" : "owner" }, workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [] };
    const session = await engine.createSession({ ...options, toolScope: { tools: [], actions: ["workflows.get_run"] } });
    const fresh = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
    const restored = await fresh.restoreSession({ sessionId: session.id, options });
    await restored.thread().setToolFocus({ tools: ["bash"], actions: ["slack.*"] });
    expect(restored.thread().effectiveToolScope()).toEqual({ tools: [], actions: [] });
    faux.unregister();
  });
});

describe("unattended workflow tasks", () => {
  const askQuestion = builtinTools.find((tool) => tool.name === "ask_question");
  /** Runs one turn whose tool asks for a decision. An attended turn only reports its flag. */
  async function decide(provider: string, purpose: "workflow" | "orchestrator", opts: { metadata?: Record<string, unknown>; ask: boolean }) {
    if (!askQuestion) throw new Error("ask_question missing");
    const faux = registerFauxProvider({ provider });
    const seen: { unattended?: boolean; resolution?: DecisionResolution; askText?: string } = {};
    try {
      const store = new InMemorySessionStore();
      const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
      const tools: ToolDef[] = [
        { name: "needs_decision", description: "Needs a decision", parameters: Type.Object({}), execute: async (_args, ctx) => {
          seen.unattended = ctx.unattendedWorkflow;
          if (ctx.unattendedWorkflow) seen.resolution = await ctx.requestDecision({ type: "approval", title: "Send it?", resumeKey: "needs_decision" });
          return { text: "checked" };
        } },
        { ...askQuestion, execute: async (args, ctx) => {
          const result = await askQuestion.execute(args, ctx);
          seen.askText = result.text;
          return result;
        } },
      ];
      const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: "team", id: "team" }, workspace: "/", sandbox: {}, purpose, model: faux.getModel(), builtinTools: [], tools });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("needs_decision", {})], { stopReason: "toolUse" }),
        ...(opts.ask ? [fauxAssistantMessage([fauxToolCall("ask_question", { question: "Which channel?" })], { stopReason: "toolUse" })] : []),
        fauxAssistantMessage("done"),
      ]);
      const receipt = await session.prompt("report", { metadata: opts.metadata ?? {} });
      const result = await session.thread().awaitResult(receipt.queueItemId);
      return { seen, outcome: result.outcome, gates: await store.listDecisionGates(session.id) };
    } finally { faux.unregister(); }
  }

  it.each([
    ["a workflow step session", "workflow", {}],
    ["a workflow task in an assistant thread", "orchestrator", { [UNATTENDED_WORKFLOW_KEY]: true }],
  ] as const)("refuses every decision in %s before a gate opens", async (label, purpose, metadata) => {
    const { seen, outcome, gates } = await decide(`unattended-${purpose}`, purpose, { metadata, ask: true });
    expect(outcome, label).toBe("completed");
    expect(seen.unattended, label).toBe(true);
    expect(seen.resolution, label).toMatchObject({ actionId: "deny", resolvedBy: UNATTENDED_WORKFLOW_DECISION });
    expect(seen.askText, label).toContain("this is an unattended run");
    expect(seen.askText, label).toContain("Say in the result what was missing");
    // The refused approval is on record for the workflow; nothing is pending.
    expect(gates.map((gate) => ({ status: gate.status, resolvedBy: gate.resolution?.resolvedBy, type: gate.type })), label)
      .toEqual([{ status: "resolved", resolvedBy: UNATTENDED_WORKFLOW_DECISION, type: "approval" }]);
  });

  it("refuses tool discovery through a teammate's account without failing the step", async () => {
    const faux = registerFauxProvider({ provider: "unattended-discovery" });
    try {
      const store = new InMemorySessionStore();
      const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
      let refusal: DecisionResolution | undefined;
      const tools: ToolDef[] = [{ name: "list_granola", description: "Lists tools", parameters: Type.Object({}), execute: async (_args, ctx) => {
        refusal = await ctx.requestDecision({ type: "approval", title: "Let a teammate use your Granola account?", resumeKey: "granola.__valet_discovery__:{}",
          context: { tool_id: "granola.__valet_discovery__" } });
        return { text: "listed" };
      } }];
      const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: "team", id: "team" }, workspace: "/", sandbox: {}, purpose: "workflow", model: faux.getModel(), builtinTools: [], tools });
      faux.setResponses([fauxAssistantMessage([fauxToolCall("list_granola", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
      const receipt = await session.prompt("roll up", {});
      await session.thread().awaitResult(receipt.queueItemId);
      expect(refusal).toMatchObject({ actionId: "deny", resolvedBy: UNATTENDED_WORKFLOW_DECISION });
      expect(await store.listDecisionGates(session.id)).toEqual([]);
    } finally { faux.unregister(); }
  });

  // Asking the lender would park the shared delivery thread again. The lender
  // grants lasting consent from an attended approval, or the team connects its
  // own account.
  it("refuses a teammate's shared account on an automated delivery and names the team account", async () => {
    const faux = registerFauxProvider({ provider: "unattended-delivery-borrow" });
    try {
      const store = new InMemorySessionStore();
      const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
      let executed = false;
      let callText: string | undefined;
      const [, callTool] = pluginCatalogTools({ plugins: [{ service: "linear", actions: [{ id: "linear.create_issue", name: "Create Issue", description: "Create an issue.",
        riskLevel: "low", parameters: Type.Object({}), execute: async () => { executed = true; return { success: true }; } }] }] });
      if (!callTool) throw new Error("call_tool missing");
      const policyResolver: PolicyResolver = { resolve: async () => ({ mode: "require_approval", provenance: { baseMode: "allow", source: "shared_account" },
        approver: { userId: "bea", shareGeneration: "generation", allowTeamConsent: true },
        extraGateActions: [{ id: "always_allow_account", label: "Always allow for this team", approves: true }] }) };
      const session = await engine.createSession({ userId: "alice", orgId: "org", owner: { type: "team", id: "team" }, workspace: "/", sandbox: {}, purpose: "orchestrator",
        model: faux.getModel(), builtinTools: [], policyResolver, automatedThread: ({ key }) => key === "events",
        tools: [{ ...callTool, execute: async (args, ctx) => {
          const result = await callTool.execute(args, ctx);
          callText = result.text;
          return result;
        } }] });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall(callTool.name, { tool_id: "linear.create_issue", params: {}, summary: "File the bug" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      const thread = await session.createThread("events");
      const receipt = await thread.submitPrompt({ kind: "signal", signalType: "linear.issue", body: "A bug came in" }, {});
      expect((await thread.awaitResult(receipt.queueItemId)).outcome).toBe("completed");
      expect(executed).toBe(false);
      expect(callText).toContain("Valet sent no approval request");
      expect(callText).toContain("connect a team account on the team's Integrations page");
      // No gate waits for the lender.
      expect((await store.listDecisionGates(session.id)).map((gate) => gate.status)).toEqual(["resolved"]);
    } finally { faux.unregister(); }
  });

  it("leaves a person's own prompt in an assistant thread attended", async () => {
    const { seen } = await decide("attended-orchestrator", "orchestrator", { ask: false });
    expect(seen.unattended).toBeUndefined();
  });
});
