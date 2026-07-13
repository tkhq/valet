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
import type { CreateTeamResponse, ListTeamsResponse } from "../src/wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

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
});
