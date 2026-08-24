/**
 * `child_push_file` built-in and the `task` tool's `files` passthrough,
 * executed directly with a stub ToolContext — the production pusher and
 * spawner live API-side. These tests pin the tools' own branches:
 * unavailable, not-found, success text, and that the parent's sandbox
 * handle reaches the host callbacks (staged-files design, 2026-08-23).
 */
import { describe, expect, it } from "vitest";
import { builtinTools, childPushFileTool, taskTool } from "../src/builtin-tools/index.js";
import type {
  ChildFilePusher,
  ChildSpawner,
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

// Neither tool dereferences the sandbox itself — it is handed verbatim to
// the host callback, which these tests stub. Same idiom as
// child-read-tool.test.ts's empty stub.
const sandboxToken = { id: "sb-parent" } as Sandbox;

function makeCtx(config: Record<string, unknown>): ToolContext {
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "orchestrator:u1",
    threadId: "t1",
    credentials: stubCredentials,
    sandbox: sandboxToken,
    config,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
}

describe("childPushFileTool", () => {
  it("is registered in builtinTools", () => {
    expect(builtinTools.map((t) => t.name)).toContain("child_push_file");
  });

  it("reports unavailable when no pusher is configured", async () => {
    const result = await childPushFileTool.execute(
      { child_session_id: "child_x", from: "report.md" },
      makeCtx({}),
    );
    expect(result.text).toContain("[child_push_file_unavailable]");
  });

  it("passes the parent sandbox and paths to the pusher and names the staged target", async () => {
    const seen: Array<{ req: unknown; sandbox: Sandbox }> = [];
    const pusher: ChildFilePusher = async (req, ctx) => {
      seen.push({ req, sandbox: ctx.sandbox });
      return { targetPath: ".valet/shared/report.md" };
    };
    const result = await childPushFileTool.execute(
      { child_session_id: "child_x", from: "report.md" },
      makeCtx({ childFilePusher: pusher }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].sandbox).toBe(sandboxToken);
    expect(result.text).toContain("/workspace/.valet/shared/report.md");
    expect(result.text).toContain("next run-start");
  });

  it("reports child_not_found on a null pusher result", async () => {
    const pusher: ChildFilePusher = async () => null;
    const result = await childPushFileTool.execute(
      { child_session_id: "child_x", from: "report.md" },
      makeCtx({ childFilePusher: pusher }),
    );
    expect(result.text).toContain("[child_not_found]");
  });
});

describe("taskTool files passthrough", () => {
  it("forwards files to the spawner along with the parent sandbox", async () => {
    const seen: Array<{ files?: unknown; sandbox?: Sandbox }> = [];
    const spawner: ChildSpawner = async (req, ctx) => {
      seen.push({ files: req.files, sandbox: ctx.sandbox });
      return { childSessionId: "child_y", queueItemId: "q1" };
    };
    const result = await taskTool.execute(
      {
        prompt: "analyze the data",
        files: [{ from: "data", to: "input/data" }],
      },
      makeCtx({ childSpawner: spawner }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].files).toEqual([{ from: "data", to: "input/data" }]);
    expect(seen[0].sandbox).toBe(sandboxToken);
    expect(result.text).toContain("child_y");
  });
});
