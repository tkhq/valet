import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import {
  Engine, FRESH_CONTEXT_KEY, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider,
  freshContextOnly, type ToolDef,
} from "../src/index.js";

describe("fresh-context turns", () => {
  it("sends only the turn's own messages, and later turns read the whole transcript", async () => {
    const faux = registerFauxProvider({ provider: "fresh-context" });
    const store = new InMemorySessionStore();
    const providers = { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
    const lookup: ToolDef = {
      name: "lookup", description: "Look something up.", parameters: Type.Object({}),
      execute: async () => ({ text: "lookup result" }),
    };
    const session = await new Engine({ providers }).createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel(), tools: [lookup],
    });
    const contexts: string[] = [];
    const record = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: unknown[] }) => {
      contexts.push(JSON.stringify(context.messages));
      return reply;
    };
    faux.setResponses([
      record(fauxAssistantMessage("noted the blue house")),
      record(fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "tc-1" })])),
      record(fauxAssistantMessage("brief written")),
      record(fauxAssistantMessage("both remembered")),
    ]);
    try {
      const thread = await session.ensureDefaultThread();
      const first = await thread.submitPrompt("remember the blue house", {});
      await thread.awaitResult(first.queueItemId);

      const routine = await thread.submitPrompt("write the brief", { metadata: { [FRESH_CONTEXT_KEY]: true } });
      await thread.awaitResult(routine.queueItemId);
      // Both requests of the routine turn: no earlier history, and the tool
      // result reaches the second request.
      for (const sent of [contexts[1], contexts[2]]) {
        expect(sent).toContain("write the brief");
        expect(sent).not.toContain("blue house");
      }
      expect(contexts[2]).toContain("lookup result");

      const next = await thread.submitPrompt("what do you know?", {});
      await thread.awaitResult(next.queueItemId);
      expect(contexts[3]).toContain("blue house");
      expect(contexts[3]).toContain("brief written");
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("sends the whole context when the turn's prompt is not in it", () => {
    const prompt = { role: "user" as const, content: "now", timestamp: 2 };
    const earlier = { role: "user" as const, content: "before", timestamp: 1 };
    const context = { systemPrompt: "s", messages: [earlier, prompt] };
    expect(freshContextOnly(context, undefined)).toBe(context);
    expect(freshContextOnly(context, { ...prompt })).toBe(context);
    expect(freshContextOnly(context, prompt).messages).toEqual([prompt]);
  });
});
