import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { addMember, createTeam, removeMember } from "../services/teams.js";
import { apikey, credentials, notifications, orgMembers, orgs, skills, teamDeletionRequests, teams, users, workflowDefinitions, workflowRuns } from "../schema/index.js";

let api: TestApi;
let teamId: string;
let seq = 0;
const member = "test-member";
const admin = "local-user";
async function call(path: string, method = "GET", body?: unknown, actor = member) {
  return fetch(`${api.baseUrl}/api${path}`, { method, headers: { "content-type": "application/json", "x-valet-test-user-id": actor }, body: body === undefined ? undefined : JSON.stringify(body) });
}
function requests() { return `/teams/${teamId}/deletion-requests`; }
async function resource(kind: "skill" | "workflow", ownerType: "user" | "team" = "team", origin: "local" | "repo" = "local") {
  const id = `delete_test_${++seq}`;
  const common = { id, orgId: "local-org", ownerType, ownerId: ownerType === "team" ? teamId : member, origin, name: id, createdAt: Date.now(), updatedAt: Date.now() };
  if (kind === "skill") await api.providers.db.insert(skills).values({ ...common, description: "test", content: "test", contentSha: "test" });
  else await api.providers.db.insert(workflowDefinitions).values({ ...common, definition: {} });
  return id;
}
async function submit(resourceType: string, resourceId: string) {
  const response = await call(requests(), "POST", { resourceType, resourceId, reason: "No longer needed" });
  expect(response.status).toBe(201);
  const body = await response.json() as { request: { id: string }; created: boolean };
  return body.request.id;
}
beforeAll(async () => {
  api = await bootTestApi();
  teamId = (await createTeam(api.providers.db, { orgId: "local-org", name: "Deletion tests", creatorUserId: admin })).id;
  await addMember(api.providers.db, { teamId, userId: member, role: "member" });
  await api.providers.db.insert(users).values({ id: "outsider", name: "Outsider", email: "outsider@test", role: "member" });
  await api.providers.db.insert(orgMembers).values({ orgId: "local-org", userId: "outsider", role: "member" });
});
afterAll(async () => { await api?.cleanup(); });

describe("team deletion requests", () => {
  it.each(["workflow", "skill"] as const)("gates direct %s deletion, names an open request, and preserves personal deletion", async (kind) => {
    const id = await resource(kind);
    const path = kind === "skill" ? `/skills/stored/${id}` : `/workflows/${id}`;
    const refused = await call(path, "DELETE");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "team_admin_required", teamId });
    expect((await call(path, "DELETE", undefined, "outsider")).status).toBe(404);
    const requestId = await submit(kind, id);
    expect(await (await call(path, "DELETE")).json()).toMatchObject({ requestId });
    expect((await call(`${requests()}/${requestId}/approve`, "POST", {}, "test-admin")).status).toBe(200);
    const personal = await resource(kind, "user");
    expect((await call(kind === "skill" ? `/skills/stored/${personal}` : `/workflows/${personal}`, "DELETE")).status).toBe(200);
  });

  it("joins duplicate submissions and notifies only team admins once", async () => {
    const id = await resource("skill");
    const responses = await Promise.all([call(requests(), "POST", { resourceType: "skill", resourceId: id }), call(requests(), "POST", { resourceType: "skill", resourceId: id })]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const bodies = await Promise.all(responses.map((r) => r.json())) as { request: { id: string } }[];
    expect(bodies[0].request.id).toBe(bodies[1].request.id);
    const notices = await api.providers.db.select().from(notifications).where(eq(notifications.title, `Review deletion of ${id}`));
    expect(notices.map((n) => n.userId)).toEqual([admin]);
    expect(notices[0].kind).toBe("review");
    expect(notices[0].sessionId).toBeNull();
    expect((await call(`${requests()}/${bodies[0].request.id}/decline`, "POST", { note: "Keep it" }, admin)).status).toBe(200);
    const [notice] = await api.providers.db.select().from(notifications).where(eq(notifications.id, notices[0].id));
    expect(notice.readAt).not.toBeNull();
  });

  it("rejects permanent repository and managed-team refusals before creating requests", async () => {
    for (const kind of ["workflow", "skill"] as const) {
      const id = await resource(kind, "team", "repo");
      expect((await call(requests(), "POST", { resourceType: kind, resourceId: id })).status).toBe(409);
      expect(await api.providers.db.select().from(teamDeletionRequests).where(eq(teamDeletionRequests.resourceId, id))).toEqual([]);
    }
    await api.providers.db.update(teams).set({ origin: "config" }).where(eq(teams.id, teamId));
    expect((await call(requests(), "POST", { resourceType: "team", resourceId: teamId })).status).toBe(409);
    await api.providers.db.update(teams).set({ origin: "local" }).where(eq(teams.id, teamId));
  });

  it("keeps a temporarily refused approval pending and retries through the real delete", async () => {
    const id = await resource("workflow");
    const requestId = await submit("workflow", id);
    await api.providers.db.insert(workflowRuns).values({ id: `run_${id}`, workflowId: id, definitionVersionId: "v1", definition: {}, params: {}, status: "running", createdAt: Date.now(), updatedAt: Date.now() });
    const denied = await call(`${requests()}/${requestId}/approve`, "POST", {}, admin);
    expect(denied.status).toBe(409);
    const [row] = await api.providers.db.select().from(teamDeletionRequests).where(eq(teamDeletionRequests.id, requestId));
    expect(row.status).toBe("pending");
    expect(row.lastRefusal).toContain("Cancel them first");
    await api.providers.db.update(workflowRuns).set({ status: "settled" }).where(eq(workflowRuns.id, `run_${id}`));
    expect((await call(`${requests()}/${requestId}/approve`, "POST", {}, admin)).status).toBe(200);
    expect(await api.providers.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, id))).toEqual([]);
  });

  it("expires on read, refuses expired decisions, and permits a fresh submission", async () => {
    const id = await resource("skill");
    const old = await submit("skill", id);
    await api.providers.db.update(teamDeletionRequests).set({ expiresAt: Date.now() - 1 }).where(eq(teamDeletionRequests.id, old));
    const list = await (await call(requests())).json() as { requests: { id: string; status: string }[] };
    expect(list.requests.find((r) => r.id === old)?.status).toBe("expired");
    expect((await call(`${requests()}/${old}/approve`, "POST", {}, admin)).status).toBe(409);
    expect(await submit("skill", id)).not.toBe(old);
  });

  it("lets only the requester withdraw and serializes competing decisions", async () => {
    const id = await resource("skill");
    const requestId = await submit("skill", id);
    expect((await call(`${requests()}/${requestId}/withdraw`, "POST", {}, admin)).status).toBe(403);
    expect((await call(`${requests()}/${requestId}/approve`, "POST", {})).status).toBe(403);
    const responses = await Promise.all([call(`${requests()}/${requestId}/decline`, "POST", {}, admin), call(`${requests()}/${requestId}/approve`, "POST", {}, admin)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const another = await submit("skill", await resource("skill"));
    expect((await call(`${requests()}/${another}/withdraw`, "POST", {})).status).toBe(200);
  });

  it("retains a departed requester's request and lets the deciding admin delete", async () => {
    const requestId = await submit("skill", await resource("skill"));
    await removeMember(api.providers.db, { teamId, userId: member });
    const list = await (await call(requests(), "GET", undefined, admin)).json() as { requests: { id: string; requesterIsMember: boolean }[] };
    expect(list.requests.find((r) => r.id === requestId)?.requesterIsMember).toBe(false);
    expect((await call(`${requests()}/${requestId}/approve`, "POST", {}, admin)).status).toBe(200);
    await addMember(api.providers.db, { teamId, userId: member, role: "member" });
  });

  it("checks target tenancy and membership before revealing request state", async () => {
    const id = await resource("skill", "user");
    expect((await call(requests(), "POST", { resourceType: "skill", resourceId: id })).status).toBe(404);
    expect((await call(requests(), "GET", undefined, "outsider")).status).toBe(404);
    expect((await call(`${requests()}/targets`, "GET", undefined, "outsider")).status).toBe(404);
    await api.providers.db.insert(orgs).values({ id: "foreign", name: "Foreign", createdAt: Date.now() });
    const foreign = await createTeam(api.providers.db, { orgId: "foreign", name: "Other", creatorUserId: admin });
    expect((await call(`/teams/${foreign.id}/deletion-requests`, "POST", { resourceType: "team", resourceId: foreign.id }, admin)).status).toBe(404);
  });

  it("denies stale organization members even when their team membership remains", async () => {
    await api.providers.db.delete(orgMembers).where(and(eq(orgMembers.orgId, "local-org"), eq(orgMembers.userId, member)));
    try {
      expect((await call(requests())).status).toBe(404);
      expect((await call(`${requests()}/targets`)).status).toBe(404);
      expect((await call(requests(), "POST", { resourceType: "team", resourceId: teamId })).status).toBe(404);
      // A current org admin still has the recovery view without joining the team.
      expect((await call(requests(), "GET", undefined, "test-admin")).status).toBe(200);
    } finally {
      await api.providers.db.insert(orgMembers).values({ orgId: "local-org", userId: member, role: "member" });
    }
  });

  it("gates credentials and API keys and exposes no secret fields in targets", async () => {
    await api.providers.engineCredentials.save({ type: "team", id: teamId }, "linear", { type: "api_key", apiKey: "sentinel-do-not-expose" });
    const path = `/credentials/linear?scope=team&teamId=${teamId}`;
    expect((await call(path, "DELETE")).status).toBe(403);
    expect((await call(path, "DELETE", undefined, "outsider")).status).toBe(404);
    const now = new Date();
    await api.providers.db.insert(apikey).values({ id: "delete_key", teamId, name: "Test key", key: "sentinel-key-hash", referenceId: admin, createdAt: now, updatedAt: now });
    expect((await call(`/teams/${teamId}/api-keys/delete_key`, "DELETE")).status).toBe(403);
    const targets = await (await call(`${requests()}/targets`)).text();
    expect(targets).not.toContain("sentinel");
    for (const [kind, id] of [["credential", "linear"], ["api_key", "delete_key"]]) {
      const requestId = await submit(kind, id);
      expect((await call(`${requests()}/${requestId}/approve`, "POST", {}, admin)).status).toBe(200);
    }
  });

  it("retires every request notification when an admin deletes a team directly", async () => {
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Direct deletion", creatorUserId: admin });
    await addMember(api.providers.db, { teamId: team.id, userId: member, role: "member" });
    const response = await call(`/teams/${team.id}/deletion-requests`, "POST", { resourceType: "team", resourceId: team.id });
    expect(response.status).toBe(201);
    const href = `/settings/organization/teams?teamId=${team.id}`;
    const before = await api.providers.db.select().from(notifications).where(eq(notifications.href, href));
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((n) => n.readAt === null)).toBe(true);
    expect((await call(`/teams/${team.id}`, "DELETE", undefined, admin)).status).toBe(200);
    const after = await api.providers.db.select().from(notifications).where(eq(notifications.href, href));
    expect(after.every((n) => n.readAt !== null)).toBe(true);
  });

  it("deletes a team's requests with the team", async () => {
    await submit("skill", await resource("skill"));
    const requestId = await submit("team", teamId);
    const href = `/settings/organization/teams?teamId=${teamId}`;
    const before = await api.providers.db.select().from(notifications).where(eq(notifications.href, href));
    expect(before.filter((n) => n.readAt === null).length).toBeGreaterThanOrEqual(2);
    expect((await call(`/teams/${teamId}`, "DELETE")).status).toBe(403);
    expect((await call(`${requests()}/${requestId}/approve`, "POST", {}, admin)).status).toBe(200);
    expect(await api.providers.db.select().from(teamDeletionRequests).where(eq(teamDeletionRequests.teamId, teamId))).toEqual([]);
    expect(await api.providers.db.select().from(teams).where(eq(teams.id, teamId))).toEqual([]);
    const after = await api.providers.db.select().from(notifications).where(eq(notifications.href, href));
    expect(after.every((n) => n.readAt !== null)).toBe(true);
  });
});
