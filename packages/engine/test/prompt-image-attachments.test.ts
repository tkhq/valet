/**
 * Image attachment handling in engine prompt submission and agent message construction.
 *
 * Tests that:
 * 1. Image attachments in PromptContent are persisted on MessageEntry
 * 2. Attachments are converted to image content blocks in agent messages
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  entriesToAgentMessages,
  type BusEvent,
  type MessageEntry,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({
    providers: { store, stream: bus, sandboxProvider },
  });
  return { engine, store, bus, events };
}

describe("Image attachments", () => {
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    faux = registerFauxProvider({ provider: "image-test" });
    // Image test: model just echoes back the text
    faux.setResponses([fauxAssistantMessage("got your message")]);
  });

  afterEach(() => {
    faux.unregister();
  });

  it("persists image attachments on user MessageEntry", async () => {
    // Directly test persistence without running the agent.
    // This verifies that image attachments are correctly captured during
    // submission and persisted in the MessageEntry.
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = await session.ensureDefaultThread();

    // Seed entries directly to test persistence path without agent execution
    const imageData = Buffer.from("fake png data");
    const userEntry: MessageEntry = {
      id: "e-img-persist",
      sessionId: session.id,
      threadId: thread.id,
      parentId: null,
      type: "message",
      role: "user",
      content: "Analyze this image",
      attachments: [
        {
          type: "image",
          data: imageData,
          mimeType: "image/png",
          name: "screenshot.png",
        },
      ],
      createdAt: Date.now(),
    };

    // Append the entry
    await store.appendEntries(session.id, thread.id, [userEntry]);

    // Fetch the entries and verify the attachment persisted
    const entries = await store.getEntries(session.id, thread.id);
    const persistedEntry = entries.find((e) => e.id === "e-img-persist") as MessageEntry | undefined;

    expect(persistedEntry).toBeDefined();
    expect(persistedEntry?.content).toBe("Analyze this image");
    expect(persistedEntry?.attachments).toBeDefined();
    expect(persistedEntry?.attachments).toHaveLength(1);
    expect(persistedEntry?.attachments?.[0]).toEqual({
      type: "image",
      data: imageData,
      mimeType: "image/png",
      name: "screenshot.png",
      url: undefined,
    });
  });

  it("converts image attachments to agent message content blocks", () => {
    // Create a mock user message entry with an image attachment
    const userEntry: MessageEntry = {
      id: "e-img-1",
      sessionId: "s1",
      threadId: "t1",
      parentId: null,
      type: "message",
      role: "user",
      content: "What's in this image?",
      attachments: [
        {
          type: "image",
          data: Buffer.from("fake image bytes"),
          mimeType: "image/jpeg",
          name: "photo.jpg",
        },
      ],
      createdAt: Date.now(),
    };

    const agentMessages = entriesToAgentMessages([userEntry], {
      api: "anthropic",
      provider: "anthropic",
      id: "claude-opus-4",
    });

    expect(agentMessages).toHaveLength(1);
    const msg = agentMessages[0];
    expect(msg.role).toBe("user");
    expect(msg.content).toHaveLength(2);

    // Text block first
    expect(msg.content[0]).toEqual({
      type: "text",
      text: "What's in this image?",
    });

    // Image block second (base64 encoded)
    expect(msg.content[1]).toEqual({
      type: "image",
      data: Buffer.from("fake image bytes").toString("base64"),
      mimeType: "image/jpeg",
    });
  });

  it("handles data: URLs in image attachments", () => {
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const dataUrl = `data:image/png;base64,${pngBase64}`;

    const userEntry: MessageEntry = {
      id: "e-img-2",
      sessionId: "s1",
      threadId: "t1",
      parentId: null,
      type: "message",
      role: "user",
      content: "Check this out",
      attachments: [
        {
          type: "image",
          url: dataUrl,
          mimeType: "image/png",
          name: "icon.png",
        },
      ],
      createdAt: Date.now(),
    };

    const agentMessages = entriesToAgentMessages([userEntry], {
      api: "anthropic",
      provider: "anthropic",
      id: "claude-opus-4",
    });

    expect(agentMessages).toHaveLength(1);
    const msg = agentMessages[0];
    expect(msg.content).toHaveLength(2);
    expect(msg.content[1]).toEqual({
      type: "image",
      data: pngBase64,
      mimeType: "image/png",
    });
  });

  it("keeps a turn-1 image in LLM context on later turns of a hot session", async () => {
    // Regression: runAgent used to push a text-only user message into
    // agent.state.messages even when the prompt carried attachments. On a
    // session that stays hot (no rehydrate between turns), the model never
    // saw the image — on the upload turn or any later one.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const dataUrl = `data:image/png;base64,${pngBase64}`;

    // Capture what the provider actually receives per turn.
    const received: unknown[] = [];
    faux.setResponses([
      (context) => {
        received.push(structuredClone(context.messages));
        return fauxAssistantMessage("I see the image");
      },
      (context) => {
        received.push(structuredClone(context.messages));
        return fauxAssistantMessage("still remembering");
      },
    ]);

    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = await session.ensureDefaultThread();

    // Turn 1: text + image attachment.
    const r1 = await thread.submitPrompt(
      {
        text: "What's in this screenshot?",
        attachments: [{ type: "image", url: dataUrl, mimeType: "image/png", name: "shot.png" }],
      },
      {},
    );
    await thread.awaitResult(r1.queueItemId);

    // Turn 2: text only, same hot session (no rehydrate in between).
    const r2 = await thread.submitPrompt("What did the screenshot show?", {});
    await thread.awaitResult(r2.queueItemId);

    expect(received).toHaveLength(2);

    const imageBlocksIn = (messages: unknown): number => {
      let count = 0;
      const visit = (v: unknown): void => {
        if (Array.isArray(v)) {
          for (const el of v) visit(el);
          return;
        }
        if (v && typeof v === "object") {
          const rec = v as Record<string, unknown>;
          if (rec.type === "image" && rec.data === pngBase64) count++;
          for (const val of Object.values(rec)) visit(val);
        }
      };
      visit(messages);
      return count;
    };

    // Turn 1's own call must include the image...
    expect(imageBlocksIn(received[0])).toBeGreaterThanOrEqual(1);
    // ...and turn 2's call must STILL include the turn-1 image in history.
    expect(imageBlocksIn(received[1])).toBeGreaterThanOrEqual(1);
  });
});


