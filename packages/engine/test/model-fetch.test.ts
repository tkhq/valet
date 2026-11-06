import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  registerApiProvider,
  registerFauxProvider,
  type Api,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from "../src/index.js";

describe("modelFetch session option", () => {
  it("asks the host for each model request's fetch and passes it on", async () => {
    const faux = registerFauxProvider({ provider: "model-fetch" });
    const model = faux.getModel();
    const seen: Array<SimpleStreamOptions["fetch"]> = [];
    const stream = (requestModel: Model<Api>, _context: TranscriptContext, options?: SimpleStreamOptions) => {
      seen.push(options?.fetch);
      const message = { ...fauxAssistantMessage("ok"), api: requestModel.api, provider: requestModel.provider, model: requestModel.id };
      const events = createAssistantMessageEventStream();
      void (async () => {
        events.push({ type: "start", partial: { ...message, content: [] } });
        events.push({ type: "done", reason: "stop", message });
        events.end(message);
      })();
      return events;
    };
    registerApiProvider({ api: faux.api, stream, streamSimple: stream });
    const hostFetch: typeof fetch = async () => new Response("unused");
    const engine = new Engine({
      providers: { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() },
    });
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model, modelFetch: (requestModel) => (requestModel.api === "google-generative-ai" ? undefined : hostFetch) });
    try {
      const thread = session.thread("main");
      const receipt = await thread.submitPrompt("hello", {});
      await thread.awaitResult(receipt.queueItemId, { timeoutMs: 2000 });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((f) => f === hostFetch)).toBe(true);
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });
});
