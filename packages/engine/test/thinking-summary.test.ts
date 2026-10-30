import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxThinking, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from "../src/index.js";
import { MAX_THINKING_SUMMARY_CHARS, ThinkingTiming } from "../src/thinking-timing.js";

describe("reasoning summaries", () => {
  it("are stored for display and never reach the model on a rebuilt transcript", async () => {
    const faux = registerFauxProvider({ provider: "thinking-summary" });
    const store = new InMemorySessionStore();
    const providers = { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
    const options = { userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() };
    const contexts: string[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("SUMMARY OF THE PLAN"), { type: "text", text: "first answer" }]),
      (context) => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage("second answer"); },
    ]);
    const original = await new Engine({ providers }).createSession(options);
    try {
      const thread = await original.ensureDefaultThread();
      const first = await thread.submitPrompt("plan it", {});
      await thread.awaitResult(first.queueItemId);
      const entries = await store.getEntries(original.id, thread.id);
      const thinking = entries.flatMap(e => e.type === "message" ? e.parts ?? [] : []).filter(p => p.type === "thinking");
      expect(thinking).toEqual([expect.objectContaining({ type: "thinking", text: "", summary: "SUMMARY OF THE PLAN" })]);
      original.suspendTimers();

      // A restart rebuilds the transcript from the store; the summary stays out.
      const restored = await new Engine({ providers }).restoreSession({ sessionId: original.id, options });
      const again = restored.threadById(thread.id)!;
      const second = await again.submitPrompt("go on", {});
      await again.awaitResult(second.queueItemId);
      expect(contexts[0]).toContain("first answer");
      expect(contexts[0]).not.toContain("SUMMARY OF THE PLAN");
      restored.suspendTimers();
    } finally {
      faux.unregister();
    }
  });

  it("caps a summary and ignores redacted reasoning", () => {
    const timing = new ThinkingTiming();
    timing.summarize(0, { thinking: "x".repeat(MAX_THINKING_SUMMARY_CHARS + 50) });
    timing.summarize(1, { thinking: "opaque", redacted: true });
    timing.summarize(2, { thinking: "   " });
    expect(timing.part(0).summary).toHaveLength(MAX_THINKING_SUMMARY_CHARS);
    expect(timing.part(1)).toEqual({ type: "thinking", text: "" });
    expect(timing.part(2)).toEqual({ type: "thinking", text: "" });
  });
});
