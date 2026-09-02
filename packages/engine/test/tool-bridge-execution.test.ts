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
    const result = await tool.execute("tc-1", {}, new AbortController().signal, () => {});
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
    const result = await tool.execute("tc-2", {}, new AbortController().signal, () => {});
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });
});
