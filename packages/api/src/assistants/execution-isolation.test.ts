import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { restoreOneSession } from "../boot-restore.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { buildWorkflowEngineDeps } from "../workflows/engine-deps.js";
import { internalToken } from "../lib/internal-auth.js";
import { addMember, createTeam } from "../services/teams.js";
import { agentSessions, assistants, assistantExecutions, workflowDefinitions, workflowRuns, teamMembers } from "../schema/index.js";
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
  const [replacement, concurrent] = await Promise.all([
    ensureAssistantExecution(p, owner, meta, "app-assistant:local-user"),
    ensureAssistantExecution(p, owner, meta, "app-assistant:local-user"),
  ]);
  expect(replacement.sessionId).not.toBe(first.sessionId);
  expect(replacement.sessionId).toBe(concurrent.sessionId);
  expect(replacement.session.options.workspace).not.toBe(first.session.options.workspace);
  expect(await p.engineStore.getSession(first.sessionId)).toBeNull();
  const [deleted] = await p.db.select().from(agentSessions).where(eq(agentSessions.id, first.sessionId));
  expect(deleted.status).toBe("deleted");
  for (const suffix of ["runtime", "conversation"]) {
    expect((await fetch(`${api.baseUrl}/api/workspaces/${team.id}/${suffix}`, { method: "POST" })).status).toBe(200);
  }
  expect((await fetch(`${api.baseUrl}/api/teams/${team.id}`, { method: "DELETE" })).status).toBe(200);
  const rows = await p.db.select().from(agentSessions).where(eq(agentSessions.ownerId, team.id));
  expect(rows.every(row => row.status === "deleted")).toBe(true);
  expect(p.engineHost.liveSession(second.sessionId)).toBeNull();
  expect(await p.engineStore.getSession(second.sessionId)).toBeNull();
  await expect(ensureAssistantExecution(p, owner, meta, "web:default")).rejects.toThrow();
});

it("keeps shared team memory across web threads and private workflow memory across runs", async () => {
  api = await bootTestApi();
  const p = api.providers;
  const team = await createTeam(p.db, { orgId: "local-org", name: "Memory continuity", creatorUserId: "local-user" });
  await addMember(p.db, { teamId: team.id, userId: "test-member", role: "member" });
  const owner = { type: "team", id: team.id } as const;
  const open = (key: string, actorUserId = "local-user") => ensureAssistantExecution(p, owner, { orgId: "local-org", actorUserId }, key);
  const alice = await open("app-assistant:local-user");
  const bob = await open("app-assistant:test-member", "test-member");
  const first = await open("web:one");
  const second = await open("web:two", "test-member");
  const request = (sessionId: string, path: string, content?: string) => fetch(`${api.baseUrl}/api/memory?path=${encodeURIComponent(path)}`, {
    method: content === undefined ? "GET" : "PUT",
    headers: { "content-type": "application/json", "x-valet-internal": internalToken(), "x-valet-owner": `team:${team.id}`,
      "x-valet-actor": "local-user", "x-valet-session-id": sessionId, "x-valet-org-id": "local-org" },
    body: content === undefined ? undefined : JSON.stringify({ path, content }),
  });
  expect((await request(first.sessionId, "notes/shared.md", "Team onboarding instructions")).status).toBe(200);
  expect(await (await request(second.sessionId, "notes/shared.md")).json())
    .toMatchObject({ rendered: expect.stringContaining("Team onboarding instructions") });
  const browserPath = `${api.baseUrl}/api/memory?ownerType=team&ownerId=${team.id}&path=notes/shared.md`;
  expect((await fetch(browserPath, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(200);
  p.engineHost.evictCache(second.sessionId);
  const restored = await open("web:two", "test-member");
  expect(await (await request(restored.sessionId, "notes/shared.md")).json())
    .toMatchObject({ rendered: expect.stringContaining("Team onboarding instructions") });

  const thread = await alice.session.ensureDefaultThread();
  await p.db.insert(workflowDefinitions).values({ id: "memory-continuity", orgId: "local-org", ownerType: "team", ownerId: team.id,
    name: "Continuity", definition: {}, createdAt: 1, updatedAt: 1 });
  const deps = buildWorkflowEngineDeps({ host: p.engineHost, store: p.workflowStore, db: p.db,
    engineStore: p.engineStore, actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials });
  for (const [id, channel] of [["thread-first", undefined], ["thread-again", undefined], ["slack-thread-first", "D_ALICE"], ["slack-thread-again", "D_ALICE"]]) {
    if (!id) throw new Error("Missing fixture run ID");
    await p.workflowStore.createRun(id, { workflowId: "memory-continuity", definitionVersionId: "v",
      ...(channel ? { input: { type: "event" as const, data: { key: "slack.message", refs: { channel } } } } : {}) },
      { version: "dag/v1", nodes: [], edges: [] }, "v", { ownerType: "team", ownerId: team.id });
    const receipt = await deps.promptOrchestrator("Inspect memory", { dispatchId: `workflow:${id}:step`,
      queueMode: "followup", ownerHint: { ownerType: "team", ownerId: team.id } });
    const path = channel ? "notes/channel-step.md" : "notes/shared-step.md";
    if (id.endsWith("first")) {
      expect((await request(receipt.sessionId, path, "Persisted thread node memory")).status).toBe(200);
    } else {
      expect(await (await request(receipt.sessionId, path)).json())
        .toMatchObject({ rendered: expect.stringContaining("Persisted thread node memory") });
    }
    expect(await (await request(`wf:${id}:another`, path)).json())
      .toMatchObject({ rendered: expect.stringContaining("Persisted thread node memory") });
  }
  const root = await ensureDefaultAssistantSession(p, owner, { orgId: "local-org", actorUserId: "local-user" });
  const legacyThread = await root.session.createThread("workflow:memory-continuity:local-user");
  await p.workflowStore.createRun("legacy-origin", { workflowId: "memory-continuity", definitionVersionId: "v",
    origin: { assistantSessionId: root.sessionId, threadId: legacyThread.id } },
    { version: "dag/v1", nodes: [], edges: [] }, "v", { ownerType: "team", ownerId: team.id });
  expect(await p.db.select().from(assistantExecutions).where(eq(assistantExecutions.governingThreadId, legacyThread.id))).toEqual([]);
  expect((await request("wf:legacy-origin:session-step", "notes/legacy-origin.md", "Must not strand memory")).status).toBe(404);
  await deps.createSession({ id: "wf:legacy-origin:session-step", purpose: "workflow" });
  expect(await p.db.select().from(assistantExecutions).where(eq(assistantExecutions.governingThreadId, legacyThread.id))).toHaveLength(1);
  expect((await request("wf:legacy-origin:session-step", "notes/legacy-origin.md", "Shared by both step types")).status).toBe(200);
  const legacyReceipt = await deps.promptOrchestrator("Continue the legacy workflow", { dispatchId: "workflow:legacy-origin:thread-step",
    queueMode: "followup", ownerHint: { ownerType: "team", ownerId: team.id } });
  expect(await (await request(legacyReceipt.sessionId, "notes/legacy-origin.md")).json())
    .toMatchObject({ rendered: expect.stringContaining("Shared by both step types") });
  expect(await (await request("wf:legacy-origin:session-step", "notes/legacy-origin.md")).json())
    .toMatchObject({ rendered: expect.stringContaining("Shared by both step types") });
  for (const id of ["private-first", "private-again"]) {
    await p.db.insert(workflowRuns).values({ id, workflowId: "memory-continuity", definitionVersionId: "v", definition: {},
      params: { origin: { assistantSessionId: alice.sessionId, threadId: thread.id } },
      ownerType: "team", ownerId: team.id, createdAt: 1, updatedAt: 1 });
  }
  expect((await request("wf:private-first:step", "notes/private.md", "Private hiring plan")).status).toBe(200);
  expect(await (await request("wf:private-again:next", "notes/private.md")).json())
    .toMatchObject({ rendered: expect.stringContaining("Private hiring plan") });
  expect((await request(alice.sessionId, "notes/private.md")).status).toBe(200);
  expect((await request(bob.sessionId, "notes/private.md")).status).toBe(404);
  expect((await request(first.sessionId, "notes/private.md")).status).toBe(404);
  expect((await fetch(`${api.baseUrl}/api/memory/search?ownerType=team&ownerId=${team.id}&q=hiring`)).status).toBe(200);
  expect(await (await fetch(`${api.baseUrl}/api/memory/search?ownerType=team&ownerId=${team.id}&q=hiring`)).json()).toMatchObject({ results: [] });

  for (const [id, channel] of [["event-first", "D_ALICE"], ["event-again", "D_ALICE"], ["event-bob", "D_BOB"]]) {
    await p.db.insert(workflowRuns).values({ id, workflowId: "memory-continuity", definitionVersionId: "v", definition: {},
      params: { input: { type: "event", data: { key: "slack.message", refs: { channel } } } },
      ownerType: "team", ownerId: team.id, createdAt: 1, updatedAt: 1 });
  }
  expect((await request("wf:event-first:step", "notes/dm.md", "Private Slack context")).status).toBe(200);
  expect(await (await request("wf:event-again:step", "notes/dm.md")).json())
    .toMatchObject({ rendered: expect.stringContaining("Private Slack context") });
  expect((await request("wf:event-bob:step", "notes/dm.md")).status).toBe(404);
  expect((await request(first.sessionId, "notes/dm.md")).status).toBe(404);
  const bobThread = await bob.session.ensureDefaultThread();
  for (const [id, sessionId, threadId] of [["mixed-alice", alice.sessionId, thread.id], ["mixed-bob", bob.sessionId, bobThread.id]]) {
    await p.db.insert(workflowRuns).values({ id, workflowId: "memory-continuity", definitionVersionId: "v", definition: {},
      params: { workflowId: "memory-continuity", origin: { assistantSessionId: sessionId, threadId },
        input: { type: "event", data: { key: "slack.message", refs: { channel: "D_SHARED" } } } },
      ownerType: "team", ownerId: team.id, createdAt: 1, updatedAt: 1 });
  }
  await expect(deps.promptOrchestrator("Channel-private input", { dispatchId: "workflow:mixed-alice:thread-step",
    queueMode: "followup", ownerHint: { ownerType: "team", ownerId: team.id } })).rejects.toThrow("separate origin conversation");
  expect((await request("wf:mixed-alice:step", "notes/mixed.md", "Narrower than channel")).status).toBe(200);
  expect((await request("wf:mixed-bob:step", "notes/mixed.md")).status).toBe(404);
  await p.db.update(agentSessions).set({ status: "deleted" }).where(eq(agentSessions.id, alice.sessionId));
  expect((await request("wf:private-again:step", "notes/private.md")).status).toBe(404);
  await p.db.delete(teamMembers).where(eq(teamMembers.userId, "test-member"));
  expect((await fetch(browserPath, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(404);
});
