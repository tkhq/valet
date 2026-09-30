import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { teams, teamMembers } from "../schema/index.js";
let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
describe("workspace runtime authorization", () => {
  it("ensures personal runtime idempotently and answers the entry points older clients call", async () => {
    api = await bootTestApi();
    const root = `${api.baseUrl}/api/workspaces/user/runtime`;
    // The probe never creates a runtime.
    expect(await (await fetch(`${api.baseUrl}/api/orchestrator`)).json()).toEqual({ sessionId: null, exists: false });
    const first = await (await fetch(root, { method: "POST" })).json() as { sessionId: string };
    expect(await (await fetch(root, { method: "POST" })).json()).toEqual(first);
    expect(await (await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" })).json()).toEqual(first);
    expect(await (await fetch(`${api.baseUrl}/api/orchestrator`)).json()).toEqual({ sessionId: first.sessionId, exists: true });
    expect((await fetch(`${api.baseUrl}/api/teams/unknown/orchestrator`, { method: "POST" })).status).toBe(404);
  });
  it("answers a team runtime on the older team path for a member", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(teams).values({ id: "legacy-team", orgId: "local-org", name: "Legacy", createdAt: 1 });
    await api.providers.db.insert(teamMembers).values({ teamId: "legacy-team", userId: "local-user", role: "member" });
    const legacy = await (await fetch(`${api.baseUrl}/api/teams/legacy-team/orchestrator`, { method: "POST" })).json();
    expect(legacy).toEqual(await (await fetch(`${api.baseUrl}/api/workspaces/legacy-team/runtime`, { method: "POST" })).json());
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
