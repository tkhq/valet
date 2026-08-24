/**
 * File attachment handling in engine prompt submission and agent message
 * construction — the write hop of the persistence round trip.
 *
 * Tests that:
 * 1. A file attachment on PromptContent persists on MessageEntry as
 *    `type: "file"` with its sandbox metadata (not coerced to an image).
 * 2. The model sees the system-authored file note on the hot turn.
 * 3. `entriesToAgentMessages` renders the same note on reload (cold path
 *    parity with the hot path).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  entriesToAgentMessages,
  type MessageEntry,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const engine = new Engine({
    providers: { store, stream: bus, sandboxProvider },
  });
  return { engine, store };
}

const FILE_ATTACHMENT = {
  type: "file" as const,
  path: "/workspace/uploads/report.pdf",
  bytes: 843 * 1024,
  sha256: "abc123",
  mimeType: "application/pdf",
  markdownPath: "/workspace/uploads/report.pdf.md",
  name: "report.pdf",
};

describe("File attachments", () => {
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    faux = registerFauxProvider({ provider: "file-test" });
  });

  afterEach(() => {
    faux.unregister();
  });

  it("persists file attachments on the user MessageEntry and shows the note to the model", async () => {
    const received: unknown[] = [];
    faux.setResponses([
      (context) => {
        received.push(structuredClone(context.messages));
        return fauxAssistantMessage("read it");
      },
    ]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = await session.ensureDefaultThread();

    const receipt = await thread.submitPrompt(
      { text: "Summarize the report.", attachments: [FILE_ATTACHMENT] },
      {},
    );
    await thread.awaitResult(receipt.queueItemId);

    // Write hop: the persisted entry keeps type "file" and the sandbox
    // metadata — the historical bug coerced this to a bogus image.
    const entries = await store.getEntries(session.id, thread.id);
    const userEntry = entries.find(
      (e): e is MessageEntry => e.type === "message" && e.role === "user",
    );
    expect(userEntry).toBeDefined();
    expect(userEntry?.content).toBe("Summarize the report.");
    expect(userEntry?.attachments).toEqual([FILE_ATTACHMENT]);

    // Hot path: the model's turn-1 call carries the note with the path.
    const flat = JSON.stringify(received[0]);
    expect(flat).toContain("[User attached files to the sandbox:");
    expect(flat).toContain("/workspace/uploads/report.pdf");
    expect(flat).toContain("Summarize the report.");
  });

  it("renders the same note on reload via entriesToAgentMessages", () => {
    const userEntry: MessageEntry = {
      id: "e-file-1",
      sessionId: "s1",
      threadId: "t1",
      parentId: null,
      type: "message",
      role: "user",
      content: "Summarize the report.",
      attachments: [FILE_ATTACHMENT],
      createdAt: Date.now(),
    };

    const agentMessages = entriesToAgentMessages([userEntry], {
      api: "anthropic",
      provider: "anthropic",
      id: "claude-opus-4",
    });

    expect(agentMessages).toHaveLength(1);
    const [msg] = agentMessages;
    expect(msg.content).toHaveLength(1);
    const block = msg.content[0];
    if (typeof block === "string" || block.type !== "text") throw new Error("expected text block");
    expect(block.text).toContain("[User attached files to the sandbox:");
    expect(block.text).toContain(
      "/workspace/uploads/report.pdf (843 KB, PDF, markdown at /workspace/uploads/report.pdf.md)",
    );
    expect(block.text.endsWith("Summarize the report.")).toBe(true);
  });
});
