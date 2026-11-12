// @vitest-environment node
/**
 * Company, team, and personal secrets: saving through `/api/secrets` and
 * reading through the sandbox broker. An in-memory provider stands in for
 * the backend, so these tests check Valet's rules, not a provider's
 * behavior. `services/secret-store/turnkey.test.ts` covers the Turnkey
 * provider.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { agentSessions, orgMembers, secretStoreSpaces, teamMembers, teams } from "../schema/index.js";
import { SecretStoreError, type SecretLabels, type SecretStoreProvider } from "../services/secret-store/provider.js";
import { createSecretStoreService, parseSecretReference, secretReference } from "../services/secret-store/service.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

interface StoredSecret {
  name: string;
  value: string;
  labels: SecretLabels;
  createdAt: number;
}

const SEAL = "memory-seal";
/** The fake "seals" by base64. A real sealer encrypts to the provider. */
const seal = (value: string) => ({ kind: SEAL, payload: Buffer.from(value, "utf8").toString("base64") });

/** A provider in memory: spaces hold named secrets, and every read records
 * its context. `deploy` is the deployment space. */
function memoryProvider(opts: { failRead?: boolean } = {}) {
  const spaces = new Map<string, StoredSecret[]>([["deploy", []]]);
  const owners: { orgId: string; userId: string }[] = [];
  const reads: { spaceId: string; name: string; context: SecretLabels }[] = [];
  const store = (spaceId: string, secret: StoredSecret) => {
    const list = spaces.get(spaceId);
    if (!list) throw new Error("no such space");
    if (list.some((s) => s.name === secret.name)) throw new Error("duplicate name");
    list.unshift(secret);
  };
  const provider: SecretStoreProvider = {
    id: "memory",
    label: "Memory",
    deploymentSpace: () => "deploy",
    async createPersonalSpace(owner) {
      owners.push(owner);
      // A real provider takes a moment; a concurrent first save must wait, not race.
      await new Promise((r) => setTimeout(r, 20));
      const id = `space-${owners.length}`;
      spaces.set(id, []);
      return id;
    },
    async list(spaceId, prefix) {
      return (spaces.get(spaceId) ?? []).filter((s) => s.name.startsWith(prefix)).map(({ name, createdAt }) => ({ name, createdAt }));
    },
    async put(spaceId, { name, value, labels }) {
      store(spaceId, { name, value, labels, createdAt: Date.now() });
    },
    async beginImport(spaceId) {
      return { kind: SEAL, spaceId };
    },
    async finishImport(spaceId, { name, sealed, labels }) {
      if (sealed.kind !== SEAL || typeof sealed.payload !== "string") throw new SecretStoreError("bad seal", "invalid_value");
      store(spaceId, { name, value: Buffer.from(sealed.payload, "base64").toString("utf8"), labels, createdAt: Date.now() });
    },
    async remove(spaceId, name) {
      const list = spaces.get(spaceId) ?? [];
      const next = list.filter((s) => s.name !== name);
      spaces.set(spaceId, next);
      return next.length !== list.length;
    },
    async read(spaceId, name, context) {
      if (opts.failRead) throw new Error("upstream said no, value=SENTINEL");
      reads.push({ spaceId, name, context });
      return spaces.get(spaceId)?.find((s) => s.name === name)?.value ?? null;
    },
  };
  return { provider, spaces, owners, reads };
}

async function bootWithStore(opts: { failRead?: boolean } = {}) {
  api = await bootTestApi();
  const fake = memoryProvider(opts);
  api.providers.secretStore = createSecretStoreService({ db: api.providers.db, provider: fake.provider, log: () => {} });
  return fake;
}

async function addMember(userId: string, role: "admin" | "member" = "member") {
  await api!.providers.db.insert(orgMembers).values({ orgId: "local-org", userId, role, createdAt: Date.now() }).onConflictDoNothing();
}

async function addTeam(teamId: string, members: string[]) {
  await api!.providers.db.insert(teams).values({ id: teamId, orgId: "local-org", name: teamId, createdAt: Date.now() });
  for (const userId of members) {
    await api!.providers.db.insert(teamMembers).values({ teamId, userId, role: "member" });
  }
}

async function session(id: string, owner: { type: "user" | "team"; id: string }, tokenUser: string): Promise<string> {
  await api!.providers.db.insert(agentSessions).values({
    id,
    userId: tokenUser,
    orgId: "local-org",
    workspace: "/workspace",
    ownerType: owner.type,
    ownerId: owner.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const { token } = await mintSandboxToken(api!.providers.db, { sessionId: id, userId: tokenUser, orgId: "local-org" });
  return token;
}
const userSession = (id: string, owner: string, tokenUser = owner) => session(id, { type: "user", id: owner }, tokenUser);

async function resolve(references: string[], token: string) {
  return fetch(`${api!.baseUrl}/api/sandbox-secrets/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-valet-sandbox": token },
    body: JSON.stringify({ references }),
  });
}

function decode(value: string | null): string | null {
  return value === null ? null : Buffer.from(value, "base64").toString("utf8");
}
type Resp = { values: (string | null)[]; unresolved: string[] };

const as = (userId: string) => ({ orgId: "local-org", userId });
const personal = { kind: "personal" } as const;
const company = { kind: "company" } as const;
const team = (teamId: string) => ({ kind: "team", teamId }) as const;

describe("secret:// references", () => {
  it("parses the three scopes and refuses any other shape", () => {
    expect(parseSecretReference("secret://personal/granola/api-key")).toEqual({ scope: personal, name: "granola/api-key" });
    expect(parseSecretReference("secret://company/DATABASE_URL")).toEqual({ scope: company, name: "DATABASE_URL" });
    expect(parseSecretReference("secret://team/team-1/DB")).toEqual({ scope: team("team-1"), name: "DB" });
    for (const bad of [
      "secret://personal/",
      "secret://personal/../x",
      "secret://team/x",
      "secret://team//x",
      "secret://org/x",
      "secret://personal/a//b",
      "secret://personal/a b",
    ]) {
      expect(parseSecretReference(bad), bad).toBeNull();
    }
    expect(secretReference(team("t1"), "A/B")).toBe("secret://team/t1/A/B");
  });
});

describe("personal secrets through the broker", () => {
  it("delivers the exact bytes to the owner's own session and records who asked", async () => {
    const fake = await bootWithStore();
    const value = 'pa"ss\\wörd 🔑\nsecond line\n';
    await api!.providers.secretStore.saveValue(as("user-a"), personal, "granola/api-key", value);
    const token = await userSession("sess-a", "user-a");
    const res = await resolve(["secret://personal/granola/api-key"], token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(decode(body.values[0])).toBe(value);
    expect(fake.reads).toHaveLength(1);
    expect(fake.reads[0]!.context).toEqual({
      valet_company_org_id: "local-org",
      valet_user_id: "user-a",
      valet_session_id: "sess-a",
      valet_session_owner_type: "user",
      valet_session_owner_id: "user-a",
    });
    const saved = [...fake.spaces.values()].flat()[0]!;
    expect(saved.name).toBe("personal/granola/api-key");
    expect(saved.labels).toEqual({
      scope: "personal",
      valet_company_org_id: "local-org",
      valet_owner_user_id: "user-a",
      valet_created_by_user_id: "user-a",
    });
  });

  it("resolves 1Password and secret store references in one run", async () => {
    await bootWithStore();
    api!.providers.onePassword = { ...api!.providers.onePassword, resolveReference: async () => "OP-VALUE" };
    await api!.providers.secretStore.saveValue(as("user-a"), personal, "k", "STORE-VALUE");
    const token = await userSession("sess-mixed", "user-a");
    const body = (await (await resolve(["op://v/i/f", "secret://personal/k"], token)).json()) as Resp;
    expect(body.values.map(decode)).toEqual(["OP-VALUE", "STORE-VALUE"]);
  });

  it("names a secret that does not exist instead of failing the request", async () => {
    await bootWithStore();
    await api!.providers.secretStore.saveValue(as("user-a"), personal, "present", "x");
    const token = await userSession("sess-missing", "user-a");
    const body = (await (await resolve(["secret://personal/absent"], token)).json()) as Resp;
    expect(body.unresolved).toEqual(["secret://personal/absent"]);
  });

  it("never reads another user's secret: the name resolves in the caller's own space only", async () => {
    const fake = await bootWithStore();
    await api!.providers.secretStore.saveValue(as("user-a"), personal, "shared-name", "ALICE");
    const token = await userSession("sess-b", "user-b");
    const body = (await (await resolve(["secret://personal/shared-name"], token)).json()) as Resp;
    expect(body.values[0]).toBeNull();
    expect(fake.reads).toHaveLength(0);
  });

  it("refuses a team session before any provider call", async () => {
    const fake = await bootWithStore();
    await api!.providers.secretStore.saveValue(as("user-a"), personal, "k", "V");
    await addTeam("team-1", ["user-a"]);
    const token = await session("sess-team", { type: "team", id: "team-1" }, "user-a");
    const res = await resolve(["secret://personal/k"], token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("personal session");
    expect(fake.reads).toHaveLength(0);
  });

  it("refuses a token minted before the session changed hands", async () => {
    const fake = await bootWithStore();
    await api!.providers.secretStore.saveValue(as("user-a"), personal, "k", "V");
    const token = await userSession("sess-moved", "user-b", "user-a");
    expect((await resolve(["secret://personal/k"], token)).status).toBe(403);
    expect(fake.reads).toHaveLength(0);
  });

  it("fails the whole run on a provider error and keeps the provider's text out", async () => {
    await bootWithStore({ failRead: true });
    await api!.providers.secretStore.saveValue(as("user-a"), personal, "k", "V");
    const token = await userSession("sess-fail", "user-a");
    const res = await resolve(["secret://personal/k"], token);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain("values");
  });

  it("says the store is not set up when the deployment sets no provider", async () => {
    api = await bootTestApi();
    const token = await userSession("sess-off", "user-a");
    expect((await resolve(["secret://personal/k"], token)).status).toBe(503);
  });
});

describe("company and team secrets through the broker", () => {
  it("delivers a company secret to any session in the organization", async () => {
    const fake = await bootWithStore();
    await api!.providers.secretStore.saveValue(as("local-user"), company, "DATABASE_URL", "postgres://x");
    await addTeam("team-1", ["user-a"]);
    const userToken = await userSession("sess-c1", "user-b");
    const teamToken = await session("sess-c2", { type: "team", id: "team-1" }, "user-a");
    for (const token of [userToken, teamToken]) {
      const body = (await (await resolve(["secret://company/DATABASE_URL"], token)).json()) as Resp;
      expect(decode(body.values[0])).toBe("postgres://x");
    }
    expect(fake.reads.every((r) => r.spaceId === "deploy" && r.name === "company/DATABASE_URL")).toBe(true);
    expect(fake.spaces.get("deploy")![0]!.labels).toEqual({
      scope: "company",
      valet_company_org_id: "local-org",
      valet_created_by_user_id: "local-user",
    });
  });

  it("delivers a team secret to the team's sessions and a member's own session, with the team in the context", async () => {
    const fake = await bootWithStore();
    await addTeam("team-1", ["user-a"]);
    await api!.providers.secretStore.saveValue(as("user-a"), team("team-1"), "DB", "team-db");
    const teamToken = await session("sess-t1", { type: "team", id: "team-1" }, "user-b");
    const memberToken = await userSession("sess-t2", "user-a");
    for (const token of [teamToken, memberToken]) {
      const body = (await (await resolve(["secret://team/team-1/DB"], token)).json()) as Resp;
      expect(decode(body.values[0])).toBe("team-db");
    }
    expect(fake.reads.map((r) => r.context.valet_owner_team_id)).toEqual(["team-1", "team-1"]);
    expect(fake.reads[0]!.context.valet_session_owner_type).toBe("team");
  });

  it("refuses a team secret to a non-member and to another team, before any provider call", async () => {
    const fake = await bootWithStore();
    await addTeam("team-1", ["user-a"]);
    await addTeam("team-2", ["user-c"]);
    await api!.providers.secretStore.saveValue(as("user-a"), team("team-1"), "DB", "team-db");
    const outsider = await userSession("sess-o1", "user-b");
    const otherTeam = await session("sess-o2", { type: "team", id: "team-2" }, "user-c");
    for (const token of [outsider, otherTeam]) {
      const res = await resolve(["secret://team/team-1/DB"], token);
      expect(res.status).toBe(403);
    }
    expect(fake.reads).toHaveLength(0);
  });
});

describe("secret store service", () => {
  it("creates one personal space per user under concurrent first saves", async () => {
    const fake = await bootWithStore();
    const svc = api!.providers.secretStore;
    await Promise.all([svc.saveValue(as("user-a"), personal, "one", "1"), svc.saveValue(as("user-a"), personal, "two", "2")]);
    expect(fake.owners).toEqual([{ orgId: "local-org", userId: "user-a" }]);
    const rows = await api!.providers.db.select().from(secretStoreSpaces);
    expect(rows).toEqual([expect.objectContaining({ ownerType: "user", ownerId: "user-a", provider: "memory", spaceId: "space-1" })]);
    expect((await svc.list(as("user-a"), personal)).map((s) => s.name).sort()).toEqual(["one", "two"]);
  });

  it("refuses a duplicate name, then accepts it after a delete", async () => {
    await bootWithStore();
    const svc = api!.providers.secretStore;
    await svc.saveValue(as("user-a"), personal, "k", "old");
    await expect(svc.saveValue(as("user-a"), personal, "k", "new")).rejects.toMatchObject({ kind: "exists" });
    await svc.remove(as("user-a"), personal, "k");
    await svc.saveValue(as("user-a"), personal, "k", "new");
    expect(await svc.list(as("user-a"), personal)).toHaveLength(1);
  });

  it("lets only org admins write company secrets and only members write team secrets", async () => {
    await bootWithStore();
    const svc = api!.providers.secretStore;
    await addMember("user-a");
    await addTeam("team-1", ["user-a"]);
    await expect(svc.saveValue(as("user-a"), company, "X", "v")).rejects.toMatchObject({ kind: "forbidden" });
    await expect(svc.saveValue(as("user-b"), team("team-1"), "X", "v")).rejects.toMatchObject({ kind: "forbidden" });
    await expect(svc.saveValue(as("user-a"), team("no-such-team"), "X", "v")).rejects.toMatchObject({ kind: "not_found" });
    await svc.saveValue(as("local-user"), company, "X", "v");
    await svc.saveValue(as("user-a"), team("team-1"), "X", "v");
    // Same short name in two scopes: two secrets.
    expect((await svc.list(as("user-b"), company)).map((s) => s.reference)).toEqual(["secret://company/X"]);
    expect((await svc.list(as("user-b"), team("team-1"))).map((s) => s.reference)).toEqual(["secret://team/team-1/X"]);
  });

  it("passes a provider's own SecretStoreError through and hides any other text", async () => {
    const fake = await bootWithStore();
    await api!.providers.secretStore.saveValue(as("user-a"), personal, "k", "V");
    fake.provider.list = async () => {
      throw new SecretStoreError("More than 1000 secrets are saved. Delete some you no longer use.", "too_many");
    };
    await expect(api!.providers.secretStore.list(as("user-a"), personal)).rejects.toMatchObject({ kind: "too_many" });
    fake.provider.list = async () => {
      throw new Error("raw upstream text SENTINEL");
    };
    const err = await api!.providers.secretStore.list(as("user-a"), personal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect((err as SecretStoreError).kind).toBe("provider");
    expect((err as SecretStoreError).message).not.toContain("SENTINEL");
  });
});

describe("/api/secrets", () => {
  const post = (path: string, body: unknown) =>
    fetch(`${api!.baseUrl}/api/secrets${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("saves through a sealed import, lists names and references, and deletes; never returns a value", async () => {
    const fake = await bootWithStore();
    const begin = await post("/import/begin", { scope: "personal", name: "granola/api-key" });
    expect(begin.status).toBe(200);
    expect(((await begin.json()) as { envelope: { kind: string } }).envelope.kind).toBe(SEAL);
    const finish = await post("/import/finish", { scope: "personal", name: "granola/api-key", sealed: seal("TOP-SECRET") });
    expect(finish.status).toBe(201);
    expect(await finish.text()).not.toContain("TOP-SECRET");
    expect([...fake.spaces.values()].flat()[0]!.value).toBe("TOP-SECRET");

    const listed = await fetch(`${api!.baseUrl}/api/secrets?scope=personal`);
    const listText = await listed.text();
    expect(listText).not.toContain("TOP-SECRET");
    const list = JSON.parse(listText) as { enabled: boolean; canWrite: boolean; secrets: { name: string; reference: string }[] };
    expect(list.enabled).toBe(true);
    expect(list.canWrite).toBe(true);
    expect(list.secrets).toEqual([expect.objectContaining({ name: "granola/api-key", reference: "secret://personal/granola/api-key" })]);

    expect((await post("/import/begin", { scope: "personal", name: "granola/api-key" })).status).toBe(409);
    expect((await fetch(`${api!.baseUrl}/api/secrets?name=${encodeURIComponent("granola/api-key")}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${api!.baseUrl}/api/secrets?name=gone`, { method: "DELETE" })).status).toBe(404);
  });

  it("has no route that accepts a plaintext value", async () => {
    await bootWithStore();
    const res = await post("", { name: "k", value: "TOP-SECRET" });
    expect(res.status).toBe(404);
  });

  it("saves and lists company secrets for an admin", async () => {
    await bootWithStore();
    expect((await post("/import/finish", { scope: "company", name: "DB", sealed: seal("v") })).status).toBe(201);
    const list = (await (await fetch(`${api!.baseUrl}/api/secrets?scope=company`)).json()) as { secrets: { reference: string }[] };
    expect(list.secrets.map((s) => s.reference)).toEqual(["secret://company/DB"]);
    expect((await fetch(`${api!.baseUrl}/api/secrets?scope=team`)).status).toBe(400);
  });

  it("reports the feature off when the deployment has no provider", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/secrets`);
    expect(await res.json()).toEqual({ enabled: false, provider: null, canWrite: false, secrets: [] });
  });

  it("refuses a sandbox token", async () => {
    await bootWithStore();
    const token = await userSession("sess-x", "local-user");
    const res = await fetch(`${api!.baseUrl}/api/secrets`, { headers: { "x-valet-sandbox": token } });
    expect(res.status).toBe(403);
  });
});
