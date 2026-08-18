import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { toAgentTool } from "../src/tool-bridge.js";
import type { Sandbox, ToolContext, ToolDef } from "../src/types.js";

/**
 * Pins hop 2 of the tool-call persistence round trip for image results
 * (CLAUDE.md): a ToolResult image attachment must reach pi-agent-core as a
 * base64 `{ type: "image", data, mimeType }` content block — that block is
 * what thread.ts persists and what the web openai-media renderer reads back.
 */

function stubSandbox(): Sandbox {
  const fail = async (): Promise<never> => {
    throw new Error("sandbox is not used in this test");
  };
  return {
    id: "sbx-test",
    readFile: fail,
    readBinary: fail,
    writeFile: fail,
    writeBinary: fail,
    readdir: fail,
    stat: fail,
    mkdir: fail,
    rm: fail,
    exec: fail,
  };
}

function stubContext(): ToolContext {
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    credentials: {
      get: async () => null,
      request: async () => {
        throw new Error("not used");
      },
    },
    sandbox: stubSandbox(),
    requestDecision: async () => {
      throw new Error("not used");
    },
    signal: new AbortController().signal,
    threadRead: async () => [],
    listThreads: async () => [],
    setModel: async () => {
      throw new Error("not used");
    },
  };
}

describe("toAgentTool image attachments", () => {
  it("converts an image attachment to a base64 image content block", async () => {
    const bytes = new TextEncoder().encode("hello");
    const def: ToolDef = {
      name: "image_tool",
      description: "returns one image",
      parameters: Type.Object({}),
      execute: async () => ({
        text: '{"path":"/workspace/out.png"}',
        attachments: [{ type: "image", data: bytes, mimeType: "image/png", name: "out.png" }],
      }),
    };
    const agentTool = toAgentTool(def, () => stubContext());
    const result = await agentTool.execute("call-1", {}, new AbortController().signal);
    expect(result.content).toEqual([
      { type: "text", text: '{"path":"/workspace/out.png"}' },
      { type: "image", data: Buffer.from("hello").toString("base64"), mimeType: "image/png" },
    ]);
  });
});
