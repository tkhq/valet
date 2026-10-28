/**
 * Private branches, moves between workspaces, and messages between linked
 * threads (docs/specs/2026-10-22-thread-edit-fork-design.md).
 */
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageEntry, Thread, ToolContext } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { ensureAssistantExecution, ensureDefaultAssistantSession } from "../assistants/service.js";
import { buildThreadLinkTools } from "../home/thread-link-tools.js";
import { sessionThreads, teamMembers, teams } from "../schema/index.js";
import { FORK_OF_METADATA_KEY, MOVED_TO_METADATA_KEY } from "../services/thread-links.js";
import type { ForkThreadResponse, ListMessagesResponse, ThreadAddress } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const ME = { id: "local-user", name: "Local Dev" };
const MEMBER = "test-member";

function entry(thread: Thread, id: string, parentId: string | null, role: "user" | "assistant", text: string, author = ME): MessageEntry {
  return {
    id, sessionId: thread.toThreadData().sessionId, threadId: thread.id, parentId, type: "message", role, content: text, createdAt: Date.now(),
    ...(role === "user" ? { author } : { stopReason: "end_turn" as const, parts: [{ type: "text" as const, text }] }),
  };
}

async function boot() {
  api = await bootTestApi();
  await api.providers.db.insert(teams).values({ id: "fork-team", orgId: "local-org", name: "Fork", createdAt: 1 });
  await api.providers.db.insert(teamMembers).values([
    { teamId: "fork-team", userId: "local-user", role: "member" },
    { teamId: "fork-team", userId: MEMBER, role: "member" },
  ]);
  return api;
}

async function teamThread(key = "web:shared", author = ME) {
  const owner = { type: "team" as const, id: "fork-team" };
  const meta = { orgId: "local-org", actorUserId: "local-user" };
  await ensureDefaultAssistantSession(api!.providers, owner, meta);
  const execution = await ensureAssistantExecution(api!.providers, owner, meta, key);
  const thread = await execution.session.createThread(key);
  await thread.pause();
  await api!.providers.engineStore.appendEntries(execution.sessionId, thread.id, [
    entry(thread, "u1", null, "user", "first", author),
    entry(thread, "a1", "u1", "assistant", "first answer"),
  ]);
  return { thread, sessionId: execution.sessionId };
}

async function personalThread(key = "web:mine") {
  const { sessionId } = await ensureDefaultAssistantSession(api!.providers, { type: "user", id: "local-user" }, { actorUserId: "local-user", orgId: "local-org" });
  const session = await api!.providers.engineHost.sessionFor(sessionId, { userId: "local-user", orgId: "local-org", workspace: "/tmp" });
  const thread = await session.createThread(key);
  await thread.pause();
  await api!.providers.engineStore.appendEntries(sessionId, thread.id, [
    entry(thread, "pu1", null, "user", "my idea"),
    entry(thread, "pa1", "pu1", "assistant", "my answer"),
  ]);
  return { thread, sessionId };
}

const post = (path: string, body: object, userId = "local-user") => fetch(`${api!.baseUrl}/api${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", "x-valet-test-user-id": userId }, body: JSON.stringify(body),
});
const read = (threadId: string, userId = "local-user") => fetch(`${api!.baseUrl}/api/threads/${threadId}/messages`, { headers: { "x-valet-test-user-id": userId } });

describe("private branch", () => {
  it("copies a team thread into the person's private threads, linked to its source", async () => {
    await boot();
    const { thread, sessionId } = await teamThread();
    const res = await post(`/threads/${thread.id}/fork`, { entryId: "a1", destination: "private" }, MEMBER);
    expect(res.status).toBe(201);
    const fork = (await res.json()) as ForkThreadResponse;
    expect(fork.workspace).toBe("user");
    const stored = await api!.providers.engineStore.getThread(fork.thread.sessionId, fork.thread.id);
    expect(stored?.metadata?.[FORK_OF_METADATA_KEY]).toEqual({ sessionId, threadId: thread.id });
    const mine = await read(fork.thread.id, MEMBER);
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as ListMessagesResponse).messages.map((m) => m.content).slice(0, 2)).toEqual(["first", "first answer"]);
    // Nobody else reads a private branch, the source's author included.
    expect((await read(fork.thread.id, "local-user")).status).toBe(404);
    const address = await fetch(`${api!.baseUrl}/api/threads/${fork.thread.id}`, { headers: { "x-valet-test-user-id": MEMBER } });
    expect(((await address.json()) as ThreadAddress).workspace).toBe("user");
  });

  it("keeps one branch suffix on a branch of a branch", async () => {
    await boot();
    const { thread, sessionId } = await teamThread();
    await api!.providers.db.insert(sessionThreads).values({ id: thread.id, sessionId, createdAt: 1, title: "Plan (branch)" });
    const res = await post(`/threads/${thread.id}/fork`, { entryId: "a1", destination: "private" });
    expect(((await res.json()) as ForkThreadResponse).thread.title).toBe("Plan (private branch)");
  });

  it("refuses a private branch of a thread that is already private", async () => {
    await boot();
    const { thread } = await personalThread();
    const res = await post(`/threads/${thread.id}/fork`, { entryId: "pa1", destination: "private" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("already private");
  });
});

describe("move", () => {
  it("moves a team thread to its author's private threads and archives the source", async () => {
    await boot();
    const { thread, sessionId } = await teamThread();
    // A teammate who wrote nothing there cannot take it from its author.
    const refused = await post(`/threads/${thread.id}/move`, { to: "private" }, MEMBER);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain("Teammates wrote in this thread");

    const res = await post(`/threads/${thread.id}/move`, { to: "private" });
    expect(res.status).toBe(201);
    const moved = (await res.json()) as ForkThreadResponse;
    expect(moved.workspace).toBe("user");
    expect((await read(moved.thread.id)).status).toBe(200);
    expect((await read(moved.thread.id, MEMBER)).status).toBe(404);

    const [row] = await api!.providers.db.select().from(sessionThreads).where(and(eq(sessionThreads.sessionId, sessionId), eq(sessionThreads.id, thread.id)));
    expect(row?.archivedAt).toBeTypeOf("number");
    const source = await api!.providers.engineStore.getThread(sessionId, thread.id);
    expect(source?.metadata?.[MOVED_TO_METADATA_KEY]).toEqual({ sessionId: moved.thread.sessionId, threadId: moved.thread.id });
    // Teammates are told where it went, without a link they cannot open.
    const note = ((await (await read(thread.id, MEMBER)).json()) as ListMessagesResponse).messages.at(-1);
    expect(note?.content).toContain("moved this thread to their private threads");
    expect(note?.content).not.toContain("/chat?");
  });

  it("moves a private thread into a team only when the request confirms", async () => {
    await boot();
    const { thread } = await personalThread();
    const unconfirmed = await post(`/threads/${thread.id}/move`, { to: { teamId: "fork-team" } });
    expect(unconfirmed.status).toBe(409);
    expect(((await unconfirmed.json()) as { code: string }).code).toBe("confirm_required");

    const res = await post(`/threads/${thread.id}/move`, { to: { teamId: "fork-team" }, confirm: true });
    expect(res.status).toBe(201);
    const moved = (await res.json()) as ForkThreadResponse;
    expect(moved.workspace).toBe("fork-team");
    expect((await read(moved.thread.id, MEMBER)).status).toBe(200);
    const note = ((await (await read(thread.id)).json()) as ListMessagesResponse).messages.at(-1);
    expect(note?.content).toContain(`/chat?workspace=fork-team&thread=${moved.thread.id}`);
  });

  it("refuses a team the person is not on, and a thread not started in Valet", async () => {
    await boot();
    await api!.providers.db.insert(teams).values({ id: "other-team", orgId: "local-org", name: "Other", createdAt: 1 });
    const { thread } = await personalThread();
    expect((await post(`/threads/${thread.id}/move`, { to: { teamId: "other-team" }, confirm: true })).status).toBe(403);
    const rule = await teamThread("sub:rule-1");
    const res = await post(`/threads/${rule.thread.id}/move`, { to: "private" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Only a thread started in Valet can move");
  });
});

describe("messages between linked threads", () => {
  const ctx = (at: { sessionId: string; threadId: string }, partial: Partial<ToolContext>): ToolContext => ({
    userId: "local-user", orgId: "local-org", sessionId: at.sessionId, threadId: at.threadId,
    requestDecision: vi.fn(async () => ({ actionId: "approve", resolvedBy: "local-user", resolvedAt: Date.now() })), ...partial,
  } as ToolContext);

  async function linked() {
    await boot();
    const team = await teamThread();
    const res = await post(`/threads/${team.thread.id}/fork`, { entryId: "a1", destination: "private" });
    const fork = (await res.json()) as ForkThreadResponse;
    const [list, send] = buildThreadLinkTools(() => api!.providers);
    return { team, fork: { sessionId: fork.thread.sessionId, threadId: fork.thread.id }, list: list!, send: send! };
  }

  async function prompts(at: { sessionId: string; threadId: string }) {
    const items = await api!.providers.engineStore.listUnsettledSubmissions(at.sessionId);
    return items.filter((item) => item.threadId === at.threadId).map((item) => JSON.stringify(item.content));
  }

  it("asks the person before a private branch posts to the team thread", async () => {
    const { team, fork, list, send } = await linked();
    const teamAt = { sessionId: team.sessionId, threadId: team.thread.id };
    const listed = await list.execute({}, ctx(fork, { interactiveActor: { id: "local-user" } }));
    expect(listed.text).toContain(team.thread.id);
    expect(listed.text).toContain("shows the person the text to approve");

    const context = ctx(fork, { interactiveActor: { id: "local-user" } });
    const result = await send.execute({ thread_id: team.thread.id, text: "Found the cause." }, context);
    expect(result.ok).not.toBe(false);
    expect(context.requestDecision).toHaveBeenCalledWith(expect.objectContaining({ type: "approval", context: { approver: { userId: "local-user" } } }));
    expect((await prompts(teamAt)).some((text) => text.includes("Found the cause."))).toBe(true);
  });

  it("posts nothing when the person does not approve", async () => {
    const { team, fork, send } = await linked();
    const context = ctx(fork, { interactiveActor: { id: "local-user" }, requestDecision: vi.fn(async () => ({ actionId: "cancel", resolvedBy: "local-user", resolvedAt: Date.now() })) });
    const result = await send.execute({ thread_id: team.thread.id, text: "secret" }, context);
    expect(result.text).toContain("did not approve");
    expect(await prompts({ sessionId: team.sessionId, threadId: team.thread.id })).toEqual([]);
  });

  it("sends from the team thread to its reader's private branch without asking", async () => {
    const { team, fork, send } = await linked();
    const context = ctx({ sessionId: team.sessionId, threadId: team.thread.id }, { interactiveActor: { id: "local-user" } });
    await send.execute({ thread_id: fork.threadId, text: "Also check the retry path." }, context);
    expect(context.requestDecision).not.toHaveBeenCalled();
    expect((await prompts(fork)).some((text) => text.includes("Also check the retry path."))).toBe(true);
  });

  it("refuses a sender who cannot read the target, and a turn no person wrote", async () => {
    const { team, fork, send } = await linked();
    const teamAt = { sessionId: team.sessionId, threadId: team.thread.id };
    const teammate = await send.execute({ thread_id: fork.threadId, text: "hi" }, ctx(teamAt, { userId: MEMBER, interactiveActor: { id: MEMBER } }));
    expect(teammate.text).toContain("cannot read that thread");
    const signal = await send.execute({ thread_id: fork.threadId, text: "hi" }, ctx(teamAt, {}));
    expect(signal.text).toContain("Only a message a person writes");
    const unlinked = await send.execute({ thread_id: "thr_nope", text: "hi" }, ctx(teamAt, { interactiveActor: { id: "local-user" } }));
    expect(unlinked.text).toContain("not linked");
  });
});
