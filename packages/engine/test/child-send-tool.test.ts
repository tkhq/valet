/**
 * `child_send` builtin tool: steer a spawned child session over a
 * host-injected ChildSender.
 *
 * Drives the tool's execute() directly with a hand-built ToolContext (see
 * task-tool.test.ts) and a fake sender in `ctx.config.childSender`.
 */
import { describe, it, expect, vi } from "vitest";
import { childSendTool } from "../src/builtin-tools/index.js";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
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

describe("child_send tool: params schema", () => {
  it("rejects an empty message", () => {
    expect(childSendTool.parameters.properties.message.minLength).toBe(1);
  });
});

describe("child_send tool: no sender", () => {
  it("returns [child_send_unavailable] when ctx.config has no childSender", async () => {
    const ctx = makeCtx({ config: undefined });
    const result = await childSendTool.execute(
      { child_session_id: "child-1", message: "go left" },
      ctx,
    );
    expect(result.text).toBe(
      "[child_send_unavailable] this session cannot message child sessions",
    );
  });

  it("returns [child_send_unavailable] when childSender is not a function", async () => {
    const ctx = makeCtx({ config: { childSender: "not-a-function" } });
    const result = await childSendTool.execute(
      { child_session_id: "child-1", message: "go left" },
      ctx,
    );
    expect(result.text).toBe(
      "[child_send_unavailable] this session cannot message child sessions",
    );
  });
});

describe("child_send tool: sender present", () => {
  it("passes message/interrupt through, and ctx fields reach the sender", async () => {
    let seenReq: { childSessionId: string; message: string; interrupt?: boolean } | undefined;
    let seenCtx:
      | { parentSessionId: string; parentThreadId: string; actorUserId: string }
      | undefined;
    const sender = vi.fn(
      async (
        req: { childSessionId: string; message: string; interrupt?: boolean },
        sendCtx: { parentSessionId: string; parentThreadId: string; actorUserId: string },
      ) => {
        seenReq = req;
        seenCtx = sendCtx;
        return { queueItemId: "queue-2" };
      },
    );
    const ctx = makeCtx({
      sessionId: "parent-session",
      threadId: "parent-thread",
      userId: "u1",
      config: { childSender: sender },
    });

    const result = await childSendTool.execute(
      { child_session_id: "child-1", message: "drop the fallback, fix the chart", interrupt: true },
      ctx,
    );

    expect(sender).toHaveBeenCalledTimes(1);
    expect(seenReq).toEqual({
      childSessionId: "child-1",
      message: "drop the fallback, fix the chart",
      interrupt: true,
    });
    expect(seenCtx).toEqual({
      parentSessionId: "parent-session",
      parentThreadId: "parent-thread",
      actorUserId: "u1",
    });
    expect(result.text).toContain("child-1");
    expect(result.text).toContain("queue-2");
    expect(result.text).toContain("child.settled");
  });

  it("answers null from the sender with [child_not_found]", async () => {
    const ctx = makeCtx({ config: { childSender: async () => null } });
    const result = await childSendTool.execute(
      { child_session_id: "not-mine", message: "hello" },
      ctx,
    );
    expect(result.text).toContain("[child_not_found]");
    expect(result.text).toContain("not-mine");
  });

  it("propagates sender rejection as a thrown error", async () => {
    const ctx = makeCtx({
      config: {
        childSender: async () => {
          throw new Error("engine store unavailable");
        },
      },
    });
    await expect(
      childSendTool.execute({ child_session_id: "child-1", message: "hello" }, ctx),
    ).rejects.toThrow("engine store unavailable");
  });
});
