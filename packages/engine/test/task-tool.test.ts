/**
 * `task` builtin tool: child spawning over a host-injected ChildSpawner
 * (Phase 4 decision 10).
 *
 * Drives the tool's execute() directly with a hand-built ToolContext (see
 * bash-job-mode.test.ts makeCtx idiom) and a fake spawner in
 * `ctx.config.childSpawner`.
 */
import { describe, it, expect, vi } from "vitest";
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

describe("task tool: params schema", () => {
  it("rejects an empty prompt", () => {
    const result = taskTool.parameters.properties.prompt.minLength;
    expect(result).toBe(1);
  });
});

describe("task tool: no spawner", () => {
  it("returns [task_unavailable] without throwing when ctx.config has no childSpawner", async () => {
    const ctx = makeCtx({ config: undefined });
    const result = await taskTool.execute({ prompt: "do the thing" }, ctx);
    expect(result.text).toBe("[task_unavailable] this session cannot spawn child sessions");
  });

  it("returns [task_unavailable] when childSpawner is present but not a function", async () => {
    const ctx = makeCtx({ config: { childSpawner: "not-a-function" } });
    const result = await taskTool.execute({ prompt: "do the thing" }, ctx);
    expect(result.text).toBe("[task_unavailable] this session cannot spawn child sessions");
  });
});

describe("task tool: spawner present", () => {
  it("passes prompt/title/model through, and ctx fields reach the spawner", async () => {
    const owner: Principal = { type: "user", id: "u1" };
    let seenReq: SpawnChildRequest | undefined;
    let seenCtx:
      | {
          parentSessionId: string;
          parentThreadId: string;
          actorUserId: string;
          owner: Principal;
          sandbox?: import("../src/types.js").Sandbox;
        }
      | undefined;
    const spawner = vi.fn(async (req: SpawnChildRequest, spawnCtx) => {
      seenReq = req;
      seenCtx = spawnCtx;
      return { childSessionId: "child-1", queueItemId: "queue-1" } satisfies SpawnChildResult;
    });
    const ctx = makeCtx({
      sessionId: "parent-session",
      threadId: "parent-thread",
      userId: "u1",
      owner,
      config: { childSpawner: spawner },
    });

    const result = await taskTool.execute(
      { prompt: "build the widget", title: "Widget", model: "claude-haiku-4-5" },
      ctx,
    );

    expect(spawner).toHaveBeenCalledTimes(1);
    expect(seenReq).toEqual({
      prompt: "build the widget",
      title: "Widget",
      repo: undefined,
      branch: undefined,
      model: "claude-haiku-4-5",
    });
    expect(seenCtx).toEqual({
      parentSessionId: "parent-session",
      parentThreadId: "parent-thread",
      actorUserId: "u1",
      owner,
      // The parent's sandbox handle rides along for files[] snapshots
      // (staged-files design, 2026-08-23).
      sandbox: ctx.sandbox,
    });
    expect(result.text).toBe(
      "spawned child session child-1 (submission queue-1). Its result will arrive in this thread as a child.settled signal.",
    );
    expect(result.text).toContain("child.settled");
  });

  it("propagates spawner rejection (e.g. child cap) as a thrown error", async () => {
    const spawner = vi.fn(async () => {
      throw new Error("[child_cap] 10 running children (limit 10)");
    });
    const ctx = makeCtx({ config: { childSpawner: spawner } });

    await expect(taskTool.execute({ prompt: "do the thing" }, ctx)).rejects.toThrow(
      "[child_cap] 10 running children (limit 10)",
    );
  });

  it("defaults owner to {type: user, id: ctx.userId} when ctx.owner is absent", async () => {
    let seenCtx:
      | {
          parentSessionId: string;
          parentThreadId: string;
          actorUserId: string;
          owner: Principal;
          sandbox?: import("../src/types.js").Sandbox;
        }
      | undefined;
    const spawner = vi.fn(async (_req: SpawnChildRequest, spawnCtx) => {
      seenCtx = spawnCtx;
      return { childSessionId: "child-2", queueItemId: "queue-2" } satisfies SpawnChildResult;
    });
    const ctx = makeCtx({ userId: "u2", owner: undefined, config: { childSpawner: spawner } });

    await taskTool.execute({ prompt: "do the thing" }, ctx);

    expect(seenCtx?.owner).toEqual({ type: "user", id: "u2" });
  });
});
