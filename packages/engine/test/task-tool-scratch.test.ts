/**
 * `task` tool: scratch resource requests. Tests the tool's acceptance,
 * validation, and error handling of `resources.scratch` parameters passed
 * through to a host-injected ChildSpawner.
 */
import { describe, it, expect, vi } from "vitest";
import { ScratchRequestError, isScratchRequestError } from "@valet/shared";
import { taskTool } from "../src/builtin-tools/index.js";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Principal,
  Sandbox,
  SessionEntry,
  SpawnChildRequest,
  SpawnChildResult,
  ToolContext,
} from "../src/types.js";

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
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...overrides,
  };
}

describe("task tool: resources.scratch", () => {
  it("passes resources.scratch to the spawner trimmed", async () => {
    const spawner = vi.fn(async () => ({ childSessionId: "c1", queueItemId: "q1" }));
    const r = await taskTool.execute(
      { prompt: "p", resources: { scratch: " 50Gi " } },
      makeCtx({ config: { childSpawner: spawner } }),
    );
    expect(spawner.mock.calls[0]?.[0].resources).toEqual({ scratch: "50Gi" });
    expect(r.text).toContain("spawned child session c1");
  });

  it("renders a ScratchRequestError from the spawner as a task_resources refusal", async () => {
    const spawner = vi.fn(async () => {
      throw new ScratchRequestError(
        "agent_cap",
        "scratch 200Gi exceeds the 100Gi agent cap (sandbox.scratchAgentMax). Declare it in .valet/prebuild.yaml, or ask an admin to raise the cap.",
      );
    });
    const r = await taskTool.execute(
      { prompt: "p", resources: { scratch: "200Gi" } },
      makeCtx({ config: { childSpawner: spawner } }),
    );
    expect(r.text).toBe(
      "[task_resources] scratch 200Gi exceeds the 100Gi agent cap (sandbox.scratchAgentMax). Declare it in .valet/prebuild.yaml, or ask an admin to raise the cap.",
    );
  });

  it("refuses a non-string scratch before calling the spawner", async () => {
    const spawner = vi.fn();
    const r = await taskTool.execute(
      { prompt: "p", resources: { scratch: "nope" } },
      makeCtx({ config: { childSpawner: spawner } }),
    );
    expect(r.text).toBe(
      '[task_resources] scratch "nope" is not a Kubernetes quantity of at least 1Gi. Use a form like "200Gi".',
    );
    expect(spawner).not.toHaveBeenCalled();
  });
});
