import { afterEach, describe, expect, it } from "vitest";
import type { MessageEntry, SessionEntry, Thread } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import type { ListMessagesResponse, SendPromptResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

function message(thread: Thread, id: string, parentId: string | null, role: "user" | "assistant", content: string, completed = true): MessageEntry {
  return {
    id, parentId, sessionId: thread.toThreadData().sessionId, threadId: thread.id,
    type: "message", role, content, createdAt: Date.now(),
    ...(role === "user" ? { author: { id: "local-user", name: "Local Dev" } } : { stopReason: completed ? "end_turn" as const : "abort" as const, parts: [{ type: "text" as const, text: content }] }),
  };
}

async function setup(seed = true) {
  api = await bootTestApi();
  const { sessionId } = await ensureDefaultAssistantSession(api.providers, { type: "user", id: "local-user" }, { actorUserId: "local-user", orgId: "local-org" });
  const session = await api.providers.engineHost.sessionFor(sessionId, { userId: "local-user", orgId: "local-org", workspace: "/tmp" });
  const thread = await session.createThread("web:fork-command");
  await thread.pause();
  if (seed) {
    const entries: SessionEntry[] = [
      message(thread, "u1", null, "user", "first"),
      message(thread, "a1", "u1", "assistant", "completed answer"),
      message(thread, "u2", "a1", "user", "unfinished request"),
      message(thread, "a2", "u2", "assistant", "partial answer", false),
    ];
    await api.providers.engineStore.appendEntries(sessionId, thread.id, entries);
  }
  const post = (path: string, body: object) => fetch(`${api!.baseUrl}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const messages = async (id = thread.id) => {
    const response = await fetch(`${api!.baseUrl}/api/threads/${id}/messages`);
    expect(response.status).toBe(200);
    return ((await response.json()) as ListMessagesResponse).messages;
  };
  return { sessionId, thread, session, post, messages };
}

describe("/fork over the send route", () => {
  it("copies through the latest completed reply, returns the isolated destination, and persists its link", async () => {
    const h = await setup();
    const response = await h.post(`/threads/${h.thread.id}/messages`, { text: "/fork" });
    expect(response.status).toBe(202);
    const result = await response.json() as SendPromptResponse;
    expect(result.messageId).toBeNull();
    expect(result.threadId).toBe(h.thread.id);
    expect(result.fork?.sessionId).not.toBe(h.sessionId);
    expect(result.fork).toBeDefined();
    const copied = await h.messages(result.fork!.id);
    expect(copied.slice(0, 2).map((entry) => entry.content)).toEqual(["first", "completed answer"]);
    expect(copied.some((entry) => entry.content === "unfinished request" || entry.content === "/fork")).toBe(false);
    expect((await h.messages()).at(-1)).toMatchObject({ content: expect.stringContaining(`/threads/${result.fork!.id}`), command: { name: "fork", ok: true } });
  });

  it.each([false, true])("keeps return and compaction notes before the next turn (unfinished tail: %s)", async (unfinished) => {
    const h = await setup(false);
    const sideEffect = "Returned to the earlier version. The issue created on the version we left still exists.";
    const entries: SessionEntry[] = [
      message(h.thread, "u1", null, "user", "first"),
      message(h.thread, "a1", "u1", "assistant", "completed answer"),
      {
        id: "return-note", parentId: "a1", sessionId: h.sessionId, threadId: h.thread.id,
        type: "branch_summary", branchRootId: "left-root", branchLeafId: "left-leaf",
        summary: sideEffect, createdAt: Date.now(),
        metadata: { branchNote: { kind: "return", actions: [{ tool: "issues:create", label: "Created issue", count: 1, urls: [] }], moreActions: 0, filesChanged: false, grants: [] } },
      },
      {
        id: "compaction-note", parentId: "return-note", sessionId: h.sessionId, threadId: h.thread.id,
        type: "compaction", summary: "Earlier context", coveredEntryIds: ["u1"],
        tokenCountBefore: 100, tokenCountAfter: 10, createdAt: Date.now(),
      },
    ];
    if (unfinished) {
      const partial = message(h.thread, "partial", "u2", "assistant", "tool still running", false);
      partial.parts = [{ type: "tool_call", callId: "call1", toolName: "shell", args: {}, status: "running" }];
      entries.push(message(h.thread, "u2", "compaction-note", "user", "unfinished request"), partial);
    }
    await api!.providers.engineStore.appendEntries(h.sessionId, h.thread.id, entries);
    const response = await h.post(`/threads/${h.thread.id}/messages`, { text: "/fork" });
    expect(response.status).toBe(202);
    const result = await response.json() as SendPromptResponse;
    expect(result.fork).toBeDefined();
    const copied = await api!.providers.engineStore.getEntries(result.fork!.sessionId, result.fork!.id);
    expect(copied).toContainEqual(expect.objectContaining({ type: "branch_summary", summary: sideEffect }));
    expect(copied).toContainEqual(expect.objectContaining({ type: "compaction", summary: "Earlier context" }));
    expect(copied.filter((entry) => entry.type === "message").map((entry) => entry.content)).toEqual(["first", "completed answer"]);
  });

  it("sends the raw prompt only to the new thread", async () => {
    const h = await setup();
    const text = 'Explain "two words"\nthen continue';
    const response = await h.post(`/sessions/${h.sessionId}/messages`, { threadId: h.thread.id, text: `/fork ${text}` });
    const result = await response.json() as SendPromptResponse;
    expect(result.fork).toBeDefined();
    const deadline = Date.now() + 5000;
    while (!(await h.messages(result.fork!.id)).some((entry) => entry.content === text)) {
      if (Date.now() > deadline) throw new Error("Fork prompt was not persisted in the destination");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await h.messages()).some((entry) => entry.content === text)).toBe(false);
  });

  it("can branch an empty thread without copying the command echo", async () => {
    const h = await setup(false);
    const response = await h.post(`/threads/${h.thread.id}/messages`, { text: "/fork" });
    const result = await response.json() as SendPromptResponse;
    expect(result.fork).toBeDefined();
    expect((await h.messages(result.fork!.id)).every((entry) => entry.role !== "user")).toBe(true);
  });

  it("refuses reply guests on both fork surfaces", async () => {
    const h = await setup();
    const share = await fetch(`${api!.baseUrl}/api/threads/${h.thread.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ share: "reply" }),
    });
    expect(share.status).toBe(200);
    for (const [path, body] of [
      [`/threads/${h.thread.id}/fork`, { entryId: "a1" }],
      [`/threads/${h.thread.id}/messages`, { text: "/fork continue" }],
    ] as const) {
      const response = await fetch(`${api!.baseUrl}/api${path}`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(403);
    }
    expect((await h.messages()).some((entry) => entry.content === "/fork continue")).toBe(false);
  });

  it("rejects attachments before consuming them and rejects edits as commands", async () => {
    const h = await setup();
    const attached = await h.post(`/threads/${h.thread.id}/messages`, { text: "/fork", fileRefs: [{ ref: "not-consumed" }] });
    expect(attached.status).toBe(400);
    expect(await attached.json()).toMatchObject({ error: expect.stringContaining("Attach files in the new thread") });
    const edited = await h.post(`/threads/${h.thread.id}/messages`, { text: "/fork", editEntryId: "u1" });
    expect(edited.status).toBe(400);
    expect(await edited.json()).toMatchObject({ error: expect.stringContaining("cannot run a slash command") });
  });
});
