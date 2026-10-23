/**
 * Thread edit, return, and fork over REST
 * (docs/specs/2026-10-22-thread-edit-fork-design.md). The unit project
 * scrubs model keys, so a claimed edit fails at model resolution after its
 * leaf moved: the branch shape is what these tests read.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as engine from "@valet/engine";
import type { MessageEntry, SessionEntry, Thread } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureAssistantExecution, ensureDefaultAssistantSession } from "../assistants/service.js";
import { assistantExecutions, slackChannelPrivacy, teamMembers, teams } from "../schema/index.js";
import { resetThreadAccessCache, SLACK_CHANNELS_METADATA_KEY } from "../services/thread-access.js";
import type {
  CreateSessionResponse,
  EditPreviewResponse,
  ForkThreadResponse,
  ListMessagesResponse,
  ReturnToBranchResponse,
  SendPromptResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
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

async function setup(assistant = false) {
  api = await bootTestApi();
  const response = assistant ? undefined : await fetch(`${api.baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  if (response) expect(response.status).toBe(201);
  const sessionId = response ? ((await response.json()) as CreateSessionResponse).id
    : (await ensureDefaultAssistantSession(api.providers, { type: "user", id: "local-user" }, { actorUserId: "local-user", orgId: "local-org" })).sessionId;
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

describe("edit preview", () => {
  it("says what an edit replaces, and why one is refused", async () => {
    const h = await setup();
    await api!.providers.engineStore.appendEntries(h.sessionId, h.thread.id, [
      entry(h.thread, "u3", "a2", "user", "from a guest", { id: "guest-user", name: "Guest" }),
    ]);
    const preview = async (entryId: string) => {
      const res = await fetch(`${api!.baseUrl}/api/threads/${h.thread.id}/edit-preview?entryId=${entryId}`);
      expect(res.status).toBe(200);
      return (await res.json()) as EditPreviewResponse;
    };
    expect(await preview("u3")).toMatchObject({ refusal: expect.stringContaining("Only the person who wrote") });
    expect(await preview("u1")).toMatchObject({ refusal: expect.stringContaining("Guest wrote after this message") });

    const fresh = await setup();
    expect(await (await fetch(`${api!.baseUrl}/api/threads/${fresh.thread.id}/edit-preview?entryId=u1`)).json())
      .toEqual({ turns: 2, actions: [], moreActions: 0, grants: [], files: [], pushed: false });
  });

  it("refuses undoFiles without an edit, and a non-boolean restoreFiles", async () => {
    const h = await setup();
    expect((await h.post(`/threads/${h.thread.id}/messages`, { text: "x", undoFiles: true })).status).toBe(400);
    expect((await h.post(`/threads/${h.thread.id}/branch/return`, { noteEntryId: "n", restoreFiles: "yes" })).status).toBe(400);
  });
});

describe("thread return", () => {
  it("previews a saved version without changing the conversation, with bounded pages", async () => {
    const h = await setup();
    const sent = await h.post(`/threads/${h.thread.id}/messages`, { text: "second, edited", editEntryId: "u2" });
    const { messageId } = (await sent.json()) as SendPromptResponse;
    await h.thread.resume();
    await h.settled(messageId!);
    const current = await h.messages();
    const note = current.find((message) => message.branch?.kind === "edit")!;
    expect(note.branch?.version).toMatchObject({ excerpt: "second", createdAt: expect.any(Number) });
    const preview = async (query: string) => fetch(`${api!.baseUrl}/api/threads/${h.thread.id}/branch-preview?${query}`);
    const response = await preview(`noteEntryId=${note.id}&limit=2`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as ListMessagesResponse;
    expect(page.messages.map((message) => message.id)).toEqual(["u2", "a2"]);
    expect(page.hasMore).toBe(true);
    const older = await preview(`noteEntryId=${note.id}&limit=2&cursor=${page.nextCursor}`);
    expect(((await older.json()) as ListMessagesResponse).messages.map((message) => message.id)).toEqual(["u1", "a1"]);
    expect((await h.messages()).map((message) => message.id)).toEqual(current.map((message) => message.id));
    expect((await preview("noteEntryId=a1")).status).toBe(404);
    expect((await preview(`noteEntryId=${note.id}&cursor=not-on-path`)).status).toBe(400);
    expect((await preview("")).status).toBe(400);
    const otherViewer = await fetch(`${api!.baseUrl}/api/threads/${h.thread.id}/branch-preview?noteEntryId=${note.id}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(otherViewer.status).toBe(404);
  });

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
    const h = await setup(true);
    const res = await h.post(`/threads/${h.thread.id}/fork`, { entryId: "a1" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ForkThreadResponse;
    expect(body.draft).toBeUndefined();
    expect(body.thread.id).not.toBe(h.thread.id);

    const listed = await h.messages(body.thread.id);
    expect(listed.map((m) => m.content)).toEqual(["first", "first answer", expect.stringContaining("branch of another thread")]);
    expect(listed.some((m) => m.id === "u1")).toBe(false);
    expect(body.thread.sessionId).not.toBe(h.sessionId);
    expect(listed[2]?.branch).toMatchObject({ kind: "fork", canReturn: false, source: { threadId: h.thread.id, sameWorkingDirectory: false } });
    // The source thread is unchanged.
    expect((await h.messages()).map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("branches from before a user message and returns its text for the composer", async () => {
    const h = await setup(true);
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

describe("team fork audience", () => {
  async function teamThread(key: string) {
    api = await bootTestApi();
    await api.providers.db.insert(teams).values({ id: "fork-team", orgId: "local-org", name: "Fork", createdAt: 1 });
    await api.providers.db.insert(teamMembers).values([
      { teamId: "fork-team", userId: "local-user", role: "admin" },
      { teamId: "fork-team", userId: "test-member", role: "member" },
    ]);
    const owner = { type: "team" as const, id: "fork-team" };
    const meta = { orgId: "local-org", actorUserId: "local-user" };
    await ensureDefaultAssistantSession(api.providers, owner, meta);
    const execution = await ensureAssistantExecution(api.providers, owner, meta, key);
    const thread = await execution.session.createThread(key);
    await api.providers.engineStore.appendEntries(execution.sessionId, thread.id, [
      entry(thread, "u1", null, "user", "first"),
      entry(thread, "a1", "u1", "assistant", "first answer"),
    ]);
    const fork = () => fetch(`${api!.baseUrl}/api/threads/${thread.id}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId: "a1" }),
    });
    return { thread, fork, sessionId: execution.sessionId };
  }

  it("refuses to branch a thread private to one person", async () => {
    const { fork, sessionId } = await teamThread("app-assistant:local-user");
    const credential = (userId: string) => fetch(`${api!.baseUrl}/api/sessions/${sessionId}/sandbox-jwt`, {
      method: "POST", headers: { "x-valet-test-user-id": userId },
    });
    expect((await credential("local-user")).status).toBe(200);
    expect((await credential("test-member")).status).toBe(404);
    const res = await fork();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("private to you");
  });

  it("keeps the Slack channels that gate the source thread", async () => {
    const { thread, fork } = await teamThread("web:gated");
    // Public today, so this viewer sees the source. The fork records the
    // channel too, so it stays gated like the source if the channel changes.
    await api!.providers.db.insert(slackChannelPrivacy).values({ orgId: "local-org", channelId: "C-team", isPrivate: false, checkedAt: Date.now() });
    await thread.addToMetadataList(SLACK_CHANNELS_METADATA_KEY, "C-team");
    const res = await fork();
    expect(res.status).toBe(201);
    const { thread: summary } = (await res.json()) as ForkThreadResponse;
    const stored = await api!.providers.engineStore.getThread(summary.sessionId, summary.id);
    expect(stored?.metadata?.[SLACK_CHANNELS_METADATA_KEY]).toEqual(["C-team"]);
    const [execution] = await api!.providers.db.select().from(assistantExecutions)
      .where(eq(assistantExecutions.sessionId, summary.sessionId));
    const destination = await api!.providers.engineStore.getSession(summary.sessionId);
    expect(destination?.parentThreadId).toBe(execution.governingThreadId);
    const governing = await api!.providers.engineStore.getThread(destination!.parentSessionId!, execution.governingThreadId);
    expect(governing?.metadata?.[SLACK_CHANNELS_METADATA_KEY]).toEqual(["C-team"]);


    const credential = (userId: string) => fetch(`${api!.baseUrl}/api/sessions/${summary.sessionId}/sandbox-jwt`, {
      method: "POST", headers: { "x-valet-test-user-id": userId },
    });
    expect((await credential("local-user")).status).toBe(200);
    expect((await credential("test-member")).status).toBe(200);

    // Retaining an execution URL must not bypass a channel's new privacy gate.
    await api!.providers.db.update(slackChannelPrivacy).set({ isPrivate: true })
      .where(eq(slackChannelPrivacy.channelId, "C-team"));
    resetThreadAccessCache();
    const hidden = await fetch(`${api!.baseUrl}/api/threads/${summary.id}/messages`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(hidden.status).toBe(404);
    expect((await credential("test-member")).status).toBe(404);
    expect((await credential("local-user")).status).toBe(404);
  });
});

it.each(["active", "fenced"] as const)("reserves fork file export and skips doomed compute when the source is %s", async mode => {
  const h = await setup(true);
  const source = api!.providers.engineHost.liveSession(h.sessionId)!;
  vi.spyOn(engine, "planForkSeed").mockReturnValue([{ repo: ".", snapshot: "a".repeat(40) }]);
  const exported = vi.spyOn(engine, "exportSeedBundle").mockImplementation(async () => {
    expect(source.hasActiveExecution).toBe(true);
    expect(await source.beginReclaim()).toBe(false);
    return new Uint8Array([1, 2, 3]);
  });
  if (mode === "fenced") source.retireExecution(async () => {});
  const response = await h.post(`/threads/${h.thread.id}/fork`, { entryId: "a2" });
  expect(response.status).toBe(201);
  const fork = await response.json() as ForkThreadResponse;
  const entries = await api!.providers.engineStore.getEntries(fork.thread.sessionId, fork.thread.id);
  const note = entries.find(entry => entry.type === "branch_summary");
  if (mode === "active") {
    expect(exported).toHaveBeenCalledOnce();
    expect(engine.readBranchNote(note?.metadata)?.seed).toHaveLength(1);
  } else {
    expect(exported).not.toHaveBeenCalled();
    expect(engine.readBranchNote(note?.metadata)?.seedSkipped).toContain("changing");
  }
});
