/**
 * Team `vlt_` keys (TKAI-396). Real better-auth, real create/list/revoke,
 * and a real POST /api/sessions — the done-when is ownerType team, not a
 * mocked principal.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as authModule from "../auth/index.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { TEAM_KEY_ADMIN_REQUIRED } from "./team-api-keys.js";
import { isTeamMember } from "../services/teams.js";
import { apikey, orgMembers, teamMembers, teams, users } from "../schema/index.js";
import type {
  CreateInviteResponse,
  CreateTeamApiKeyResponse,
  CreateTeamResponse,
  GetMeResponse,
  ListTeamApiKeysResponse,
  SessionDetail,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.restoreAllMocks();
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

/**
 * A second (or third) person in the same org. Only the first signup is
 * admitted without an invite, so the org admin issues one first.
 */
async function inviteAndSignUp(
  baseUrl: string,
  adminCookie: string,
  email: string,
  name: string,
  role: "admin" | "member",
): Promise<string> {
  const inviteRes = await fetch(`${baseUrl}/api/org/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ role }),
  });
  expect(inviteRes.status).toBe(200);
  const invite = (await inviteRes.json()) as CreateInviteResponse;
  const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: "correct-horse-battery", inviteCode: invite.code }),
  });
  expect(res.status).toBe(200);
  return extractSessionCookie(res.headers.get("set-cookie"));
}

async function userIdByEmail(target: TestApi, email: string): Promise<string> {
  const rows = await target.providers.db.select().from(users).where(eq(users.email, email)).limit(1);
  const id = rows[0]?.id;
  if (!id) throw new Error(`Expected a user row for ${email}`);
  return id;
}

function createTeamKey(baseUrl: string, cookie: string, teamId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/teams/${teamId}/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "proxy-key" }),
  });
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
    // The indexed column is what the list filters on; it must agree with
    // the metadata the auth ladder reads.
    const pinned = await api.providers.db
      .select({ teamId: apikey.teamId, metadata: apikey.metadata })
      .from(apikey)
      .where(eq(apikey.id, created.id))
      .limit(1);
    expect(pinned[0]?.teamId).toBe(teamId);
    expect(JSON.parse(pinned[0]?.metadata ?? "{}")).toMatchObject({ teamId });

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

  it("creation answers a team member with the admin rule, and admits both admin kinds", async () => {
    api = await bootTestApi({ auth: true });
    const { baseUrl, providers: { db } } = api;
    const adminCookie = await signUp(baseUrl, "admin@nowhere.test", "First Admin");
    const teamId = await createTeam(baseUrl, adminCookie, "Platform");

    // 1. A plain org member who belongs to the team.
    const memberCookie = await inviteAndSignUp(baseUrl, adminCookie, "member@nowhere.test", "Member", "member");
    const memberId = await userIdByEmail(api, "member@nowhere.test");
    await db.insert(teamMembers).values({ teamId, userId: memberId, role: "member" });

    const refused = await createTeamKey(baseUrl, memberCookie, teamId);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe(TEAM_KEY_ADMIN_REQUIRED);
    expect(await db.select().from(apikey).where(eq(apikey.teamId, teamId))).toEqual([]);

    // The same member creates a personal key without an admin. That is the
    // action the refusal names, so it has to work.
    const personal = await fetch(`${baseUrl}/api/auth/api-key/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({ name: "proxy-key" }),
    });
    expect(personal.status).toBe(200);
    expect(((await personal.json()) as { key: string }).key.startsWith("vlt_")).toBe(true);

    // 2. An org member who is not on the team cannot learn that it exists.
    const outsiderCookie = await inviteAndSignUp(baseUrl, adminCookie, "outsider@nowhere.test", "Outsider", "member");
    const hidden = await createTeamKey(baseUrl, outsiderCookie, teamId);
    expect(hidden.status).toBe(404);
    expect(((await hidden.json()) as { error: string }).error).toBe("team not found");

    // 3. A team admin who is a plain org member creates the key.
    await db
      .update(teamMembers)
      .set({ role: "admin" })
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, memberId)));
    const byTeamAdmin = await createTeamKey(baseUrl, memberCookie, teamId);
    expect(byTeamAdmin.status).toBe(201);
    expect(((await byTeamAdmin.json()) as CreateTeamApiKeyResponse).createdBy).toBe(memberId);

    // 4. An org admin who never joined the team creates one too.
    const orgAdminCookie = await inviteAndSignUp(baseUrl, adminCookie, "orgadmin@nowhere.test", "Org Admin", "admin");
    const orgAdminId = await userIdByEmail(api, "orgadmin@nowhere.test");
    expect(await isTeamMember(db, teamId, orgAdminId)).toBe(false);
    const byOrgAdmin = await createTeamKey(baseUrl, orgAdminCookie, teamId);
    expect(byOrgAdmin.status).toBe(201);
    expect(((await byOrgAdmin.json()) as CreateTeamApiKeyResponse).createdBy).toBe(orgAdminId);
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

  it("GET /api/me for a team key answers with the team, not the creating admin", async () => {
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

    const res = await fetch(`${api.baseUrl}/api/me`, { headers: { "x-api-key": created.key } });
    expect(res.status).toBe(200);
    const me = (await res.json()) as GetMeResponse;
    expect(me.role).toBe("team");
    expect(me).toMatchObject({ id: teamId, name: "Platform" });
    expect(me).not.toHaveProperty("email");
    // PATCH stays outside the allow-list: a key cannot edit a person's profile.
    const patched = await fetch(`${api.baseUrl}/api/me`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-api-key": created.key },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(patched.status).toBe(403);
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

  it("deleting the team through the route reaps its keys", async () => {
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

    const del = await fetch(`${api.baseUrl}/api/teams/${teamId}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);

    // Nothing left to revoke it: the team list 404s on a team that is
    // gone, and the personal routes refuse every team-pinned key. A row
    // that survives here survives forever.
    const rows = await api.providers.db
      .select({ id: apikey.id })
      .from(apikey)
      .where(eq(apikey.id, created.id));
    expect(rows).toEqual([]);

    const dead = await fetch(`${api.baseUrl}/api/me`, { headers: { "x-api-key": created.key } });
    expect(dead.status).toBe(401);
  });

  it.each(["team deleted", "admin demoted", "key missing", "pin throws"] as const)(
    "cleans up a minted key when %s before the final pin",
    async (interleaving) => {
      let afterMint: (id: string) => Promise<void> = async () => {};
      let mintedId = "";
      let mintedKey = "";
      const buildAuth = authModule.buildAuth;
      vi.spyOn(authModule, "buildAuth").mockImplementation((opts) => {
        const auth = buildAuth(opts);
        const createApiKey = auth.api.createApiKey;
        vi.spyOn(auth.api, "createApiKey").mockImplementation(async (input) => {
          const created = await createApiKey(input);
          if (!created) throw new Error("Expected better-auth to mint a key");
          mintedId = created.id;
          mintedKey = created.key;
          // The real mint has committed, but the route has not received it.
          // Complete the competing operation here without timing or sleeps.
          await afterMint(created.id);
          return created;
        });
        return auth;
      });
      api = await bootTestApi({ auth: true });
      const { baseUrl, providers: { db } } = api;
      const cookie = await signUp(baseUrl, "admin@nowhere.test", "First Admin");
      const teamId = await createTeam(baseUrl, cookie, "Platform");
      afterMint = async (keyId) => {
        const rows = await db.select().from(apikey).where(eq(apikey.id, keyId));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.teamId).toBeNull();
        if (interleaving === "team deleted") {
          const deleted = await fetch(`${baseUrl}/api/teams/${teamId}`, {
            method: "DELETE", headers: { cookie },
          });
          expect(deleted.status).toBe(200);
          expect(await db.select().from(teams).where(eq(teams.id, teamId))).toEqual([]);
        } else if (interleaving === "admin demoted") {
          const creatorId = rows[0]?.referenceId;
          if (!creatorId) throw new Error("Expected a key creator");
          await db.update(orgMembers).set({ role: "member" }).where(eq(orgMembers.userId, creatorId));
          await db.update(teamMembers).set({ role: "member" }).where(eq(teamMembers.teamId, teamId));
        } else if (interleaving === "key missing") {
          await db.delete(apikey).where(eq(apikey.id, keyId));
        } else {
          const transaction = db.transaction.bind(db);
          vi.spyOn(db, "transaction").mockImplementationOnce((callback) => transaction(async (tx) => {
            vi.spyOn(tx, "update").mockImplementationOnce(() => {
              throw new Error("Injected pin write failure");
            });
            return callback(tx);
          }));
        }
      };

      const response = await fetch(`${baseUrl}/api/teams/${teamId}/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "CI" }),
      });
      // A demotion leaves the caller on the team, so the answer names the
      // admin rule. A deleted team stays hidden.
      const expected = { "team deleted": 404, "admin demoted": 403, "key missing": 500, "pin throws": 500 };
      expect(response.status).toBe(expected[interleaving]);
      if (interleaving === "admin demoted") {
        expect(((await response.clone().json()) as { error: string }).error).toBe(TEAM_KEY_ADMIN_REQUIRED);
      }
      expect(await response.text()).not.toContain(mintedKey);
      expect(mintedId).not.toBe("");
      expect(await db.select().from(apikey).where(eq(apikey.id, mintedId))).toEqual([]);
      const dead = await fetch(`${baseUrl}/api/me`, { headers: { "x-api-key": mintedKey } });
      expect(dead.status).toBe(401);
    },
  );

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
