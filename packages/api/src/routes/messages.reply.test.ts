import { afterEach, describe, expect, it } from "vitest";
import type { MessageEntry } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { getAttachmentRefStore } from "../services/attachment-refs.js";
import type {
  CreateSessionResponse,
  ListMessagesResponse,
  SendPromptResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function createSession(): Promise<string> {
  if (!api) throw new Error("test API is not running");
  const response = await fetch(`${api.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as CreateSessionResponse).id;
}

function assistantEntry(sessionId: string, threadId: string, id: string): MessageEntry {
  return {
    id,
    sessionId,
    threadId,
    parentId: null,
    type: "message",
    role: "assistant",
    content: "",
    parts: [{ type: "text", text: "Use the blue deployment for the API." }],
    stopReason: "end_turn",
    createdAt: Date.now(),
  };
}

async function postReply(sessionId: string, threadId: string, messageId: string) {
  if (!api) throw new Error("test API is not running");
  return fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "What about staging?", threadId, replyToMessageId: messageId }),
  });
}

describe("message replies", () => {
  it("admits a same-thread assistant reference with a server-created snapshot", async () => {
    api = await bootTestApi();
    const sessionId = await createSession();
    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await session.ensureDefaultThread();
    await thread.pause();
    await api.providers.engineStore.appendEntries(sessionId, thread.id, [
      assistantEntry(sessionId, thread.id, "assistant-1"),
    ]);

    const response = await postReply(sessionId, thread.id, "assistant-1");
    expect(response.status).toBe(202);
    const body = (await response.json()) as SendPromptResponse;
    const item = await api.providers.engineStore.getQueueItem(sessionId, body.messageId!);
    expect(item?.metadata?.replyTo).toEqual({
      messageId: "assistant-1",
      excerpt: "Use the blue deployment for the API.",
    });

    const messages = await fetch(
      `${api.baseUrl}/api/sessions/${sessionId}/messages?threadId=${thread.id}`,
    );
    const listed = (await messages.json()) as ListMessagesResponse;
    expect(listed.messages.find((message) => message.id === "assistant-1")?.completed).toBe(true);
  });

  it("rejects non-assistant, partial, and tool-only targets", async () => {
    api = await bootTestApi();
    const sessionId = await createSession();
    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await session.ensureDefaultThread();
    const partial = assistantEntry(sessionId, thread.id, "assistant-partial");
    delete partial.stopReason;
    const toolOnly = assistantEntry(sessionId, thread.id, "assistant-tool-only");
    toolOnly.content = "";
    toolOnly.parts = [
      { type: "tool_call", callId: "call-1", toolName: "read", status: "completed" },
    ];
    const user: MessageEntry = {
      ...assistantEntry(sessionId, thread.id, "user-1"),
      role: "user",
      content: "user text",
      parts: undefined,
    };
    await api.providers.engineStore.appendEntries(sessionId, thread.id, [partial, toolOnly, user]);

    expect((await postReply(sessionId, thread.id, partial.id)).status).toBe(400);
    expect((await postReply(sessionId, thread.id, toolOnly.id)).status).toBe(400);
    expect((await postReply(sessionId, thread.id, user.id)).status).toBe(400);
  });

  it("rejects cross-thread and cross-session target ids", async () => {
    api = await bootTestApi();
    const sessionId = await createSession();
    const otherSessionId = await createSession();
    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const otherSession = await api.providers.engineHost.sessionFor(otherSessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await session.ensureDefaultThread();
    const sibling = await session.createThread("web:sibling");
    const foreign = await otherSession.ensureDefaultThread();
    await api.providers.engineStore.appendEntries(sessionId, sibling.id, [
      assistantEntry(sessionId, sibling.id, "assistant-sibling"),
    ]);
    await api.providers.engineStore.appendEntries(otherSessionId, foreign.id, [
      assistantEntry(otherSessionId, foreign.id, "assistant-foreign"),
    ]);

    expect((await postReply(sessionId, thread.id, "assistant-sibling")).status).toBe(400);
    expect((await postReply(sessionId, thread.id, "assistant-foreign")).status).toBe(400);
  });

  it("truncates canonical excerpts without splitting a Unicode codepoint", async () => {
    api = await bootTestApi();
    const sessionId = await createSession();
    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await session.ensureDefaultThread();
    await thread.pause();
    const target = assistantEntry(sessionId, thread.id, "assistant-unicode");
    target.parts = [{ type: "text", text: "a".repeat(278) + "😀zz" }];
    await api.providers.engineStore.appendEntries(sessionId, thread.id, [target]);

    const response = await postReply(sessionId, thread.id, target.id);
    expect(response.status).toBe(202);
    const body = (await response.json()) as SendPromptResponse;
    const item = await api.providers.engineStore.getQueueItem(sessionId, body.messageId!);
    expect(item?.metadata?.replyTo).toEqual({
      messageId: target.id,
      excerpt: "a".repeat(278) + "😀…",
    });
  });

  it("rejects reply commands before consuming attachment refs", async () => {
    api = await bootTestApi();
    const sessionId = await createSession();
    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await session.ensureDefaultThread();
    const target = assistantEntry(sessionId, thread.id, "assistant-command");
    await api.providers.engineStore.appendEntries(sessionId, thread.id, [target]);
    const store = getAttachmentRefStore();
    const ref = store.mint(sessionId, {
      path: "/tmp/keep.txt",
      bytes: 4,
      sha256: "deadbeef",
      mimeType: "text/plain",
      name: "keep.txt",
    });

    const response = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "/compact",
        threadId: thread.id,
        replyToMessageId: target.id,
        fileRefs: [{ ref }],
      }),
    });

    expect(response.status).toBe(400);
    expect(store.peek(sessionId, ref)).not.toBeNull();
  });

  it("returns a persisted reply snapshot after REST reload", async () => {
    api = await bootTestApi();
    const sessionId = await createSession();
    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp",
    });
    const thread = await session.ensureDefaultThread();
    const userEntry: MessageEntry = {
      id: "user-reply-1",
      sessionId,
      threadId: thread.id,
      parentId: null,
      type: "message",
      role: "user",
      content: "What about staging?",
      metadata: {
        replyTo: { messageId: "assistant-1", excerpt: "Use the blue deployment for the API." },
      },
      createdAt: Date.now(),
    };
    await api.providers.engineStore.appendEntries(sessionId, thread.id, [userEntry]);

    const response = await fetch(
      `${api.baseUrl}/api/sessions/${sessionId}/messages?threadId=${thread.id}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListMessagesResponse;
    expect(body.messages[0]?.replyTo).toEqual({
      messageId: "assistant-1",
      excerpt: "Use the blue deployment for the API.",
    });
  });
});
