/**
 * Thread edit, return, and fork over REST
 * (docs/specs/2026-10-22-thread-edit-fork-design.md). The unit project
 * scrubs model keys, so a claimed edit fails at model resolution after its
 * leaf moved: the branch shape is what these tests read.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { MessageEntry, SessionEntry, Thread } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type {
  CreateSessionResponse,
  ForkThreadResponse,
  ListMessagesResponse,
  ReturnToBranchResponse,
  SendPromptResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const ME = { id: "local-user", name: "Local Dev" };

function entry(thread: Thread, id: string, parentId: string | null, role: "user" | "assistant", text: string, author = ME): MessageEntry {
  return {
    id,
    sessionId: thread.toThreadData().sessionId,
    threadId: thread.id,
    parentId,
    type: "message",
    role,
    content: text,
    ...(role === "user" ? { author } : { parts: [{ type: "text", text }], stopReason: "end_turn" }),
    createdAt: Date.now(),
  };
}

async function setup() {
  api = await bootTestApi();
  const response = await fetch(`${api.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(response.status).toBe(201);
  const sessionId = ((await response.json()) as CreateSessionResponse).id;
  const session = await api.providers.engineHost.sessionFor(sessionId, { userId: "local-user", orgId: "local-org", workspace: "/tmp" });
  const thread = await session.ensureDefaultThread();
  await thread.pause();
  const seeded: SessionEntry[] = [
    entry(thread, "u1", null, "user", "first"),
    entry(thread, "a1", "u1", "assistant", "first answer"),
    entry(thread, "u2", "a1", "user", "second"),
    entry(thread, "a2", "u2", "assistant", "second answer"),
  ];
  await api.providers.engineStore.appendEntries(sessionId, thread.id, seeded);
  const base = api.baseUrl;
  const post = (path: string, body: object) => fetch(`${base}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const messages = async (threadId = thread.id) => {
    const res = await fetch(`${base}/api/threads/${threadId}/messages`);
    expect(res.status).toBe(200);
    return ((await res.json()) as ListMessagesResponse).messages;
  };
  const settled = async (itemId: string) => {
    const deadline = Date.now() + 5000;
    while ((await api!.providers.engineStore.getQueueItem(sessionId, itemId))?.status !== "settled") {
      if (Date.now() > deadline) throw new Error("edit did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { sessionId, thread, post, messages, settled };
}

describe("thread edit over the send route", () => {
  it("queues the edit, then serves the new branch and hides the old one", async () => {
    const h = await setup();
    const sent = await h.post(`/threads/${h.thread.id}/messages`, { text: "second, edited", editEntryId: "u2" });
    expect(sent.status).toBe(202);
    const { messageId } = (await sent.json()) as SendPromptResponse;
    const item = await api!.providers.engineStore.getQueueItem(h.sessionId, messageId!);
    expect(item?.metadata?.threadEdit).toEqual({ entryId: "u2" });

    await h.thread.resume();
    await h.settled(messageId!);

    const listed = await h.messages();
    expect(listed.slice(0, 2).map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(listed[2]?.branch).toMatchObject({ kind: "edit", canReturn: true, actions: [], filesChanged: false });
    expect(listed[2]?.role).toBe("system");
    expect(listed[3]).toMatchObject({ role: "user", content: "second, edited", editOf: "u2" });
    expect(listed.some((m) => m.id === "u2" || m.id === "a2")).toBe(false);
  });

  it("refuses someone else's message, a slash command, and an edit mixed with a reply", async () => {
    const h = await setup();
    await api!.providers.engineStore.appendEntries(h.sessionId, h.thread.id, [
      entry(h.thread, "u3", "a2", "user", "from a guest", { id: "guest-user", name: "Guest" }),
    ]);
    const other = await h.post(`/threads/${h.thread.id}/messages`, { text: "x", editEntryId: "u3" });
    expect(other.status).toBe(400);
    expect(((await other.json()) as { error: string }).error).toContain("Only the person who wrote a message can edit it.");

    const mine = await h.post(`/threads/${h.thread.id}/messages`, { text: "x", editEntryId: "u2" });
    expect(((await mine.json()) as { error: string }).error).toContain("Guest wrote after this message");

    const command = await h.post(`/threads/${h.thread.id}/messages`, { text: "/compact", editEntryId: "u1" });
    expect(command.status).toBe(400);
    expect(((await command.json()) as { error: string }).error).toContain("cannot run a slash command");

    const mixed = await h.post(`/threads/${h.thread.id}/messages`, { text: "x", editEntryId: "u1", replyToMessageId: "a1" });
    expect(mixed.status).toBe(400);
  });
});

describe("thread return", () => {
  it("goes back to the version an edit left", async () => {
    const h = await setup();
    const sent = await h.post(`/threads/${h.thread.id}/messages`, { text: "second, edited", editEntryId: "u2" });
    const { messageId } = (await sent.json()) as SendPromptResponse;
    await h.thread.resume();
    await h.settled(messageId!);
    const note = (await h.messages()).find((m) => m.branch?.kind === "edit");

    const back = await h.post(`/threads/${h.thread.id}/branch/return`, { noteEntryId: note!.id });
    expect(back.status).toBe(200);
    const { noteEntryId } = (await back.json()) as ReturnToBranchResponse;

    const listed = await h.messages();
    expect(listed.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2", noteEntryId]);
    expect(listed[4]?.branch?.kind).toBe("return");

    const missing = await h.post(`/threads/${h.thread.id}/branch/return`, { noteEntryId: "not-a-note" });
    expect(missing.status).toBe(400);
  });
});

describe("thread fork", () => {
  it("branches through a reply into a new thread with copied history", async () => {
    const h = await setup();
    const res = await h.post(`/threads/${h.thread.id}/fork`, { entryId: "a1" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ForkThreadResponse;
    expect(body.draft).toBeUndefined();
    expect(body.thread.id).not.toBe(h.thread.id);

    const listed = await h.messages(body.thread.id);
    expect(listed.map((m) => m.content)).toEqual(["first", "first answer", expect.stringContaining("branch of another thread")]);
    expect(listed.some((m) => m.id === "u1")).toBe(false);
    expect(listed[2]?.branch).toMatchObject({ kind: "fork", canReturn: false, source: { threadId: h.thread.id, sameWorkingDirectory: true } });
    // The source thread is unchanged.
    expect((await h.messages()).map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("branches from before a user message and returns its text for the composer", async () => {
    const h = await setup();
    const res = await h.post(`/threads/${h.thread.id}/fork`, { entryId: "u2" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ForkThreadResponse;
    expect(body.draft).toBe("second");
    expect((await h.messages(body.thread.id)).map((m) => m.content)).toEqual([
      "first", "first answer", expect.stringContaining("branch of another thread"),
    ]);
  });

  it("refuses an entry that is not on the active path", async () => {
    const h = await setup();
    const res = await h.post(`/threads/${h.thread.id}/fork`, { entryId: "nope" });
    expect(res.status).toBe(404);
  });
});
