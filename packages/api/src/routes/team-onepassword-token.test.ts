import { and, eq } from "drizzle-orm";
import { mutateTeamOnePassword } from "../services/team-onepassword-token.js";
import { createOnePasswordService } from "../services/onepassword.js";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { orgs, orgMembers, teamMembers, users } from "../schema/index.js";
import { addMember, createTeam, deleteTeam } from "../services/teams.js";

let api: TestApi;
afterEach(async () => { await api?.cleanup(); });
const headers = { "content-type": "application/json" };
const member = { ...headers, "x-valet-test-user-id": "test-member" };
async function setup() {
  api = await bootTestApi();
  const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
  await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
  return team.id;
}
function put(teamId: string, token = "fake-team-token", auth: Record<string, string> = headers) {
  return fetch(`${api.baseUrl}/api/credentials/onepassword`, {
    method: "PUT", headers: auth,
    body: JSON.stringify({ type: "service_account", apiKey: token, scope: "team", teamId }),
  });
}
function disconnect(teamId: string) {
  return fetch(`${api.baseUrl}/api/credentials/onepassword?scope=team&teamId=${teamId}`, { method: "DELETE", headers });
}
function status(teamId: string, auth: Record<string, string> = member) {
  return fetch(`${api.baseUrl}/api/onepassword/team-status?teamId=${teamId}`, { headers: auth });
}

describe("team token management", () => {
  it("connects, reports presence without secrets, rotates, and disconnects", async () => {
    const id = await setup();
    expect(await (await status(id)).json()).toEqual({ tokenConnected: false });
    expect((await put(id)).status).toBe(200);
    expect(await (await status(id)).json()).toEqual({ tokenConnected: true });
    expect((await put(id, "fake-rotation")).status).toBe(200);
    expect(await api.providers.engineCredentials.get({ type: "team", id }, "onepassword")).toMatchObject({ apiKey: "fake-rotation" });
    const list = await fetch(`${api.baseUrl}/api/credentials?scope=team&teamId=${id}`, { headers: member });
    expect(await list.json()).toEqual({ credentials: [] });
    expect((await disconnect(id)).status).toBe(200);
    expect(await (await status(id)).json()).toEqual({ tokenConnected: false });
  });

  it("permits member status, refuses member writes and foreign team access", async () => {
    const id = await setup();
    expect((await put(id, "fake", member)).status).toBe(404);
    expect((await status(id)).status).toBe(200);
    expect((await fetch(`${api.baseUrl}/api/credentials/onepassword?scope=team&teamId=${id}`, { method: "DELETE", headers: member })).status).toBe(404);
    await api.providers.db.insert(orgs).values({ id: "foreign-org", name: "Foreign", createdAt: Date.now() });
    const other = await createTeam(api.providers.db, { orgId: "foreign-org", name: "Other", creatorUserId: "local-user" });
    expect((await put(other.id)).status).toBe(404);
    expect((await status(other.id, headers)).status).toBe(404);
    await api.providers.db.insert(users).values({ id: "stranger", email: "stranger@test", name: "Stranger", role: "member" });
    await api.providers.db.insert(orgMembers).values({ orgId: "local-org", userId: "stranger", role: "member", createdAt: Date.now() });
    expect((await status(id, { ...headers, "x-valet-test-user-id": "stranger" })).status).toBe(404);
    expect((await put(id, "fake", { ...headers, "x-valet-test-user-id": "test-admin" })).status).toBe(200);
  });

  it("removes the old routes without deleting legacy tokens or enforcing their metadata", async () => {
    const id = await setup();
    const owner = { type: "team", id } as const;
    await api.providers.engineCredentials.save(owner, "onepassword", {
      type: "service_account", apiKey: "fake-existing", metadata: { refs: ["op://Old/Item/field"], keep: true },
    });
    for (const method of ["GET", "PUT", "DELETE"]) {
      const result = await fetch(`${api.baseUrl}/api/teams/${id}/onepassword-refs`, { method, headers });
      expect(result.status).toBe(404);
    }
    expect(await api.providers.engineCredentials.get(owner, "onepassword")).toMatchObject({ apiKey: "fake-existing" });
    expect((await put(id, "fake-replacement")).status).toBe(200);
    expect(await api.providers.engineCredentials.get(owner, "onepassword")).toMatchObject({ apiKey: "fake-replacement", metadata: { keep: true } });
    expect((await api.providers.engineCredentials.get(owner, "onepassword"))?.metadata).not.toHaveProperty("refs");
  });

  it("reports grant-only rows as disconnected and serializes concurrent token replacements", async () => {
    const id = await setup();
    const owner = { type: "team", id } as const;
    await api.providers.engineCredentials.save(owner, "onepassword", { type: "service_account", metadata: { refs: ["op://Old/Item/field"] } });
    expect(await (await status(id)).json()).toEqual({ tokenConnected: false });
    expect((await Promise.all([put(id, "fake-a"), put(id, "fake-b")])).map((r) => r.status)).toEqual([200, 200]);
    expect(["fake-a", "fake-b"]).toContain((await api.providers.engineCredentials.get(owner, "onepassword"))?.apiKey);
    expect((await disconnect(id)).status).toBe(200);
    expect(await api.providers.engineCredentials.get(owner, "onepassword")).toBeNull();
  });

  it("rejects token delegation and malformed team token shapes", async () => {
    const id = await setup();
    const delegated = await fetch(`${api.baseUrl}/api/credentials/onepassword/delegate`, { method: "POST", headers, body: JSON.stringify({ teamId: id }) });
    expect(delegated.status).toBe(400);
    for (const extra of [{ type: "api_key" }, { accessToken: "fake" }, { metadata: { refs: ["op://v/i/f"] } }]) {
      const response = await fetch(`${api.baseUrl}/api/credentials/onepassword`, {
        method: "PUT", headers, body: JSON.stringify({ scope: "team", teamId: id, type: "service_account", apiKey: "fake", ...extra }),
      });
      expect(response.status).toBe(400);
    }
    expect(await (await status(id)).json()).toEqual({ tokenConnected: false });
  });
});


describe("team token authority serialization", () => {
  it("rechecks team and org authority inside the write transaction after revocation", async () => {
    const id = await setup();
    const db = api.providers.db;
    const teamWhere = and(eq(teamMembers.teamId, id), eq(teamMembers.userId, "test-member"));
    await db.update(teamMembers).set({ role: "admin" }).where(teamWhere);
    await db.transaction(async (tx) => { await tx.update(teamMembers).set({ role: "member" }).where(teamWhere); });
    expect(await mutateTeamOnePassword(db, api.providers.encryptionKey,
      { orgId: "local-org", userId: "test-member", teamId: id }, { kind: "token", token: "fake" })).toBe(false);
    await db.update(orgMembers).set({ role: "member" }).where(and(eq(orgMembers.orgId, "local-org"), eq(orgMembers.userId, "test-admin")));
    expect(await mutateTeamOnePassword(db, api.providers.encryptionKey,
      { orgId: "local-org", userId: "test-admin", teamId: id }, { kind: "token", token: "fake" })).toBe(false);
    expect(await api.providers.engineCredentials.get({ type: "team", id }, "onepassword")).toBeNull();
  });

  it("serializes token writes with team deletion and leaves no orphan credential", async () => {
    const id = await setup();
    await Promise.all([
      mutateTeamOnePassword(api.providers.db, api.providers.encryptionKey,
        { orgId: "local-org", userId: "local-user", teamId: id }, { kind: "token", token: "fake" }),
      deleteTeam(api.providers.db, { teamId: id }),
    ]);
    expect(await api.providers.engineCredentials.get({ type: "team", id }, "onepassword")).toBeNull();
    expect(await mutateTeamOnePassword(api.providers.db, api.providers.encryptionKey,
      { orgId: "local-org", userId: "local-user", teamId: id }, { kind: "token", token: "fake" })).toBe(false);
  });
});


describe("team reference writes and vault probe", () => {
  it("validates explicit team references with the authorized identity and refuses other owners", async () => {
    const id = await setup();
    await put(id);
    const calls: string[] = [];
    api.providers.onePassword = createOnePasswordService({
      credentials: api.providers.engineCredentials, getAllowPersonal: async () => true,
      createClient: async (token) => {
        calls.push(token);
        return {
          secrets: { resolve: async () => "fake-reference-value" },
          vaults: { list: async () => [{ id: "v", title: "Vault" }] },
          items: { list: async () => [], getWithSecrets: async () => ({ title: "Item", fields: [] }) },
        };
      },
    });
    for (const scope of ["user", "org", "team"]) {
      const result = await fetch(`${api.baseUrl}/api/credentials/linear`, {
        method: "PUT", headers, body: JSON.stringify({ scope, teamId: id, type: "api_key", onepassword: { tokenScope: "team", reference: "op://Vault/Item/token" } }),
      });
      expect(result.status).toBe(scope === "team" ? 200 : 400);
    }
    expect(calls).toEqual(["fake-team-token"]);
    const row = await api.providers.engineCredentials.get({ type: "team", id }, "linear");
    expect(row?.metadata?.onepassword).toEqual({ tokenScope: "team", reference: "op://Vault/Item/token" });
    expect(row?.apiKey).toBeUndefined();
    const probe = `${api.baseUrl}/api/onepassword/vaults?scope=team&teamId=${id}`;
    expect((await fetch(probe, { headers: member })).status).toBe(404);
    expect(await (await fetch(probe, { headers })).json()).toEqual({ vaults: [{ id: "v", title: "Vault" }] });
  });
});
