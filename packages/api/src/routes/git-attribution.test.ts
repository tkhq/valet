import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, teamMembers, teams } from "../schema/index.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

async function seedSession(id: string, ownerType: "user" | "team" | "org", ownerId: string, userId: string) {
  await api!.providers.db.insert(agentSessions).values({ id, userId, orgId: "local-org", workspace: `/tmp/${id}`, status: "active", ownerType, ownerId, createdAt: Date.now(), updatedAt: Date.now() });
}

function get(id: string, userId = "local-user") {
  return fetch(`${api!.baseUrl}/api/sessions/${id}/git-attribution`, { headers: { "x-valet-test-user-id": userId } });
}

function apply(id: string, userId = "local-user") {
  return fetch(`${api!.baseUrl}/api/sessions/${id}/git-attribution/apply`, { method: "POST", headers: { "x-valet-test-user-id": userId } });
}

describe("session Git attribution authorization", () => {
  it("limits personal and org-owned rows to their canonical direct owner", async () => {
    api = await bootTestApi();
    await seedSession("git-personal", "user", "test-member", "test-member");
    await seedSession("git-org", "org", "local-org", "test-member");
    expect((await get("git-personal")).status).toBe(404);
    expect((await apply("git-personal")).status).toBe(404);
    expect((await get("git-org")).status).toBe(404);
    expect((await get("git-personal", "test-member")).status).toBe(200);
  });

  it("lets team members view but only team admins apply settings", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(teams).values({ id: "git-team", orgId: "local-org", name: "Git team", origin: "local", externalId: null, createdAt: Date.now() });
    await api.providers.db.insert(teamMembers).values([
      { teamId: "git-team", userId: "local-user", role: "admin" },
      { teamId: "git-team", userId: "test-member", role: "member" },
    ]);
    await seedSession("git-team-session", "team", "git-team", "local-user");
    expect((await get("git-team-session", "test-member")).status).toBe(200);
    expect((await apply("git-team-session", "test-member")).status).toBe(404);
    expect((await apply("git-team-session")).status).toBe(200);
  });
});
