import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, teamMembers, teams, workflowDefinitions } from "../schema/index.js";
import { ensureWorkflowSession } from "../workflows/engine-deps.js";
import { getWorkflowRunDetail } from "../workflows/service.js";
import type { ListNotificationDecisionsResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

async function pendingGate(a: TestApi, sessionId: string, ownerType: "user" | "team", ownerId: string, userId: string) {
  await a.providers.db.insert(agentSessions).values({ id: sessionId, userId, orgId: "local-org", workspace: "/",
    ownerType, ownerId, createdAt: 1, updatedAt: 1 });
  await a.providers.engineStore.saveDecisionGate(sessionId, "t", {
    id: `gate-${sessionId}`, sessionId, threadId: "t", queueItemId: "q", resumeKey: `rk-${sessionId}`, ordinal: 0,
    type: "approval", title: "Approve?", actions: [{ id: "approve", label: "Approve" }], status: "pending", createdAt: 1, updatedAt: 1,
  });
}

it("lists pending gates from the caller's own and team sessions only", async () => {
  api = await bootTestApi();
  await api.providers.db.insert(teams).values([
    { id: "mine", orgId: "local-org", name: "Mine", createdAt: 1 },
    { id: "theirs", orgId: "local-org", name: "Theirs", createdAt: 1 },
  ]);
  await api.providers.db.insert(teamMembers).values({ teamId: "mine", userId: "local-user", role: "member" });
  await pendingGate(api, "own", "user", "local-user", "local-user");
  await pendingGate(api, "team-mine", "team", "mine", "someone");
  await pendingGate(api, "team-theirs", "team", "theirs", "someone");
  await pendingGate(api, "other-user", "user", "someone", "someone");

  const body = await (await fetch(`${api.baseUrl}/api/notifications/decisions`)).json() as ListNotificationDecisionsResponse;
  expect(body.items.map((item) => item.sessionId).sort()).toEqual(["own", "team-mine"]);
});

it("keeps another member's helper-thread approvals out of the inbox, and the viewer's own in", async () => {
  api = await bootTestApi();
  await api.providers.db.insert(teams).values({ id: "mine", orgId: "local-org", name: "Mine", createdAt: 1 });
  await api.providers.db.insert(teamMembers).values([
    { teamId: "mine", userId: "local-user", role: "member" },
    { teamId: "mine", userId: "test-member", role: "member" },
  ]);
  const open = async (asUser?: string) => await (await fetch(`${api!.baseUrl}/api/workspaces/mine/conversation`, {
    method: "POST", headers: asUser ? { "x-valet-test-user-id": asUser } : {},
  })).json() as { sessionId: string; threadId: string };
  const theirs = await open("test-member");
  const own = await open();
  for (const [thread, id] of [[theirs, "gate-theirs"], [own, "gate-own"]] as const) {
    await api.providers.engineStore.saveDecisionGate(thread.sessionId, thread.threadId, {
      id, sessionId: thread.sessionId, threadId: thread.threadId, queueItemId: `q-${id}`, resumeKey: `rk-${id}`, ordinal: 0,
      type: "approval", title: "Approve?", actions: [{ id: "approve", label: "Approve" }], status: "pending", createdAt: 1, updatedAt: 1,
    });
  }
  const body = await (await fetch(`${api.baseUrl}/api/notifications/decisions`)).json() as ListNotificationDecisionsResponse;
  expect(body.items.map((item) => item.gate.id)).toEqual(["gate-own"]);
});

it("keeps a team workflow's approvals with the private thread that started the run", async () => {
  api = await bootTestApi();
  const p = api.providers;
  await p.db.insert(teams).values({ id: "mine", orgId: "local-org", name: "Mine", createdAt: 1 });
  await p.db.insert(teamMembers).values([
    { teamId: "mine", userId: "local-user", role: "member" },
    { teamId: "mine", userId: "test-member", role: "member" },
  ]);
  await p.db.insert(workflowDefinitions).values({ id: "wf-private", orgId: "local-org", ownerType: "team", ownerId: "mine", name: "Private", definition: {}, createdAt: 1, updatedAt: 1 });
  const open = async (asUser?: string) => await (await fetch(`${api!.baseUrl}/api/workspaces/mine/conversation`, {
    method: "POST", headers: asUser ? { "x-valet-test-user-id": asUser } : {},
  })).json() as { sessionId: string; threadId: string };
  const gateFor = async (runId: string, origin: { sessionId: string; threadId: string }) => {
    await p.workflowStore.createRun(runId, { workflowId: "wf-private", definitionVersionId: "v1", origin: { assistantSessionId: origin.sessionId, threadId: origin.threadId } },
      { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "team", ownerId: "mine" });
    const sessionId = `wf:${runId}:triage`;
    const session = await ensureWorkflowSession({ db: p.db, store: p.workflowStore, engineStore: p.engineStore,
      host: p.engineHost, actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials }, sessionId);
    const threadId = session.thread().id;
    await p.engineStore.saveDecisionGate(sessionId, threadId, {
      id: `gate-${runId}`, sessionId, threadId, queueItemId: "q", resumeKey: "rk", ordinal: 0,
      type: "approval", title: "Approve?", actions: [{ id: "approve", label: "Approve" }], status: "pending", createdAt: 1, updatedAt: 1,
    });
    return { base: `${api!.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/decisions`, thread: `${api!.baseUrl}/api/threads/${threadId}/decisions` };
  };
  const theirs = await gateFor("run-theirs", await open("test-member"));
  const own = await gateFor("run-own", await open());

  const inbox = await (await fetch(`${api.baseUrl}/api/notifications/decisions`)).json() as ListNotificationDecisionsResponse;
  expect(inbox.items.map((item) => item.gate.id)).toEqual(["gate-run-own"]);
  const json = { "Content-Type": "application/json" };
  expect((await fetch(theirs.base)).status).toBe(404);
  expect((await fetch(theirs.thread)).status).toBe(404);
  expect((await fetch(`${theirs.base}/gate-run-theirs/resolve`, { method: "POST", headers: json, body: JSON.stringify({ actionId: "approve" }) })).status).toBe(404);
  expect((await fetch(own.base)).status).toBe(200);
  // The member who started the run still answers it.
  expect((await fetch(theirs.base, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(200);
  // The run record carries the private thread's input, so it follows the same rule.
  expect((await fetch(`${api.baseUrl}/api/workflows/runs/run-theirs`)).status).toBe(404);
  expect((await fetch(`${api.baseUrl}/api/workflows/runs/run-theirs`, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(200);
  expect((await fetch(`${api.baseUrl}/api/workflows/runs/run-own`)).status).toBe(200);
  // A member acting through the team assistant's tools is that member
  // (`ownerFromContext`); the team's own key sees only what the team shares.
  const deps = { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore };
  const asTool = (userId: string) => ({ userId, orgId: "local-org", principal: { type: "team" as const, id: "mine" }, requireTeamMembership: true });
  expect(await getWorkflowRunDetail(deps, asTool("test-member"), "run-theirs")).not.toBeNull();
  expect(await getWorkflowRunDetail(deps, asTool("local-user"), "run-theirs")).toBeNull();
  expect(await getWorkflowRunDetail(deps, { userId: "team:mine", orgId: "local-org", principal: { type: "team", id: "mine" } }, "run-theirs")).toBeNull();
});
