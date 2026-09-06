/**
 * Team 1Password grant routes. The grant is a lease of explicit `op://`
 * refs. Members may list it. Only a team admin (or org admin) may write it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { orgMembers, users } from "../schema/index.js";
import { addMember, createTeam } from "../services/teams.js";
import { ONEPASSWORD_SERVICE } from "../services/onepassword.js";
import type { TeamOnePasswordRefsResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };
const ADMIN_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-admin" };
const STRANGER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-stranger" };

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function teamWithMember() {
  api = await bootTestApi();
  const team = await createTeam(api.providers.db, {
    orgId: "local-org",
    name: "Platform",
    creatorUserId: "local-user",
  });
  await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
  return team;
}

describe("GET/PUT/DELETE /api/teams/:id/onepassword-refs", () => {
  it("lets an admin grant refs and a member list them", async () => {
    const team = await teamWithMember();
    const put = await fetch(`${api!.baseUrl}/api/teams/${team.id}/onepassword-refs`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ refs: ["op://Shared/Acme/credential"] }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ refs: ["op://Shared/Acme/credential"] });

    const listed = await fetch(`${api!.baseUrl}/api/teams/${team.id}/onepassword-refs`, {
      headers: MEMBER_HEADERS,
    });
    expect(listed.status).toBe(200);
    expect((await listed.json()) as TeamOnePasswordRefsResponse).toEqual({
      refs: ["op://Shared/Acme/credential"],
    });

    const creds = await fetch(`${api!.baseUrl}/api/credentials?scope=team&teamId=${team.id}`, {
      headers: MEMBER_HEADERS,
    });
    expect(creds.status).toBe(200);
    expect(await creds.json()).toEqual({ credentials: [] });
  });

  it("refuses a member PUT and a non-member GET with 404", async () => {
    const team = await teamWithMember();
    await api!.providers.db.insert(users).values({
      id: "test-stranger",
      email: "stranger@dev",
      name: "Stranger",
      role: "member",
    });
    await api!.providers.db.insert(orgMembers).values({
      orgId: "local-org",
      userId: "test-stranger",
      role: "member",
      createdAt: Date.now(),
    });
    const memberPut = await fetch(`${api!.baseUrl}/api/teams/${team.id}/onepassword-refs`, {
      method: "PUT",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ refs: ["op://Shared/Acme/credential"] }),
    });
    expect(memberPut.status).toBe(404);

    const stranger = await fetch(`${api!.baseUrl}/api/teams/${team.id}/onepassword-refs`, {
      headers: STRANGER_HEADERS,
    });
    expect(stranger.status).toBe(404);

    const orgAdmin = await fetch(`${api!.baseUrl}/api/teams/${team.id}/onepassword-refs`, {
      headers: ADMIN_HEADERS,
    });
    expect(orgAdmin.status).toBe(200);
  });

  it("refuses delegating the reserved onepassword service onto a team", async () => {
    const team = await teamWithMember();
    const del = await fetch(`${api!.baseUrl}/api/credentials/onepassword/delegate`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ teamId: team.id }),
    });
    expect(del.status).toBe(400);
    expect(((await del.json()) as { error: string }).error).toContain("onepassword-refs");
  });

  it("refuses a token write to the reserved service on team scope", async () => {
    const team = await teamWithMember();
    const put = await fetch(`${api!.baseUrl}/api/credentials/onepassword`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "service_account", apiKey: "ops_token", scope: "team", teamId: team.id }),
    });
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    expect(body.error).toContain("onepassword-refs");
  });

  it("DELETE drops the grant row", async () => {
    const team = await teamWithMember();
    await fetch(`${api!.baseUrl}/api/teams/${team.id}/onepassword-refs`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ refs: ["op://Shared/Acme/credential"] }),
    });
    const del = await fetch(`${api!.baseUrl}/api/teams/${team.id}/onepassword-refs`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(del.status).toBe(200);
    const row = await api!.providers.engineCredentials.get({ type: "team", id: team.id }, ONEPASSWORD_SERVICE);
    expect(row).toBeNull();
  });
});
