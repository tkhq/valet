import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider,
  entriesToAgentMessages, type BusEvent, type MessageEntry, type ToolDef,
} from "../src/index.js";

const image = { type: "image", data: "c2NyZWVuc2hvdA==", mimeType: "image/png" };
const model = { api: "anthropic", provider: "anthropic", id: "claude-opus-4" };

function entry(elided = false): MessageEntry {
  return {
    id: "e", parentId: null, sessionId: "s", threadId: "t", type: "message",
    role: "assistant", content: "", createdAt: 1,
    parts: [{ type: "tool_call", callId: "call-1", toolName: "browser__execute",
      args: {}, status: "completed", elided,
      result: { text: "Saved screenshot", content: [{ type: "text", text: "Saved screenshot" }, image] } }],
  };
}

describe("browser tool evidence", () => {
  it("rehydrates retained image evidence with its text", () => {
    const result = entriesToAgentMessages([entry()], model).find((message) => message.role === "toolResult");
    expect(result?.content).toEqual([{ type: "text", text: "Saved screenshot" }, image]);
  });

  it("does not restore images from elided results", () => {
    const result = entriesToAgentMessages([entry(true)], model).find((message) => message.role === "toolResult");
    expect(result?.content).toEqual([{ type: "text", text: "[output elided to save context]" }]);
  });

  it("keeps images and a stable invocation identity through execution and persistence", async () => {
    const faux = registerFauxProvider({ provider: "browser-media-test" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("browser_image", {}, { id: "browser-call-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("The page is visible."),
    ]);
    const events: BusEvent[] = [];
    const stream = new InMemoryEventStream();
    stream.subscribe({}, (event) => events.push(event));
    let invocation: string | undefined;
    const tool: ToolDef = {
      name: "browser_image", description: "Capture evidence", parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        invocation = ctx.invocationId;
        return { text: "Saved screenshot", attachments: [{ type: "image", mimeType: "image/png", data: new TextEncoder().encode("screenshot") }] };
      },
    };
    const engine = new Engine({ providers: { store: new InMemorySessionStore(), stream, sandboxProvider: new VirtualSandboxProvider() } });
    try {
      const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(), tools: [tool] });
      const receipt = await session.prompt("Inspect the browser");
      await expect.poll(() => events.some((event) => event.event.type === "status" && event.event.threadId === receipt.threadId && event.event.status === "idle")).toBe(true);
      expect(invocation).toBe("browser-call-1");
      const completed = events.map((event) => event.event).find((event) => event.type === "tool_end");
      expect(completed?.type === "tool_end" ? completed.resultData : undefined).toMatchObject({ content: [{ type: "text", text: "Saved screenshot" }, image] });
      const history = entriesToAgentMessages(await session.readEntries("web:default"), model);
      const toolResult = history.find((message) => message.role === "toolResult");
      expect(toolResult?.content).toContainEqual(image);
    } finally {
      faux.unregister();
    }
  });
});
