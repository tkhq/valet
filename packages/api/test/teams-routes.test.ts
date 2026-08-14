/**
 * Teams routes — GET/POST /api/teams, DELETE /api/teams/:id,
 * POST/PATCH/DELETE /api/teams/:id/members[/:userId].
 *
 * Drives a real `createApp` (via bootTestApi) over HTTP, exercising the
 * route layer's org-membership gating and error-code mapping on top of the
 * already-unit-tested service.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../src/integration/_setup.js";
import { teamMembers, teams } from "../src/schema/index.js";
import type { CreateTeamResponse, ListTeamMembersResponse, ListTeamsResponse } from "../src/wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };
const ADMIN_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-admin" };

let api: TestApi;

afterEach(async () => {
  await api?.cleanup();
});

async function createTeam(baseUrl: string, name: string, headers = HEADERS) {
  const res = await fetch(`${baseUrl}/api/teams`, { method: "POST", headers, body: JSON.stringify({ name }) });
  return res;
}

describe("teams routes", () => {
  it("creates a team with the caller auto-admitted, then lists it", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    const createRes = await createTeam(baseUrl, "Platform");
    expect(createRes.status).toBe(201);
    const { team } = (await createRes.json()) as CreateTeamResponse;
    expect(team.name).toBe("Platform");

    const listRes = await fetch(`${baseUrl}/api/teams`, { headers: HEADERS });
    expect(listRes.status).toBe(200);
    const { teams } = (await listRes.json()) as ListTeamsResponse;
    expect(teams.map((t) => t.id)).toContain(team.id);
  });

  it("rejects a duplicate team name in the same org with 409", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    expect((await createTeam(baseUrl, "Platform")).status).toBe(201);
    const dupe = await createTeam(baseUrl, "Platform");
    expect(dupe.status).toBe(409);
    const body = (await dupe.json()) as { code?: string };
    expect(body.code).toBe("team_name_conflict");
  });

  it("adds a member and lets that member see the team", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    const createRes = await createTeam(baseUrl, "Platform");
    const { team } = (await createRes.json()) as CreateTeamResponse;

    const addRes = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ userId: "test-member", role: "member" }),
    });
    expect(addRes.status).toBe(201);

    const listRes = await fetch(`${baseUrl}/api/teams`, { headers: MEMBER_HEADERS });
    const { teams } = (await listRes.json()) as ListTeamsResponse;
    expect(teams.map((t) => t.id)).toContain(team.id);
  });

  it("rejects demoting/removing the last admin with 409", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    const createRes = await createTeam(baseUrl, "Platform");
    const { team } = (await createRes.json()) as CreateTeamResponse;

    const demote = await fetch(`${baseUrl}/api/teams/${team.id}/members/local-user`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ role: "member" }),
    });
    expect(demote.status).toBe(409);
    const demoteBody = (await demote.json()) as { code?: string };
    expect(demoteBody.code).toBe("last_admin");

    const remove = await fetch(`${baseUrl}/api/teams/${team.id}/members/local-user`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(remove.status).toBe(409);
  });

  it("deletes a team", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    const createRes = await createTeam(baseUrl, "Platform");
    const { team } = (await createRes.json()) as CreateTeamResponse;

    const delRes = await fetch(`${baseUrl}/api/teams/${team.id}`, { method: "DELETE", headers: HEADERS });
    expect(delRes.status).toBe(200);

    const listRes = await fetch(`${baseUrl}/api/teams`, { headers: HEADERS });
    const { teams } = (await listRes.json()) as ListTeamsResponse;
    expect(teams.map((t) => t.id)).not.toContain(team.id);
  });

  it("404s on a team id that doesn't exist (or belongs to another org)", async () => {
    api = await bootTestApi();
    const { baseUrl } = api;

    const res = await fetch(`${baseUrl}/api/teams/does-not-exist`, { method: "DELETE", headers: HEADERS });
    expect(res.status).toBe(404);
  });

  describe("mutation authorization", () => {
    it("a non-admin team member cannot add/set-role/remove members or delete the team (404)", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // local-user creates the team (auto-admitted admin) and adds
      // test-member as a plain member.
      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;
      await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });

      // test-member (non-admin on this team) tries every mutation route.
      const addRes = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ userId: "test-admin", role: "member" }),
      });
      expect(addRes.status).toBe(404);

      const setRoleRes = await fetch(`${baseUrl}/api/teams/${team.id}/members/test-member`, {
        method: "PATCH",
        headers: MEMBER_HEADERS,
        body: JSON.stringify({ role: "admin" }),
      });
      expect(setRoleRes.status).toBe(404);

      const removeRes = await fetch(`${baseUrl}/api/teams/${team.id}/members/local-user`, {
        method: "DELETE",
        headers: MEMBER_HEADERS,
      });
      expect(removeRes.status).toBe(404);

      const deleteRes = await fetch(`${baseUrl}/api/teams/${team.id}`, {
        method: "DELETE",
        headers: MEMBER_HEADERS,
      });
      expect(deleteRes.status).toBe(404);
    });

    it("a team admin can add members and delete the team", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // local-user is the creator, hence a team admin.
      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      const addRes = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });
      expect(addRes.status).toBe(201);

      const deleteRes = await fetch(`${baseUrl}/api/teams/${team.id}`, { method: "DELETE", headers: HEADERS });
      expect(deleteRes.status).toBe(200);
    });

    it("an org admin can mutate a team they aren't a member of", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // local-user creates the team; test-admin is an org admin but not on
      // the team at all — the deliberate recovery path.
      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      const addRes = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: ADMIN_HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });
      expect(addRes.status).toBe(201);

      const deleteRes = await fetch(`${baseUrl}/api/teams/${team.id}`, { method: "DELETE", headers: ADMIN_HEADERS });
      expect(deleteRes.status).toBe(200);
    });

    it("a non-member org user gets 404, not 403, on a team mutation", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      // test-member is a plain org member, not on this team at all.
      const res = await fetch(`${baseUrl}/api/teams/${team.id}`, { method: "DELETE", headers: MEMBER_HEADERS });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /:id/members authorization", () => {
    // Note: this harness always runs with VALET_LOCAL_AUTH=1, so every
    // request resolves to a concrete `AuthUser` (local-user by default, or
    // whoever `x-valet-test-user-id` impersonates) — there is no route path
    // that produces a real 401 here. Unauthenticated access is covered by
    // `authMiddleware`'s own gate on `VALET_LOCAL_AUTH`, not by this suite.

    it("a team member can view the roster", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;
      await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });

      const res = await fetch(`${baseUrl}/api/teams/${team.id}/members`, { headers: MEMBER_HEADERS });
      expect(res.status).toBe(200);
      const { members } = (await res.json()) as ListTeamMembersResponse;
      expect(members.map((m) => m.userId).sort()).toEqual(["local-user", "test-member"]);
    });

    it("an org admin who isn't on the team can still view the roster", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      const res = await fetch(`${baseUrl}/api/teams/${team.id}/members`, { headers: ADMIN_HEADERS });
      expect(res.status).toBe(200);
      const { members } = (await res.json()) as ListTeamMembersResponse;
      expect(members.map((m) => m.userId)).toEqual(["local-user"]);
    });

    it("a plain org member who isn't on the team gets 404, not the roster", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // local-user creates the team; test-member is a plain org member
      // (not an org admin) and is never added to this team.
      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      const res = await fetch(`${baseUrl}/api/teams/${team.id}/members`, { headers: MEMBER_HEADERS });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { members?: unknown };
      expect(body.members).toBeUndefined();
    });

    it("404s on a nonexistent team id", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const res = await fetch(`${baseUrl}/api/teams/does-not-exist/members`, { headers: HEADERS });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /teams admin-vs-member scoping", () => {
    it("an org admin sees every team in the org, including ones they aren't a member of", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // local-user creates two teams; test-admin (org admin) is never added
      // to either.
      const platform = (await (await createTeam(baseUrl, "Platform")).json()) as CreateTeamResponse;
      const growth = (await (await createTeam(baseUrl, "Growth")).json()) as CreateTeamResponse;

      const res = await fetch(`${baseUrl}/api/teams`, { headers: ADMIN_HEADERS });
      expect(res.status).toBe(200);
      const { teams } = (await res.json()) as ListTeamsResponse;
      const ids = teams.map((t) => t.id);
      expect(ids).toContain(platform.team.id);
      expect(ids).toContain(growth.team.id);
    });

    it("a plain member sees only the teams they belong to", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      // test-member is added to Platform only; Growth stays out of reach.
      const platform = (await (await createTeam(baseUrl, "Platform")).json()) as CreateTeamResponse;
      const growth = (await (await createTeam(baseUrl, "Growth")).json()) as CreateTeamResponse;
      await fetch(`${baseUrl}/api/teams/${platform.team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });

      const res = await fetch(`${baseUrl}/api/teams`, { headers: MEMBER_HEADERS });
      expect(res.status).toBe(200);
      const { teams } = (await res.json()) as ListTeamsResponse;
      const ids = teams.map((t) => t.id);
      expect(ids).toContain(platform.team.id);
      expect(ids).not.toContain(growth.team.id);
    });

    it("memberCount reflects the actual roster size on the JSON boundary", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      let listRes = await fetch(`${baseUrl}/api/teams`, { headers: HEADERS });
      let { teams } = (await listRes.json()) as ListTeamsResponse;
      expect(teams.find((t) => t.id === team.id)?.memberCount).toBe(1);

      await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });

      listRes = await fetch(`${baseUrl}/api/teams`, { headers: HEADERS });
      ({ teams } = (await listRes.json()) as ListTeamsResponse);
      expect(teams.find((t) => t.id === team.id)?.memberCount).toBe(2);
    });
  });

  describe("identity-provider-managed teams", () => {
    /**
     * Seeds a team the way the login-time sync does: a direct insert with
     * `origin: "idp"` and the full group path, and member rows written
     * straight to the table. `createTeam` cannot make one — it always writes
     * `local` — which is the point.
     */
    async function seedIdpTeam(name: string, externalId: string): Promise<string> {
      const id = `team_idp_${name}`;
      const { db } = api.providers;
      await db.insert(teams).values({
        id,
        orgId: "local-org",
        name,
        origin: "idp",
        externalId,
        createdAt: Date.now(),
      });
      // local-user is a team admin here, so every refusal below is reached
      // through the authz gate rather than short-circuited by it.
      await db.insert(teamMembers).values({ teamId: id, userId: "local-user", role: "admin" });
      return id;
    }

    it("refuses add-member with 409 and names the group to change", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;
      const teamId = await seedIdpTeam("platform", "/platform");

      const res = await fetch(`${baseUrl}/api/teams/${teamId}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; code?: string };
      expect(body.code).toBe("team_idp_managed");
      // The corrective action must name the actual group, not "your IdP".
      expect(body.error).toContain("/platform");
      expect(body.error).toContain("identity provider");

      // The refusal wrote nothing.
      const members = await fetch(`${baseUrl}/api/teams/${teamId}/members`, { headers: HEADERS });
      const { members: rows } = (await members.json()) as ListTeamMembersResponse;
      expect(rows.map((m) => m.userId)).toEqual(["local-user"]);
    });

    it("refuses a role change with 409 and leaves the role alone", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;
      const teamId = await seedIdpTeam("platform", "/platform");

      const res = await fetch(`${baseUrl}/api/teams/${teamId}/members/local-user`, {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ role: "member" }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code?: string }).code).toBe("team_idp_managed");

      const members = await fetch(`${baseUrl}/api/teams/${teamId}/members`, { headers: HEADERS });
      const { members: rows } = (await members.json()) as ListTeamMembersResponse;
      expect(rows).toEqual([{ userId: "local-user", role: "admin" }]);
    });

    it("refuses remove-member with 409 and keeps the member", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;
      const teamId = await seedIdpTeam("platform", "/platform");
      await api.providers.db
        .insert(teamMembers)
        .values({ teamId, userId: "test-member", role: "member" });

      const res = await fetch(`${baseUrl}/api/teams/${teamId}/members/test-member`, {
        method: "DELETE",
        headers: HEADERS,
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code?: string }).code).toBe("team_idp_managed");

      const members = await fetch(`${baseUrl}/api/teams/${teamId}/members`, { headers: HEADERS });
      const { members: rows } = (await members.json()) as ListTeamMembersResponse;
      expect(rows.map((m) => m.userId).sort()).toEqual(["local-user", "test-member"]);
    });

    it("refuses delete with 409 and the team survives", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;
      const teamId = await seedIdpTeam("platform", "/platform");

      const res = await fetch(`${baseUrl}/api/teams/${teamId}`, { method: "DELETE", headers: HEADERS });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; code?: string };
      expect(body.code).toBe("team_idp_managed");
      expect(body.error).toContain("/platform");

      const listRes = await fetch(`${baseUrl}/api/teams`, { headers: HEADERS });
      const { teams: rows } = (await listRes.json()) as ListTeamsResponse;
      expect(rows.map((t) => t.id)).toContain(teamId);
    });

    it("an org admin is refused too — the gate is the team's origin, not the caller's role", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;
      const teamId = await seedIdpTeam("platform", "/platform");

      // test-admin is an org admin, the widest recovery path this router has.
      const res = await fetch(`${baseUrl}/api/teams/${teamId}`, { method: "DELETE", headers: ADMIN_HEADERS });
      expect(res.status).toBe(409);
    });

    it("an unauthorized caller still gets 404, not 409 — the refusal must not leak existence", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;
      const teamId = await seedIdpTeam("platform", "/platform");

      // test-member is a plain org member and is not on this team. The authz
      // gate runs first, so they learn nothing about the team at all — a 409
      // here would confirm it exists.
      const res = await fetch(`${baseUrl}/api/teams/${teamId}`, { method: "DELETE", headers: MEMBER_HEADERS });
      expect(res.status).toBe(404);
    });

    it("puts origin and externalId on the wire for both kinds of team", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;
      await seedIdpTeam("platform", "/platform");
      await createTeam(baseUrl, "Growth");

      const listRes = await fetch(`${baseUrl}/api/teams`, { headers: HEADERS });
      const { teams: rows } = (await listRes.json()) as ListTeamsResponse;

      const mirrored = rows.find((t) => t.name === "platform");
      expect(mirrored?.origin).toBe("idp");
      expect(mirrored?.externalId).toBe("/platform");

      const own = rows.find((t) => t.name === "Growth");
      expect(own?.origin).toBe("local");
      expect(own?.externalId).toBeNull();
    });

    it("a local team beside a mirrored one keeps every mutation", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;
      await seedIdpTeam("platform", "/platform");
      const { team } = (await (await createTeam(baseUrl, "Growth")).json()) as CreateTeamResponse;

      const add = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "test-member", role: "member" }),
      });
      expect(add.status).toBe(201);

      const setRole = await fetch(`${baseUrl}/api/teams/${team.id}/members/test-member`, {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ role: "admin" }),
      });
      expect(setRole.status).toBe(200);

      const remove = await fetch(`${baseUrl}/api/teams/${team.id}/members/test-member`, {
        method: "DELETE",
        headers: HEADERS,
      });
      expect(remove.status).toBe(200);

      const del = await fetch(`${baseUrl}/api/teams/${team.id}`, { method: "DELETE", headers: HEADERS });
      expect(del.status).toBe(200);
    });

    it("has no rename route to leave unguarded", async () => {
      // A tripwire, not a behaviour test. Renaming a mirrored team would put
      // the row's name out of step with the group it mirrors, and the next
      // sync would find the group by `external_id` and keep the stale name.
      // There is no rename route today, so there is nothing to guard.
      //
      // If you add `PATCH /api/teams/:id`, this test fails. Replace it with
      // one that proves the rename refuses on an `idp` team, exactly as the
      // four mutations above do.
      api = await bootTestApi();
      const { baseUrl } = api;
      const teamId = await seedIdpTeam("platform", "/platform");

      const res = await fetch(`${baseUrl}/api/teams/${teamId}`, {
        method: "PATCH",
        headers: HEADERS,
        body: JSON.stringify({ name: "renamed" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("addMember target validation", () => {
    it("rejects an unknown userId with 404", async () => {
      api = await bootTestApi();
      const { baseUrl } = api;

      const createRes = await createTeam(baseUrl, "Platform");
      const { team } = (await createRes.json()) as CreateTeamResponse;

      const res = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ userId: "no-such-user", role: "member" }),
      });
      expect(res.status).toBe(404);
    });
  });
});
