/**
 * `child_read` built-in, executed directly with a stub ToolContext — the
 * production reader lives API-side (`buildChildReader`); these tests pin
 * the tool's own branches: unavailable, not-found, empty, render, and the
 * output byte ceiling.
 */
import { describe, expect, it } from "vitest";
import {
  builtinTools,
  childReadTool,
  CHILD_READ_MAX_CHARS,
  RENDERED_TOOL_RESULT_MAX_CHARS,
} from "../src/builtin-tools/index.js";
import type {
  ChildReader,
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessagePart,
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

function makeCtx(childReader?: ChildReader): ToolContext {
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "orchestrator:u1",
    threadId: "t1",
    credentials: stubCredentials,
    // child_read never touches the sandbox — an empty stub proves it.
    sandbox: {} as Sandbox,
    config: childReader ? { childReader } : {},
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
}

function messageEntry(
  content: string,
  id = "e1",
  extras: {
    parts?: MessagePart[];
    attachments?: Array<{ type: "image"; mimeType: string; name?: string }>;
    role?: "user" | "assistant";
  } = {},
): SessionEntry {
  return {
    id,
    sessionId: "child_abc",
    threadId: "th1",
    parentId: null,
    type: "message",
    role: extras.role ?? "assistant",
    content,
    createdAt: 1_700_000_000_000,
    ...(extras.parts ? { parts: extras.parts } : {}),
    ...(extras.attachments ? { attachments: extras.attachments } : {}),
  };
}

describe("childReadTool", () => {
  it("is registered in builtinTools", () => {
    expect(builtinTools.map((t) => t.name)).toContain("child_read");
  });

  it("says the session cannot read children when no reader is wired", async () => {
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx());
    expect(result.text).toContain("[child_read_unavailable]");
  });

  it("passes the caller's session id and limit to the reader, and renders entries", async () => {
    const seen: Array<{ childSessionId: string; limit?: number; parent: string }> = [];
    const reader: ChildReader = async (req, ctx) => {
      seen.push({ childSessionId: req.childSessionId, limit: req.limit, parent: ctx.parentSessionId });
      return [messageEntry("the tail of the truncated report")];
    };
    const result = await childReadTool.execute(
      { child_session_id: "child_abc", limit: 5 },
      makeCtx(reader),
    );
    expect(seen).toEqual([{ childSessionId: "child_abc", limit: 5, parent: "orchestrator:u1" }]);
    expect(result.text).toContain("the tail of the truncated report");
  });

  it("answers not-found for a null reader result without confirming the id exists", async () => {
    const reader: ChildReader = async () => null;
    const result = await childReadTool.execute({ child_session_id: "child_other" }, makeCtx(reader));
    expect(result.text).toContain("[child_not_found]");
    expect(result.text).toContain("child_other");
  });

  it("reports an empty child instead of rendering nothing", async () => {
    const reader: ChildReader = async () => [];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("no messages");
  });

  it("renders a completed tool call's name, status, and result text", async () => {
    const reader: ChildReader = async () => [
      messageEntry("", "e1", {
        parts: [
          { type: "tool_call", callId: "c1", toolName: "bash", status: "completed", result: { text: "42 passed" } },
        ],
      }),
    ];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("[tool_call bash — completed]");
    expect(result.text).toContain("42 passed");
  });

  it("marks an in-flight tool call instead of rendering a blank turn", async () => {
    const reader: ChildReader = async () => [
      messageEntry("", "e1", {
        parts: [{ type: "tool_call", callId: "c1", toolName: "bash", status: "running" }],
      }),
    ];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("[tool_call bash — running]");
    expect(result.text).toContain("in flight");
  });

  it("renders errored and elided calls distinctly", async () => {
    const reader: ChildReader = async () => [
      messageEntry("", "e1", {
        parts: [
          {
            type: "tool_call",
            callId: "c1",
            toolName: "bash",
            status: "error",
            error: "interrupted — result lost in restart",
          },
          { type: "tool_call", callId: "c2", toolName: "read", status: "completed", elided: true },
        ],
      }),
    ];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("error: interrupted — result lost in restart");
    expect(result.text).toContain("elided");
  });

  it("bounds one tool result and reports the overflow", async () => {
    const big = "y".repeat(RENDERED_TOOL_RESULT_MAX_CHARS + 500);
    const reader: ChildReader = async () => [
      messageEntry("", "e1", {
        parts: [{ type: "tool_call", callId: "c1", toolName: "bash", status: "completed", result: { text: big } }],
      }),
    ];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("[+500 more chars]");
  });

  it("marks user image attachments", async () => {
    const reader: ChildReader = async () => [
      messageEntry("look at this", "e1", {
        role: "user",
        attachments: [{ type: "image", mimeType: "image/png", name: "screenshot.png" }],
      }),
    ];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text).toContain("[image attachment: screenshot.png (image/png)]");
  });

  it("bounds the rendered output and keeps the most recent tail", async () => {
    // One oversized entry — the exact shape the settled-signal ceiling
    // truncates. The store's limit counts entries, so only a byte ceiling
    // here stops the flood from re-entering through the recovery path.
    const big = "x".repeat(CHILD_READ_MAX_CHARS * 2) + "THE-VERY-END";
    const reader: ChildReader = async () => [messageEntry(big)];
    const result = await childReadTool.execute({ child_session_id: "child_abc" }, makeCtx(reader));
    expect(result.text.length).toBeLessThanOrEqual(CHILD_READ_MAX_CHARS + 200);
    expect(result.text).toContain("[Truncated:");
    expect(result.text).toContain("THE-VERY-END");
  });
});
