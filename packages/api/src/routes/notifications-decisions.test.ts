import { afterEach, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, teamMembers, teams } from "../schema/index.js";
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
