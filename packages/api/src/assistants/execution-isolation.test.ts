import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { restoreOneSession } from "../boot-restore.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { internalToken } from "../lib/internal-auth.js";
import { addMember, createTeam } from "../services/teams.js";
import { agentSessions, assistants } from "../schema/index.js";
import { eq, sql } from "drizzle-orm";
import { ensureAssistantExecution, ensureDefaultAssistantSession } from "./service.js";

let api: TestApi;
afterEach(async () => { await api?.cleanup(); });

it("keeps team helper files and memory separate across members and cache rebuilds", async () => {
  api = await bootTestApi();
  const p = api.providers;
  const team = await createTeam(p.db, { orgId: "local-org", name: "Private execution", creatorUserId: "local-user" });
  await addMember(p.db, { teamId: team.id, userId: "test-member", role: "member" });
  const owner = { type: "team" as const, id: team.id };
  const open = (user: string) => ensureAssistantExecution(p, owner, { orgId: "local-org", actorUserId: user }, `app-assistant:${user}`);
  const [alice, repeated] = await Promise.all([open("local-user"), open("local-user")]);
  expect(alice.sessionId).toBe(repeated.sessionId);
  const bob = await open("test-member");
  expect(bob.sessionId).not.toBe(alice.sessionId);
  expect(bob.session.options.workspace).not.toBe(alice.session.options.workspace);
  await alice.session.sandbox.writeFile("/workspace/private.txt", "Private acquisition");
  await expect(bob.session.sandbox.readFile("/workspace/private.txt")).rejects.toThrow();
  const memory = (sessionId: string, actor: string, method: string, body?: object) => fetch(`${api.baseUrl}/api/memory?path=notes/private.md`, {
    method, headers: { "content-type": "application/json", "x-valet-internal": internalToken(),
      "x-valet-owner": `team:${team.id}`, "x-valet-actor": actor, "x-valet-session-id": sessionId, "x-valet-org-id": "local-org" },
    body: body ? JSON.stringify(body) : undefined,
  });
  expect((await memory(alice.sessionId, "local-user", "PUT", { path: "notes/private.md", content: "Private acquisition", pinned: true })).status).toBe(200);
  expect((await memory(bob.sessionId, "test-member", "GET")).status).toBe(404);
  const attack = await fetch(`${api.baseUrl}/api/memory?ownerType=team&ownerId=${team.id}&sessionId=${alice.sessionId}&path=notes/private.md`, {
    headers: { "x-valet-test-user-id": "test-member" },
  });
  expect(attack.status).toBe(404);
  const request = (path: string, user = "local-user", method = "GET", body?: object) => fetch(`${api.baseUrl}${path}`, {
    method, headers: { "x-valet-test-user-id": user, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const [root] = await p.db.select().from(assistants).where(eq(assistants.id, alice.assistant.id));
  const aliceThread = await alice.session.ensureDefaultThread();
  const bobThread = await bob.session.ensureDefaultThread();
  const mine = await (await request(`/api/threads?workspace=${team.id}`)).json();
  expect(mine).toMatchObject({ threads: expect.arrayContaining([expect.objectContaining({ id: aliceThread.id, sessionId: alice.sessionId })]) });
  expect(mine).not.toMatchObject({ threads: expect.arrayContaining([expect.objectContaining({ id: bobThread.id })]) });
  const theirs = await (await request(`/api/threads?workspace=${team.id}`, "test-member")).json();
  expect(theirs).not.toMatchObject({ threads: expect.arrayContaining([expect.objectContaining({ id: aliceThread.id })]) });
  const standalone = await (await request(`/api/sessions?workspace=${team.id}`, "test-member")).json();
  expect(JSON.stringify(standalone)).not.toContain(alice.sessionId);
  expect((await request(`/api/sessions/${alice.sessionId}/sandbox-jwt`, "local-user", "POST")).status).toBe(200);
  expect((await request(`/api/sessions/${alice.sessionId}/sandbox-jwt`, "test-member", "POST")).status).toBe(404);
  expect((await request(`/api/sessions/${root.sessionId}/sandbox-jwt`, "local-user", "POST")).status).toBe(404);
  expect((await request(`/api/sessions/${root.sessionId}/messages`, "local-user", "POST", { text: "Continue" })).status).toBe(409);
  const legacy = p.engineHost.liveSession(root.sessionId);
  if (!legacy) throw new Error("Legacy runtime is missing");
  await expect(legacy.prompt("/model")).rejects.toThrow("read-only");
  await expect(legacy.thread().submitPrompt("Continue", {})).rejects.toThrow("read-only");
  await p.db.insert(assistants).values({ id: "retired-context", orgId: "local-org", ownerType: "team",
    ownerId: `${team.id}:retired:retired-context`, sessionId: "old-private-session", createdAt: 1, archivedAt: 2 });
  await p.engineStore.saveThread("old-private-session", { id: "private-history", sessionId: "old-private-session",
    key: "app-assistant:local-user", status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
  const historyPath = `/api/workspaces/${team.id}/history?sessionId=old-private-session&threadId=private-history`;
  expect((await request(historyPath)).status).toBe(200);
  expect((await request(historyPath, "test-member")).status).toBe(404);
  expect((await request(`${historyPath}&before=9999999999999999999`)).status).toBe(400);
  for (let index = 0; index < 101; index++) {
    await p.engineStore.saveThread("old-private-session", { id: `zz-private-history-${String(index).padStart(3, "0")}`,
      sessionId: "old-private-session", key: `workflow:private-${index}:local-user`, status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1 });
  }
  const page = await (await request(`/api/workspaces/${team.id}/history`, "test-member")).json();
  expect(JSON.stringify(page)).not.toContain("zz-private-history");
  if (!page || typeof page !== "object" || !("nextCursor" in page) || typeof page.nextCursor !== "string") {
    throw new Error("Expected a continuation cursor for filtered history");
  }
  expect((await request(`/api/workspaces/${team.id}/history?before=${page.nextCursor}`, "test-member")).status).toBe(200);
  expect((await request(`/api/workspaces/${team.id}/history?before=${page.nextCursor}`)).status).toBe(400);


  const fresh = await request(`/api/threads?workspace=${team.id}`, "local-user", "POST", { sourceThreadId: aliceThread.id });
  expect(fresh.status).toBe(201);
  expect(await fresh.json()).not.toMatchObject({ sessionId: root.sessionId });
  await p.db.execute(sql`UPDATE engine_sessions SET parent_thread_id = NULL WHERE id = ${alice.sessionId}`);
  expect((await request(`/api/memory?ownerType=team&ownerId=${team.id}&sessionId=${alice.sessionId}&path=notes/private.md`, "test-member")).status).toBe(404);
  const mapping = await p.engineStore.getSession(alice.sessionId);
  expect(mapping?.parentSessionId).toBe(root.sessionId);
  await p.db.execute(sql`UPDATE engine_sessions SET parent_thread_id = ${alice.session.options.parentThreadId} WHERE id = ${alice.sessionId}`);
  p.engineHost.evictCache(alice.sessionId);
  p.engineHost.evictCache(bob.sessionId);
  const restoredAlice = await open("local-user");
  const restoredBob = await open("test-member");
  expect(restoredAlice.sessionId).toBe(alice.sessionId);
  expect(restoredBob.sessionId).toBe(bob.sessionId);
  expect(JSON.stringify(restoredAlice.session.options.systemContext)).toContain("Private acquisition");
  expect(JSON.stringify(restoredBob.session.options.systemContext)).not.toContain("Private acquisition");
});

it("settles durable legacy team submissions as aborted at read-only restoration", async () => {
  api = await bootTestApi();
  const p = api.providers;
  const team = await createTeam(p.db, { orgId: "local-org", name: "Cutover", creatorUserId: "local-user" });
  const owner = { type: "team", id: team.id } as const;
  const meta = { orgId: "local-org", actorUserId: "local-user" };
  const root = await ensureDefaultAssistantSession(p, owner, meta);
  const thread = await root.session.ensureDefaultThread();
  const now = Date.now();
  for (const id of ["legacy-running", "legacy-queued"]) {
    await p.engineStore.admitSubmission(root.sessionId, thread.id, { id, threadId: thread.id, content: "old work",
      status: "queued", attemptCount: 0, maxAttempts: 10, timeoutAt: now + 60_000, createdAt: now, updatedAt: now });
  }
  await p.engineStore.claimSubmission({ sessionId: root.sessionId, threadId: thread.id, itemId: "legacy-running",
    attemptId: "old-attempt", ownerId: "old-process" });
  p.engineHost.evictCache(root.sessionId);
  // Follow the startup enumeration and generic restore path; no user opens the root.
  const ids = await p.engineStore.listSessionIdsWithUnsettledSubmissions();
  expect(ids).toContain(root.sessionId);
  for (const id of ids) await restoreOneSession(id, {
    ensureWorkflowSession: async () => { throw new Error("Not a workflow session"); },
    lookupAgentSession: async sessionId => {
      const [row] = await p.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
      return row ? { ...await loadSessionMeta(p.db, row), profile: row.profile } : undefined;
    },
    sessionFor: (sessionId, sessionMeta) => p.engineHost.sessionFor(sessionId, sessionMeta),
  });
  expect(await p.engineStore.listUnsettledSubmissions(root.sessionId)).toEqual([]);
  for (const id of ["legacy-running", "legacy-queued"]) {
    expect(await p.engineStore.getQueueItem(root.sessionId, id)).toMatchObject({ status: "settled",
      outcome: { outcome: "aborted", error: expect.stringContaining("read-only") } });
  }
});

it("deletes a team execution individually and tears down every runtime when deleting its team", async () => {
  api = await bootTestApi();
  const p = api.providers;
  const team = await createTeam(p.db, { orgId: "local-org", name: "Execution teardown", creatorUserId: "local-user" });
  const owner = { type: "team", id: team.id } as const;
  const meta = { orgId: "local-org", actorUserId: "local-user" };
  const first = await ensureAssistantExecution(p, owner, meta, "app-assistant:local-user");
  const second = await ensureAssistantExecution(p, owner, meta, "web:default");
  await second.session.sandbox.writeFile("/workspace/secret.txt", "teardown marker");
  expect((await fetch(`${api.baseUrl}/api/sessions/${first.sessionId}`, { method: "DELETE" })).status).toBe(200);
  await expect(ensureAssistantExecution(p, owner, meta, "app-assistant:local-user")).rejects.toThrow();
  expect((await fetch(`${api.baseUrl}/api/teams/${team.id}`, { method: "DELETE" })).status).toBe(200);
  const rows = await p.db.select().from(agentSessions).where(eq(agentSessions.ownerId, team.id));
  expect(rows.every(row => row.status === "deleted")).toBe(true);
  expect(p.engineHost.liveSession(second.sessionId)).toBeNull();
  expect(await p.engineStore.getSession(second.sessionId)).toBeNull();
  await expect(ensureAssistantExecution(p, owner, meta, "web:default")).rejects.toThrow();
});
