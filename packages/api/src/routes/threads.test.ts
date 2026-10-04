import type { CreateTeamResponse, CreateTeamApiKeyResponse } from "../wire/types.js";
import { eq, sql } from "drizzle-orm";
import { agentSessions, teams, teamMembers } from "../schema/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

describe("thread addressing compatibility", () => {
  it("withdraws only a decision belonging to the addressed thread", async () => {
    api = await bootTestApi();
    const create = async () => {
      const response = await fetch(`${api!.baseUrl}/api/threads`, { method: "POST" });
      expect(response.status).toBe(201);
      return await response.json() as { id: string; sessionId: string };
    };
    const first = await create();
    const other = await create();
    const gate = {
      id: "addressed-withdrawal", sessionId: first.sessionId, threadId: first.id,
      queueItemId: "queued-question", resumeKey: "answer", ordinal: 0,
      type: "question" as const, title: "Which environment?", actions: [],
      status: "pending" as const, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await api.providers.engineStore.saveDecisionGate(first.sessionId, first.id, gate);
    const mismatch = await fetch(`${api.baseUrl}/api/threads/${first.id}/messages?threadId=${other.id}`);
    expect(mismatch.status).toBe(400);
    for (const body of [JSON.stringify({ threadId: other.id, title: "Wrong thread" }), "null", "[]"]) {
      const response = await fetch(`${api.baseUrl}/api/threads/${first.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body,
      });
      expect(response.status).toBe(400);
    }
    const withdraw = (threadId: string) => fetch(`${api!.baseUrl}/api/threads/${threadId}/decisions/${gate.id}/withdraw`, { method: "POST" });
    expect((await withdraw(other.id)).status).toBe(404);
    expect((await api.providers.engineStore.getDecisionGate(first.sessionId, gate.id))?.status).toBe("pending");
    expect((await withdraw(first.id)).status).toBe(200);
    expect((await api.providers.engineStore.getDecisionGate(first.sessionId, gate.id))?.status).toBe("withdrawn");
  });

  it("creates in the workspace and reads the same history through either address", async () => {
    api = await bootTestApi();
    const created = await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Thread API" }) });
    expect(created.status).toBe(201);
    const thread = await created.json();
    if (!thread || typeof thread !== "object" || !("id" in thread) || typeof thread.id !== "string" || !("sessionId" in thread) || typeof thread.sessionId !== "string") throw new Error("Invalid thread response");
    const detail = await fetch(`${api.baseUrl}/api/threads/${thread.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: thread.id, sessionId: thread.sessionId, title: "Thread API" });
    await api.providers.engineStore.appendEntries(thread.sessionId, thread.id, [{ id: "history-proof", sessionId: thread.sessionId, threadId: thread.id, parentId: null, type: "message", role: "user", content: "Preserve this history", createdAt: 1 }]);
    api.providers.engineHost.evictCache(thread.sessionId);
    const legacy = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(thread.sessionId)}/messages?threadId=${thread.id}`);
    const current = await fetch(`${api.baseUrl}/api/threads/${thread.id}/messages`);
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual(await legacy.json());
    const conflict = await fetch(`${api.baseUrl}/api/threads/${thread.id}/messages?threadId=other`);
    expect(conflict.status).toBe(400);
    const bodyConflict = await fetch(`${api.baseUrl}/api/threads/${thread.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "wrong thread", threadId: "other" }) });
    expect(bodyConflict.status).toBe(400);
    expect((await fetch(`${api.baseUrl}/api/threads/missing`)).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/threads/${thread.id}/messages`, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
    await api.providers.db.update(agentSessions).set({ orgId: "different-org" }).where(eq(agentSessions.id, thread.sessionId));
    expect((await fetch(`${api.baseUrl}/api/threads/${thread.id}`)).status).toBe(404);
    await api.providers.db.update(agentSessions).set({ orgId: "local-org" }).where(eq(agentSessions.id, thread.sessionId));
    await api.providers.db.insert(teams).values({ id: "thread-team", orgId: "local-org", name: "Thread team", createdAt: Date.now() });
    await api.providers.db.insert(teamMembers).values({ teamId: "thread-team", userId: "test-member", role: "member" });
    await api.providers.db.update(agentSessions).set({ ownerType: "team", ownerId: "thread-team" }).where(eq(agentSessions.id, thread.sessionId));
    const memberHeaders = { "x-valet-test-user-id": "test-member" };
    expect((await fetch(`${api.baseUrl}/api/threads/${thread.id}`, { headers: memberHeaders })).status).toBe(200);
    await api.providers.db.delete(teamMembers).where(eq(teamMembers.teamId, "thread-team"));
    expect((await fetch(`${api.baseUrl}/api/threads/${thread.id}`, { headers: memberHeaders })).status).toBe(404);
    await api.providers.db.update(agentSessions).set({ ownerType: "user", ownerId: "local-user" }).where(eq(agentSessions.id, thread.sessionId));
    const archive = await fetch(`${api.baseUrl}/api/threads/${thread.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: true }) });
    expect(archive.status).toBe(200);
    const archived = await fetch(`${api.baseUrl}/api/threads?archived=1`);
    expect(await archived.json()).toMatchObject({ threads: expect.arrayContaining([expect.objectContaining({ id: thread.id })]) });
  });
  it("withdraws a pending approval when its thread is archived (TKAI-260)", async () => {
    api = await bootTestApi();
    const thread = await (await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json() as { id: string; sessionId: string };
    const gate = {
      id: "archive-gate", sessionId: thread.sessionId, threadId: thread.id,
      queueItemId: "q-archive", resumeKey: "archive", ordinal: 0, type: "approval" as const,
      title: "Approve action?", actions: [{ id: "approve", label: "Approve" }],
      status: "pending" as const, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await api.providers.engineStore.saveDecisionGate(thread.sessionId, thread.id, gate);
    api.providers.engineHost.evictCache(thread.sessionId);
    // Archive used to flip archivedAt only, and the agent stayed suspended
    // on a gate nobody would see again.
    const archived = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(thread.sessionId)}/threads/${thread.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    expect((await api.providers.engineStore.getDecisionGate(thread.sessionId, gate.id))?.status).toBe("withdrawn");
  });

  it("keeps decisions inside their URL thread and denies team-key policy grants", async () => {
    api = await bootTestApi({ auth: true });
    const signup = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "thread-key@nowhere.test", name: "Admin", password: "correct-horse-battery" }) });
    const cookie = signup.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0];
    if (!cookie) throw new Error("Missing session cookie");
    const team = await (await fetch(`${api.baseUrl}/api/teams`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Thread team" }) })).json() as CreateTeamResponse;
    const key = await (await fetch(`${api.baseUrl}/api/teams/${team.team.id}/api-keys`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "CI" }) })).json() as CreateTeamApiKeyResponse;
    const headers = { "x-api-key": key.key, "content-type": "application/json" };
    expect(await (await fetch(`${api.baseUrl}/api/threads`, { headers })).json()).toEqual({ threads: [] });
    const created = await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers, body: "{}" });
    expect(created.status).toBe(201);
    const first = await created.json() as { id: string; sessionId: string };
    const second = await (await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers, body: "{}" })).json() as { id: string; sessionId: string };
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.id).not.toBe(first.id);
    const personal = await (await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).json() as { id: string };
    expect((await fetch(`${api.baseUrl}/api/threads/${personal.id}`, { headers })).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/threads?workspace=user`, { headers })).status).toBe(404);
    const gate = {
      id: "thread-key-gate", sessionId: first.sessionId, threadId: first.id,
      queueItemId: "q-key", resumeKey: "key", ordinal: 0, type: "approval" as const,
      title: "Approve action?", actions: [{ id: "approve", label: "Approve" }, { id: "always_allow", label: "Always allow" }],
      status: "pending" as const, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await api.providers.engineStore.saveDecisionGate(first.sessionId, first.id, gate);
    expect(await (await fetch(`${api.baseUrl}/api/threads/${second.id}/decisions`, { headers })).json()).toEqual({ gates: [] });
    const resolve = (id: string, actionId: string) => fetch(`${api!.baseUrl}/api/threads/${id}/decisions/${gate.id}/resolve`, { method: "POST", headers, body: JSON.stringify({ actionId }) });
    expect((await resolve(second.id, "approve")).status).toBe(404);
    expect((await resolve(first.id, "always_allow")).status).toBe(403);
    expect((await api.providers.engineStore.getDecisionGate(first.sessionId, gate.id))?.status).toBe("pending");
    const legacyDenial = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(first.sessionId)}/decisions/${gate.id}/resolve`, { method: "POST", headers, body: JSON.stringify({ actionId: "always_allow" }) });
    expect(legacyDenial.status).toBe(403);
    expect((await resolve(first.id, "approve")).status).toBe(200);

    // The admin's own helper thread on the team runtime is theirs alone. A
    // gate there names no approver, and the key's viewer names nobody, so the
    // two must not compare equal.
    const helper = await (await fetch(`${api.baseUrl}/api/workspaces/${team.team.id}/conversation`, { method: "POST", headers: { cookie } })).json() as { sessionId: string; threadId: string };
    await api.providers.engineStore.saveDecisionGate(helper.sessionId, helper.threadId, { ...gate, id: "helper-gate", sessionId: helper.sessionId, threadId: helper.threadId, resumeKey: "helper" });
    const decisions = `${api.baseUrl}/api/sessions/${encodeURIComponent(helper.sessionId)}/decisions`;
    expect(((await (await fetch(decisions, { headers })).json()) as { gates: Array<{ id: string }> }).gates.map((g) => g.id)).not.toContain("helper-gate");
    expect((await fetch(`${decisions}/helper-gate/resolve`, { method: "POST", headers, body: JSON.stringify({ actionId: "approve" }) })).status).toBe(404);
    expect((await api.providers.engineStore.getDecisionGate(first.sessionId, gate.id))?.status).toBe("resolved");
  });
});


describe("thread content search", () => {
  it("matches message content and titles, treats wildcards literally, and excludes other sessions", async () => {
    api = await bootTestApi();
    const create = async (title: string) => {
      const response = await fetch(`${api!.baseUrl}/api/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
      expect(response.status).toBe(201);
      return await response.json() as { id: string; sessionId: string };
    };
    const content = await create("Deployment discussion");
    const title = await create("Linear planning");
    await create("Unrelated chat");
    for (const [id, sessionId, threadId, role, text] of [
      ["search-user", content.sessionId, content.id, "user", "Fix the LINEAR webhook at 100%"],
      ["search-assistant", content.sessionId, content.id, "assistant", "The receipt contains a signature mismatch"],
      ["search-other", "other-session", title.id, "user", "private needle"],
    ]) {
      await api.providers.db.execute(sql`insert into engine_entries (id, session_id, thread_id, entry_type, role, content, created_at) values (${id}, ${sessionId}, ${threadId}, 'message', ${role}, ${text}, 1)`);
    }
    const search = async (q: string) => {
      const response = await fetch(`${api!.baseUrl}/api/sessions/${encodeURIComponent(content.sessionId)}/threads?q=${encodeURIComponent(q)}`);
      expect(response.status).toBe(200);
      return (await response.json() as { threads: { id: string }[] }).threads.map(t => t.id).sort();
    };
    expect(await search("linear")).toEqual([content.id, title.id].sort());
    expect(await search("signature")).toEqual([content.id]);
    expect(await search("%")).toEqual([content.id]);
    expect(await search("private needle")).toEqual([]);
    expect(await search("absent")).toEqual([]);
    for (const path of ["threads", `sessions/${encodeURIComponent(content.sessionId)}/threads`]) {
      const response = await fetch(`${api.baseUrl}/api/${path}?q=%00`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Search contains an unsupported NUL character. Remove it and try again." });
    }
  });
});
