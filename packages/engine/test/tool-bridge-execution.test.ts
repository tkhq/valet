import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { toAgentTool } from "../src/tool-bridge.js";
import { defineTool } from "../src/builtin-tools/index.js";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "../src/index.js";

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

// The tools under test never touch the sandbox — an empty stub proves it.
const buildCtx = (): ToolContext => ({
  userId: "u1",
  orgId: "o1",
  sessionId: "s1",
  threadId: "t1",
  credentials: stubCredentials,
  sandbox: {} as Sandbox,
  requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
    throw new Error("not implemented in test stub");
  },
  signal: new AbortController().signal,
  threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
  listThreads: async () => [],
  setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
});

describe("tool bridge: execution mode (TKAI-318)", () => {
  it("defaults to sequential — one unsafe tool serializes its batch in pi-agent-core", () => {
    const tool = toAgentTool(
      defineTool({
        name: "mutator",
        description: "writes things",
        parameters: Type.Object({}),
        execute: async () => ({ text: "ok" }),
      }),
      buildCtx,
    );
    expect(tool.executionMode).toBe("sequential");
  });

  it("an approval-capable tool is sequential even when marked concurrencySafe", () => {
    const tool = toAgentTool(
      defineTool({
        name: "gated-reader",
        description: "reads things behind an approval",
        parameters: Type.Object({}),
        concurrencySafe: true,
        requiresApproval: true,
        execute: async () => ({ text: "ok" }),
      }),
      buildCtx,
    );
    expect(tool.executionMode).toBe("sequential");
  });

  it("maps concurrencySafe to parallel", () => {
    const tool = toAgentTool(
      defineTool({
        name: "reader",
        description: "reads things",
        parameters: Type.Object({}),
        concurrencySafe: true,
        execute: async () => ({ text: "ok" }),
      }),
      buildCtx,
    );
    expect(tool.executionMode).toBe("parallel");
  });
});

describe("tool bridge: empty-result marker (TKAI-318)", () => {
  it("an empty tool result becomes a named no-output marker", async () => {
    const tool = toAgentTool(
      defineTool({
        name: "quiet",
        description: "returns nothing",
        parameters: Type.Object({}),
        execute: async () => ({ text: "" }),
      }),
      buildCtx,
    );
    const result = await tool.execute("tc-1", { intent: "Check the empty tool result." }, new AbortController().signal, () => {});
    expect(result.content).toEqual([{ type: "text", text: "(quiet completed with no output)" }]);
  });

  it("a non-empty result is untouched", async () => {
    const tool = toAgentTool(
      defineTool({
        name: "loud",
        description: "returns text",
        parameters: Type.Object({}),
        execute: async () => ({ text: "hello" }),
      }),
      buildCtx,
    );
    const result = await tool.execute("tc-2", { intent: "Check the tool result." }, new AbortController().signal, () => {});
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("tool bridge: terminal outcomes", () => {
  it("keeps a recognized side effect in persisted result details", async () => {
    const tool = toAgentTool(
      defineTool({
        name: "bash",
        description: "runs a command",
        parameters: Type.Object({}),
        execute: async () => ({ text: "https://github.com/acme/repo/pull/42", outcome: {
          kind: "pull_request_created" as const, url: "https://github.com/acme/repo/pull/42",
        } }),
      }),
      buildCtx,
    );
    const result = await tool.execute("tc-pr", {}, new AbortController().signal, () => {});
    expect(result.details).toEqual({ outcome: { kind: "pull_request_created", url: "https://github.com/acme/repo/pull/42" } });
  });
});

describe("shared tool intent", () => {
  it("requires intent before execution and strips it before context or policy work", async () => {
    const seen: Record<string, unknown>[] = [];
    const tool = toAgentTool(defineTool({
      name: "call_tool", description: "Test the broker boundary", parameters: Type.Object({ tool_id: Type.String(), params: Type.Object({ x: Type.Number() }) }),
      execute: async args => { seen.push(args); return { text: "ok" }; },
    }), input => {
      seen.push(input.toolArgs);
      return buildCtx();
    });
    expect(tool.parameters.required).toContain("intent");
    const missing = await tool.execute("missing", { tool_id: "demo.echo", params: { x: 1 } });
    expect(missing.content).toEqual([{ type: "text", text: expect.stringContaining("Add intent") }]);
    expect(seen).toEqual([{}]);
    seen.length = 0;
    await tool.execute("valid", { tool_id: "demo.echo", params: { x: 1 }, intent: "  Read the demo value to check the connection.  " });
    expect(seen).toEqual([{ tool_id: "demo.echo", params: { x: 1 } }, { tool_id: "demo.echo", params: { x: 1 } }]);
  });

  it("does not change or record exempt primitives", async () => {
    const def = defineTool({ name: "bash", description: "Shell", parameters: Type.Object({ command: Type.String() }), execute: async () => ({ text: "done" }) });
    const tool = toAgentTool(def, buildCtx);
    expect(tool.parameters).toBe(def.parameters);
    expect(tool.parameters.properties).not.toHaveProperty("intent");
    await tool.execute("shell", { command: "pwd" });
  });
});
