/**
 * Team `vlt_` keys (TKAI-396). Real better-auth, real create/list/revoke,
 * and a real POST /api/sessions — the done-when is ownerType team, not a
 * mocked principal.
 */
import { describe, expect, it, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { teamMembers, teams, users } from "../schema/index.js";
import type {
  CreateTeamApiKeyResponse,
  CreateTeamResponse,
  ListTeamApiKeysResponse,
  SessionDetail,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function extractSessionCookie(setCookieHeader: string | null): string {
  expect(setCookieHeader).toBeTruthy();
  const match = setCookieHeader?.match(/better-auth\.session_token=[^;]+/);
  expect(match).toBeTruthy();
  return match![0];
}

async function signUp(baseUrl: string, email: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: "correct-horse-battery" }),
  });
  expect(res.status).toBe(200);
  return extractSessionCookie(res.headers.get("set-cookie"));
}

async function createTeam(baseUrl: string, cookie: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/teams`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as CreateTeamResponse;
  return body.team.id;
}

describe("team API keys", () => {
  it("a team key starts a team-owned session; a personal key cannot", async () => {
    api = await bootTestApi({ auth: true });
    const cookie = await signUp(api.baseUrl, "admin@nowhere.test", "First Admin");
    const teamId = await createTeam(api.baseUrl, cookie, "Platform");

    const createRes = await fetch(`${api.baseUrl}/api/teams/${teamId}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "CI" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as CreateTeamApiKeyResponse;
    expect(created.key.startsWith("vlt_")).toBe(true);
    expect(created.createdBy).toBeTruthy();

    const workspace = await mkdtemp(join(tmpdir(), "valet-team-key-"));
    const teamSession = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": created.key },
      body: JSON.stringify({ workspace }),
    });
    expect(teamSession.status).toBe(201);
    const teamBody = (await teamSession.json()) as SessionDetail;
    expect(teamBody.owner).toEqual({ type: "team", id: teamId });

    const personalRes = await fetch(`${api.baseUrl}/api/auth/api-key/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "personal" }),
    });
    expect(personalRes.status).toBe(200);
    const personal = (await personalRes.json()) as { key: string };

    const refused = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": personal.key },
      body: JSON.stringify({ workspace, teamId }),
    });
    expect(refused.status).toBe(403);
    const refusedBody = (await refused.json()) as { error: string };
    expect(refusedBody.error).toContain("personal API key");
  });

  it("list and revoke are admin-gated; revoke stops the key", async () => {
    api = await bootTestApi({ auth: true });
    const cookie = await signUp(api.baseUrl, "admin@nowhere.test", "First Admin");
    const teamId = await createTeam(api.baseUrl, cookie, "Platform");

    const created = (await (
      await fetch(`${api.baseUrl}/api/teams/${teamId}/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "CI" }),
      })
    ).json()) as CreateTeamApiKeyResponse;

    const listRes = await fetch(`${api.baseUrl}/api/teams/${teamId}/api-keys`, {
      headers: { cookie },
    });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as ListTeamApiKeysResponse;
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]?.id).toBe(created.id);
    expect(listed.keys[0]).not.toHaveProperty("key");

    const del = await fetch(`${api.baseUrl}/api/teams/${teamId}/api-keys/${created.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    const dead = await fetch(`${api.baseUrl}/api/me`, { headers: { "x-api-key": created.key } });
    expect(dead.status).toBe(401);
  });

  it("the key still works after the creating admin leaves the team", async () => {
    api = await bootTestApi({ auth: true });
    const cookie = await signUp(api.baseUrl, "admin@nowhere.test", "First Admin");
    const teamId = await createTeam(api.baseUrl, cookie, "Platform");
    const created = (await (
      await fetch(`${api.baseUrl}/api/teams/${teamId}/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "CI" }),
      })
    ).json()) as CreateTeamApiKeyResponse;

    const adminRows = await api.providers.db
      .select()
      .from(users)
      .where(eq(users.email, "admin@nowhere.test"))
      .limit(1);
    const adminId = adminRows[0]?.id;
    expect(adminId).toBeTruthy();
    if (!adminId) return;

    await api.providers.db.insert(users).values({
      id: "stay-admin",
      email: "stay@nowhere.test",
      name: "Stay",
      role: "member",
    });
    await api.providers.db.insert(teamMembers).values({
      teamId,
      userId: "stay-admin",
      role: "admin",
    });
    await api.providers.db.delete(teamMembers).where(eq(teamMembers.userId, adminId));

    const workspace = await mkdtemp(join(tmpdir(), "valet-departed-"));
    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": created.key },
      body: JSON.stringify({ workspace }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as SessionDetail).owner).toEqual({ type: "team", id: teamId });
  });

  it("a gone team rejects the key", async () => {
    api = await bootTestApi({ auth: true });
    const cookie = await signUp(api.baseUrl, "admin@nowhere.test", "First Admin");
    const teamId = await createTeam(api.baseUrl, cookie, "Platform");

    const created = (await (
      await fetch(`${api.baseUrl}/api/teams/${teamId}/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "CI" }),
      })
    ).json()) as CreateTeamApiKeyResponse;

    await api.providers.db.delete(teams).where(eq(teams.id, teamId));

    const gone = await fetch(`${api.baseUrl}/api/me`, { headers: { "x-api-key": created.key } });
    expect(gone.status).toBe(401);
    expect(((await gone.json()) as { error: string }).error).toBe("invalid api key");
  });

  it("personal create/update cannot stamp metadata.teamId", async () => {
    api = await bootTestApi({ auth: true });
    const cookie = await signUp(api.baseUrl, "admin@nowhere.test", "First Admin");
    const teamId = await createTeam(api.baseUrl, cookie, "Platform");

    const stolen = await fetch(`${api.baseUrl}/api/auth/api-key/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "stolen", metadata: { teamId } }),
    });
    expect(stolen.status).toBe(403);

    const personalRes = await fetch(`${api.baseUrl}/api/auth/api-key/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "personal" }),
    });
    expect(personalRes.status).toBe(200);
    const personal = (await personalRes.json()) as { id: string; key: string };

    const patched = await fetch(`${api.baseUrl}/api/auth/api-key/update`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ keyId: personal.id, metadata: { teamId } }),
    });
    expect(patched.status).toBe(403);

    const workspace = await mkdtemp(join(tmpdir(), "valet-stamp-"));
    const sessionRes = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": personal.key },
      body: JSON.stringify({ workspace }),
    });
    expect(sessionRes.status).toBe(201);
    expect(((await sessionRes.json()) as SessionDetail).owner.type).toBe("user");
  });

  it("personal delete cannot revoke a team key; team key cannot create a personal assistant", async () => {
    api = await bootTestApi({ auth: true });
    const cookie = await signUp(api.baseUrl, "admin@nowhere.test", "First Admin");
    const teamId = await createTeam(api.baseUrl, cookie, "Platform");
    const created = (await (
      await fetch(`${api.baseUrl}/api/teams/${teamId}/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "CI" }),
      })
    ).json()) as CreateTeamApiKeyResponse;

    const personalDelete = await fetch(`${api.baseUrl}/api/auth/api-key/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ keyId: created.id }),
    });
    expect(personalDelete.status).toBe(403);

    const assistant = await fetch(`${api.baseUrl}/api/assistants`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": created.key },
      body: JSON.stringify({ name: "stolen-assistant" }),
    });
    expect(assistant.status).toBe(403);

    const still = await fetch(`${api.baseUrl}/api/me`, { headers: { "x-api-key": created.key } });
    expect(still.status).toBe(200);
  });
});
