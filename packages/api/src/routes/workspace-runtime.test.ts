import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, assistants, assistantExecutions, teams, teamMembers } from "../schema/index.js";
import type { EnsureWorkspaceRuntimeResponse, ListThreadsResponse, CreateThreadResponse } from "../wire/types.js";
let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
describe("workspace runtime authorization", () => {
  it("ensures personal runtime idempotently and answers the entry point older clients call", async () => {
    api = await bootTestApi();
    const root = `${api.baseUrl}/api/workspaces/user/runtime`;
    const first = await (await fetch(root, { method: "POST" })).json() as { sessionId: string };
    expect(await (await fetch(root, { method: "POST" })).json()).toEqual(first);
    expect(await (await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" })).json()).toEqual(first);
    expect((await fetch(`${api.baseUrl}/api/teams/unknown/orchestrator`, { method: "POST" })).status).toBe(404);
  });
  it("opens a fresh workspace runtime while preserving explicit session deletion", async () => {
    api = await bootTestApi();
    const root = `${api.baseUrl}/api/workspaces/user/runtime`;
    const { sessionId } = await (await fetch(root, { method: "POST" })).json() as { sessionId: string };
    await api.providers.db.update(agentSessions).set({ status: "deleted" }).where(eq(agentSessions.id, sessionId));
    const reopened = await fetch(root, { method: "POST" });
    expect(reopened.status).toBe(200);
    const replacement = await reopened.json() as { sessionId: string };
    expect(replacement.sessionId).not.toBe(sessionId);
    expect((await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/threads`)).status).toBe(409);
    const [row] = await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    expect(row?.status).toBe("deleted");
  });
  it("replaces an archived personal default once without reviving its history", async () => {
    api = await bootTestApi();
    const root = `${api.baseUrl}/api/workspaces/user/runtime`;
    const { sessionId } = await (await fetch(root, { method: "POST" })).json() as { sessionId: string };
    const originalSession = await api.providers.engineStore.getSession(sessionId);
    await api.providers.db.execute(sql`UPDATE assistants SET behavior = '{"integrations":{"mode":"allowlist","entries":[]}}' WHERE session_id = ${sessionId}`);
    await api.providers.db.update(assistants).set({ archivedAt: 123 }).where(eq(assistants.sessionId, sessionId));
    const replies = await Promise.all(Array.from({ length: 4 }, () => fetch(root, { method: "POST" })));
    const ids = [];
    for (const reply of replies) {
      expect(reply.status).toBe(200);
      ids.push((await reply.json() as { sessionId: string }).sessionId);
    }
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe(sessionId);
    const [old] = await api.providers.db.select().from(assistants).where(eq(assistants.sessionId, sessionId));
    expect(old.archivedAt).toBe(123);
    expect(await api.providers.engineStore.getSession(sessionId)).toEqual(originalSession);
    const limit = await fetch(`${api.baseUrl}/api/workspaces/user/integration-limit`);
    expect(await limit.json()).toEqual({ services: [] });
    expect((await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(ids[0])}/threads`)).status).toBe(200);
  });
  it("answers a team runtime on the older team path for a member", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(teams).values({ id: "legacy-team", orgId: "local-org", name: "Legacy", createdAt: 1 });
    await api.providers.db.insert(teamMembers).values({ teamId: "legacy-team", userId: "local-user", role: "member" });
    const legacy = await (await fetch(`${api.baseUrl}/api/teams/legacy-team/orchestrator`, { method: "POST" })).json();
    expect(legacy).toEqual(await (await fetch(`${api.baseUrl}/api/workspaces/legacy-team/runtime`, { method: "POST" })).json());
  });
  it("returns a writable, viewer-isolated team runtime for default CLI prompts", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(teams).values({ id: "cli-team", orgId: "local-org", name: "CLI", createdAt: 1 });
    await api.providers.db.insert(teamMembers).values({ teamId: "cli-team", userId: "local-user", role: "admin" });
    const response = await fetch(`${api.baseUrl}/api/workspaces/cli-team/runtime`, { method: "POST" });
    const { sessionId } = await response.json() as { sessionId: string };
    expect(sessionId).toMatch(/^execution:/);
    const session = api.providers.engineHost.liveSession(sessionId);
    if (!session) throw new Error("Missing ensured runtime");
    expect(session.options.readOnlyReason).toBeUndefined();
    const [mapping] = await api.providers.db.select().from(assistantExecutions).where(eq(assistantExecutions.sessionId, sessionId));
    expect(mapping.conversationKey).toBe("app-assistant:local-user");
  });
  it("returns the workspace root separately so the web creates and lists shared conversations", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(teams).values({ id: "web-team", orgId: "local-org", name: "Web", createdAt: 1 });
    await api.providers.db.insert(teamMembers).values([
      { teamId: "web-team", userId: "local-user", role: "admin" },
      { teamId: "web-team", userId: "test-member", role: "member" },
    ]);
    const request = (path: string, user = "local-user", method = "GET") => fetch(`${api?.baseUrl}/api${path}`, {
      method, headers: { "x-valet-test-user-id": user },
    });
    const mine = await (await request("/workspaces/web-team/runtime", "local-user", "POST")).json() as EnsureWorkspaceRuntimeResponse;
    const theirs = await (await request("/workspaces/web-team/runtime", "test-member", "POST")).json() as EnsureWorkspaceRuntimeResponse;
    expect(mine.sessionId).not.toBe(theirs.sessionId);
    expect(mine.workspaceSessionId).toBe(theirs.workspaceSessionId);
    expect(mine.workspaceSessionId).toMatch(/^assistant:/);
    const path = `/sessions/${mine.workspaceSessionId}/threads`;
    const before = await (await request(path)).json() as ListThreadsResponse;
    expect(before.threads.every((thread: { sessionId: string }) => thread.sessionId !== mine.workspaceSessionId)).toBe(true);
    const shared = await (await request(path, "local-user", "POST")).json() as CreateThreadResponse;
    for (const user of ["local-user", "test-member"]) {
      expect(await (await request(path, user)).json()).toMatchObject({ threads: expect.arrayContaining([
        expect.objectContaining({ id: shared.id, sessionId: shared.sessionId, key: shared.key }),
      ]) });
      expect((await request(`/threads/${shared.id}/messages`, user)).status).toBe(200);
    }
    expect((await request(`/sessions/${mine.sessionId}/threads`, "test-member")).status).toBe(404);
  });
  it("authorizes every operation by the requested team's organization and membership", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(teams).values([
      { id: "same", orgId: "local-org", name: "Same", createdAt: 1 },
      { id: "foreign", orgId: "foreign-org", name: "Foreign", createdAt: 1 },
    ]);
    await api.providers.db.insert(teamMembers).values([
      { teamId: "same", userId: "test-member", role: "member" },
      { teamId: "foreign", userId: "test-member", role: "member" },
    ]);
    for (const workspace of ["same", "foreign", "missing"]) {
      for (const [suffix, method] of [["", "POST"], ["/info", "GET"]]) {
        const response = await fetch(`${api.baseUrl}/api/workspaces/${workspace}/runtime${suffix}`, { method, headers: { "x-valet-test-user-id": "test-member" } });
        expect(response.status).toBe(workspace === "same" ? 200 : 404);
      }
    }
    await api.providers.db.delete(teamMembers).where(eq(teamMembers.userId, "test-member"));
    for (const [suffix, method] of [["", "POST"], ["/info", "GET"]]) {
      expect((await fetch(`${api.baseUrl}/api/workspaces/same/runtime${suffix}`, { method, headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
    }
  });
});
