import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type Context } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from "../src/index.js";

describe("preparation failure tool results", () => {
  it.each([
    { cause: { failure: "mount denied", retryable: false, href: "PRIVATE_URL", sshKey: "PRIVATE_KEY" }, detail: '{"failure":"mount denied","retryable":false}' },
    { cause: { message: "clone denied", code: "EACCES" }, detail: "(EACCES) clone denied" },
  ])("delivers $detail to the model and persisted history", async ({ cause, detail }) => {
    const faux = registerFauxProvider({ provider: "preparation-tool-result" });
    let received: Context | undefined;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "/workspace/file" }, { id: "prep-read" })], { stopReason: "toolUse" }),
      async (context: Context) => {
        received = context;
        return fauxAssistantMessage("Preparation failed.");
      },
    ]);
    const engine = new Engine({ providers: {
      store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider(),
    } });
    const session = await engine.createSession({
      userId: "u1", orgId: "o1", workspace: "/workspace", sandbox: {}, model: faux.getModel(),
      specProvider: async () => ({ specHash: "prep", steps: [
        { id: "mount", hash: "mount", critical: true, apply: async () => { throw cause; } },
      ] }),
    });
    try {
      const receipt = await session.prompt("Read the file.");
      await session.thread().awaitResult(receipt.queueItemId, { timeoutMs: 2000 });
      const text = `sandbox preparation failed: ${detail}`;
      const result = received?.messages.find((message) => message.role === "toolResult");
      expect(result).toMatchObject({ isError: true, content: [{ type: "text", text }] });
      const entries = await session.readEntries("web:default");
      const parts = entries.flatMap((entry) => entry.type === "message" ? entry.parts ?? [] : []);
      expect(parts.find((part) => part.type === "tool_call")).toMatchObject({
        status: "error", result: { text },
      });
    } finally {
      await session.destroy();
      faux.unregister();
    }
  });
});
