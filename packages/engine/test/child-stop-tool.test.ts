/**
 * `child_stop` built-in, executed directly with a stub ToolContext. The
 * production stopper lives API-side (`buildChildStopper`); these tests pin
 * the tool's own branches: unavailable, not-found, idle, and stopped.
 */
import { describe, expect, it } from "vitest";
import { builtinTools, childStopTool } from "../src/builtin-tools/index.js";
import type {
  ChildStopper,
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "../src/types.js";

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(childStopper?: ChildStopper): ToolContext {
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "orchestrator:u1",
    threadId: "t1",
    credentials: stubCredentials,
    // child_stop never touches the sandbox — an empty stub proves it.
    sandbox: {} as Sandbox,
    config: childStopper ? { childStopper } : {},
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
}

describe("childStopTool", () => {
  it("is not a default builtin: the host adds it where children can spawn", () => {
    expect(builtinTools.map((t) => t.name)).not.toContain("child_stop");
  });

  it("says the session cannot stop children when no stopper is wired", async () => {
    const result = await childStopTool.execute({ child_session_id: "child_abc" }, makeCtx());
    expect(result.text).toContain("[child_stop_unavailable]");
  });

  it("answers not-found for a null stopper result", async () => {
    const stopper: ChildStopper = async () => null;
    const result = await childStopTool.execute({ child_session_id: "child_x" }, makeCtx(stopper));
    expect(result.text).toContain("[child_not_found]");
  });

  it("says an idle child had nothing to stop", async () => {
    const stopper: ChildStopper = async () => ({ stopped: 0 });
    const result = await childStopTool.execute({ child_session_id: "child_idle" }, makeCtx(stopper));
    expect(result.text).toBe("child child_idle had no running or queued work to stop.");
  });

  it("passes the parent's session and thread and reports what it stopped", async () => {
    let seen: Parameters<ChildStopper> | undefined;
    const stopper: ChildStopper = async (...args) => { seen = args; return { stopped: 2 }; };
    const result = await childStopTool.execute({ child_session_id: "child_busy" }, makeCtx(stopper));
    expect(seen).toEqual([{ childSessionId: "child_busy" }, { parentSessionId: "orchestrator:u1", parentThreadId: "t1" }]);
    expect(result.text).toContain("stopped child child_busy (2 submissions aborted)");
  });
});
