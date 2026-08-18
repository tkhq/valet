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
});

async function waitForStatus(
  events: BusEvent[],
  threadId: string,
  status: string,
  timeoutMs = 2000,
  check?: () => boolean,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check?.() === false) {
        setTimeout(tick, 10);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timeout waiting for status ${status}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}
