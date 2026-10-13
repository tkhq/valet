/**
 * Thread sharing (docs/specs/2026-10-13-thread-sharing-design.md): the owner
 * of a personal thread lets other members of the organization open that one
 * thread by its link, to watch it or to watch and reply. The thread keeps
 * running as its owner, and nothing else of the owner's workspace opens.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { WebSocket } from "ws";
import { loadSessionMeta } from "../engine/session-meta.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, teamMembers, teams, users } from "../schema/index.js";
import { eq } from "drizzle-orm";
import type { ListMessagesResponse, ListThreadsResponse, SendPromptResponse, ThreadAddress, ThreadSummary, WireEvent } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const MEMBER = "test-member";
const OUTSIDER = "outsider";
const as = (user: string) => ({ "x-valet-test-user-id": user, "content-type": "application/json" });

async function boot(): Promise<{ api: TestApi; shared: { id: string; sessionId: string }; other: { id: string; sessionId: string } }> {
  const booted = await bootTestApi();
  api = booted;
  // A user with no membership in the owner's organization.
  await booted.providers.db.insert(users).values({ id: OUTSIDER, email: "outsider@elsewhere.test", name: "Outsider", role: "member" });
  const create = async () => {
    const response = await fetch(`${booted.baseUrl}/api/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; sessionId: string };
  };
  const shared = await create();
  const other = await create();
  expect(other.sessionId).toBe(shared.sessionId);
  await booted.providers.engineStore.appendEntries(shared.sessionId, shared.id, [{
    id: "incident-note", sessionId: shared.sessionId, threadId: shared.id, parentId: null,
    type: "message", role: "user", content: "Investigate the checkout errors", createdAt: 1,
  }]);
  booted.providers.engineHost.evictCache(shared.sessionId);
  return { api: booted, shared, other };
}

async function setShare(target: TestApi, threadId: string, share: string, user = "local-user") {
  return fetch(`${target.baseUrl}/api/threads/${threadId}`, { method: "PATCH", headers: as(user), body: JSON.stringify({ share }) });
}

function pendingGate(sessionId: string, threadId: string, id: string) {
  return {
    id, sessionId, threadId, queueItemId: `q-${id}`, resumeKey: id, ordinal: 0, type: "approval" as const,
    title: "Deploy the fix?", actions: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
    status: "pending" as const, createdAt: Date.now(), updatedAt: Date.now(),
  };
}

function openSocket(wsUrl: string, sessionId: string, user: string, threadId?: string) {
  const frames: WireEvent[] = [];
  const closes: number[] = [];
  const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
  const ws = new WebSocket(`${wsUrl}/api/sessions/${encodeURIComponent(sessionId)}/ws${query}`, { headers: { "x-valet-test-user-id": user } });
  ws.on("message", (data) => frames.push(JSON.parse(data.toString()) as WireEvent));
  ws.on("close", (code) => closes.push(code));
  return { ws, frames, closes };
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

describe("thread sharing", () => {
  it("keeps a personal thread private until its owner shares it, and only that thread", async () => {
    const { api, shared, other } = await boot();
    const read = (user: string, path = "") => fetch(`${api.baseUrl}/api/threads/${shared.id}${path}`, { headers: as(user) });

    // Off by default: an org member and a non-member both see nothing.
    expect((await read(MEMBER)).status).toBe(404);
    expect((await read(MEMBER, "/messages")).status).toBe(404);
    expect((await setShare(api, shared.id, "view", MEMBER)).status).toBe(404);

    const saved = await setShare(api, shared.id, "view");
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as ThreadSummary).share).toBe("view");
    const list = (await (await fetch(`${api.baseUrl}/api/threads`)).json()) as ListThreadsResponse;
    expect(list.threads.find((t) => t.id === shared.id)?.share).toBe("view");
    expect(list.threads.find((t) => t.id === other.id)?.share).toBeUndefined();

    // A non-member of the organization stays out.
    expect((await read(OUTSIDER)).status).toBe(404);
    expect((await read(OUTSIDER, "/messages")).status).toBe(404);

    // An org member opens the thread and its history by the link.
    const address = (await (await read(MEMBER)).json()) as ThreadAddress;
    expect(address).toMatchObject({ id: shared.id, share: "view", guest: { mode: "view", ownerName: "Local Dev" } });
    const history = (await (await read(MEMBER, "/messages")).json()) as ListMessagesResponse;
    expect(history.messages.map((m) => m.content)).toContain("Investigate the checkout errors");

    // View does not admit prompts, settings, or a new share.
    const prompt = await fetch(`${api.baseUrl}/api/threads/${shared.id}/messages`, { method: "POST", headers: as(MEMBER), body: JSON.stringify({ text: "hi" }) });
    expect(prompt.status).toBe(403);
    expect((await fetch(`${api.baseUrl}/api/threads/${shared.id}`, { method: "PATCH", headers: as(MEMBER), body: JSON.stringify({ title: "Mine" }) })).status).toBe(403);
    expect((await setShare(api, shared.id, "reply", MEMBER)).status).toBe(403);

    // Nothing else of the owner's workspace opens: not another thread, not
    // the session, its thread list, or its session-addressed routes.
    const sid = encodeURIComponent(shared.sessionId);
    expect((await fetch(`${api.baseUrl}/api/threads/${other.id}`, { headers: as(MEMBER) })).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/threads/${other.id}/messages`, { headers: as(MEMBER) })).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/sessions/${sid}`, { headers: as(MEMBER) })).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/sessions/${sid}/threads`, { headers: as(MEMBER) })).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/sessions/${sid}/messages?threadId=${shared.id}`, { headers: as(MEMBER) })).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/sessions/${sid}/decisions`, { headers: as(MEMBER) })).status).toBe(404);
    // The member's own thread list does not pick up the shared thread.
    const own = (await (await fetch(`${api.baseUrl}/api/threads`, { headers: as(MEMBER) })).json()) as ListThreadsResponse;
    expect(own.threads.some((t) => t.id === shared.id || t.id === other.id)).toBe(false);

    // A pending approval shows to the guest, who cannot answer it.
    await api.providers.engineStore.saveDecisionGate(shared.sessionId, shared.id, pendingGate(shared.sessionId, shared.id, "view-gate"));
    const gates = await (await read(MEMBER, "/decisions")).json() as { gates: Array<{ id: string }> };
    expect(gates.gates.map((g) => g.id)).toEqual(["view-gate"]);
    const resolve = await fetch(`${api.baseUrl}/api/threads/${shared.id}/decisions/view-gate/resolve`, { method: "POST", headers: as(MEMBER), body: JSON.stringify({ actionId: "approve" }) });
    expect(resolve.status).toBe(403);
    expect((await api.providers.engineStore.getDecisionGate(shared.sessionId, "view-gate"))?.status).toBe("pending");

    // Revoke takes effect on the next request.
    expect((await setShare(api, shared.id, "off")).status).toBe(200);
    expect((await read(MEMBER)).status).toBe(404);
    expect((await read(MEMBER, "/messages")).status).toBe(404);

    // A team thread has no share: the team already sees it.
    await api.providers.db.insert(teams).values({ id: "share-team", orgId: "local-org", name: "Ops", createdAt: Date.now() });
    await api.providers.db.insert(teamMembers).values({ teamId: "share-team", userId: "local-user", role: "admin" });
    await api.providers.db.update(agentSessions).set({ ownerType: "team", ownerId: "share-team" }).where(eq(agentSessions.id, shared.sessionId));
    api.providers.engineHost.evictCache(shared.sessionId);
    const teamShare = await fetch(`${api.baseUrl}/api/sessions/${sid}/threads/${shared.id}`, { method: "PATCH", headers: as("local-user"), body: JSON.stringify({ share: "view" }) });
    expect(teamShare.status).toBe(400);
  });

  it("lets a replier prompt as themselves while the thread runs as its owner", async () => {
    const { api, shared } = await boot();
    const owner = await api.providers.engineHost.sessionFor(shared.sessionId, await loadSessionMeta(api.providers.db,
      (await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, shared.sessionId)))[0]!));
    const thread = owner.threadById(shared.id);
    if (!thread) throw new Error("shared thread is not loaded");
    await thread.pause();
    expect((await setShare(api, shared.id, "reply")).status).toBe(200);

    const send = (body: Record<string, unknown>) => fetch(`${api.baseUrl}/api/threads/${shared.id}/messages`, { method: "POST", headers: as(MEMBER), body: JSON.stringify(body) });
    const sent = await send({ text: "Check the payment logs too" });
    expect(sent.status).toBe(202);
    const { messageId } = (await sent.json()) as SendPromptResponse;
    const item = await api.providers.engineStore.getQueueItem(shared.sessionId, messageId!);
    expect(item?.author).toMatchObject({ id: MEMBER, name: "Test Member" });
    // Commands change the owner's thread, so a replier cannot run them.
    expect((await send({ text: "/model claude-sonnet-4-5" })).status).toBe(403);

    // The replier's turn reads the owner's connected account, not their own.
    await api.providers.engineCredentials.save({ type: "user", id: "local-user" }, "linear", { type: "api_key", apiKey: "owner-linear" });
    await api.providers.engineCredentials.save({ type: "user", id: MEMBER }, "linear", { type: "api_key", apiKey: "member-linear" });
    const credential = await owner.credentialProvider({ actorId: MEMBER, threadId: shared.id }).get("linear");
    expect(credential?.accessToken).toBe("owner-linear");

    // Approvals stay with the owner.
    await api.providers.engineStore.saveDecisionGate(shared.sessionId, shared.id, pendingGate(shared.sessionId, shared.id, "reply-gate"));
    const resolve = (user: string) => fetch(`${api.baseUrl}/api/threads/${shared.id}/decisions/reply-gate/resolve`, { method: "POST", headers: as(user), body: JSON.stringify({ actionId: "approve" }) });
    const denied = await resolve(MEMBER);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/thread owner/);
    expect((await fetch(`${api.baseUrl}/api/threads/${shared.id}/decisions/reply-gate/withdraw`, { method: "POST", headers: as(MEMBER), body: "{}" })).status).toBe(403);
    expect((await resolve("local-user")).status).toBe(200);

    // Revoking stops the next prompt.
    expect((await setShare(api, shared.id, "off")).status).toBe(200);
    expect((await send({ text: "one more" })).status).toBe(404);
  });

  it("streams only the shared thread to a guest and ends the stream on revoke", async () => {
    const { api, shared, other } = await boot();
    const owner = await api.providers.engineHost.sessionFor(shared.sessionId, await loadSessionMeta(api.providers.db,
      (await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, shared.sessionId)))[0]!));

    // Before the share, a guest stream is refused.
    const early = openSocket(api.wsUrl, shared.sessionId, MEMBER, shared.id);
    expect(await until(() => early.closes.length > 0)).toBe(true);
    expect(early.closes[0]).toBe(4040);

    expect((await setShare(api, shared.id, "view")).status).toBe(200);
    const plain = openSocket(api.wsUrl, shared.sessionId, MEMBER);
    const wrong = openSocket(api.wsUrl, shared.sessionId, MEMBER, other.id);
    const guest = openSocket(api.wsUrl, shared.sessionId, MEMBER, shared.id);
    expect(await until(() => plain.closes.length > 0 && wrong.closes.length > 0)).toBe(true);
    expect([plain.closes[0], wrong.closes[0]]).toEqual([4040, 4040]);
    expect(await until(() => guest.frames.some((f) => f.type === "init"))).toBe(true);
    const init = guest.frames.find((f) => f.type === "init");
    expect(init?.type === "init" ? init.session.workspace : undefined).toBe("");

    const marker = (threadId: string, code: string) => owner.emit({ type: "error", threadId, code, error: code, recoverable: true });
    await marker(other.id, "other-thread");
    await marker(shared.id, "shared-thread");
    expect(await until(() => guest.frames.some((f) => f.type === "error" && f.code === "shared-thread"))).toBe(true);
    const threadIds = guest.frames.flatMap((f) => "threadId" in f && typeof f.threadId === "string" ? [f.threadId] : []);
    expect(new Set(threadIds)).toEqual(new Set([shared.id]));
    expect(guest.frames.some((f) => f.type === "sandbox.status")).toBe(false);

    expect((await setShare(api, shared.id, "off")).status).toBe(200);
    await marker(shared.id, "after-revoke");
    expect(await until(() => guest.closes.length > 0)).toBe(true);
    expect(guest.closes[0]).toBe(4040);
    expect(guest.frames.some((f) => f.type === "error" && f.code === "after-revoke")).toBe(false);
  });
});

describe("a personal runtime a guest wakes", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("keeps author-less turns as the owner, and refuses the guest's turn", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    try {
      const booted = await bootTestApi({ plugins: [] });
      api = booted;
      const { db, engineHost } = booted.providers;
      // A guest's reply is the first request that reaches the cold runtime.
      const { session } = await ensureDefaultAssistantSession({ db, engineHost }, { type: "user", id: "local-user" }, { actorUserId: MEMBER, orgId: "local-org" });
      const bash = (id: string) => [
        fauxAssistantMessage([fauxToolCall("bash", { command: "echo workspace-tool-ran" }, { id })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ];
      const transcript = async () => JSON.stringify(await session.readEntries("web:default"));

      // An author-less turn, such as a signal or a schedule, acts for the owner.
      faux.setResponses(bash("owner-bash"));
      await session.prompt("run the scheduled check");
      // The bash output, not the command: JSON escapes its trailing newline.
      await vi.waitFor(async () => expect(await transcript()).toMatch(/workspace-tool-ran\\n|\[not_available\]/));
      expect(await transcript()).not.toContain("[not_available]");

      faux.setResponses(bash("guest-bash"));
      await session.prompt("run it for me", { author: { id: MEMBER, name: "Member" } });
      await vi.waitFor(async () => expect(await transcript()).toContain("[not_available] bash"));
    } finally {
      faux.unregister();
    }
  });
});
