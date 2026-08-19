/**
 * `child_status` built-in, executed directly with a stub ToolContext — the
 * production reader lives API-side (`buildChildStatusReader`); these tests
 * pin the tool's own branches: unavailable, not-found, running with an
 * activity clock, and settled without one. Follows the stub-ctx idiom of
 * child-read-tool.test.ts.
 */
import { describe, expect, it } from "vitest";
import { builtinTools, childStatusTool } from "../src/builtin-tools/index.js";
import type {
  ChildStatusReader,
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

function makeCtx(childStatusReader?: ChildStatusReader): ToolContext {
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "orchestrator:u1",
    threadId: "t1",
    credentials: stubCredentials,
    // child_status never touches the sandbox — an empty stub proves it.
    sandbox: {} as Sandbox,
    config: childStatusReader ? { childStatusReader } : {},
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
}

describe("childStatusTool", () => {
  it("is registered in builtinTools", () => {
    expect(builtinTools.map((t) => t.name)).toContain("child_status");
  });

  it("says the session cannot check children when no reader is wired", async () => {
    const result = await childStatusTool.execute({ child_session_id: "child_abc" }, makeCtx());
    expect(result.text).toContain("[child_status_unavailable]");
  });

  it("answers not-found for a null reader result without confirming the id exists", async () => {
    const reader: ChildStatusReader = async () => null;
    const result = await childStatusTool.execute({ child_session_id: "child_other" }, makeCtx(reader));
    expect(result.text).toContain("[child_not_found]");
    expect(result.text).toContain("child_other");
  });

  it("reports a running child with its last activity time", async () => {
    const lastActivityAt = Date.now() - 30_000;
    const reader: ChildStatusReader = async (req, ctx) => {
      expect(req.childSessionId).toBe("child_abc");
      expect(ctx.parentSessionId).toBe("orchestrator:u1");
      return { settled: false, lastActivityAt };
    };
    const result = await childStatusTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("running");
    expect(result.text).toContain(new Date(lastActivityAt).toISOString());
  });

  it("reports a settled child with no activity clock", async () => {
    const reader: ChildStatusReader = async () => ({ settled: true, lastActivityAt: null });
    const result = await childStatusTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("settled");
    expect(result.text).toContain("no queue activity recorded");
  });
});
