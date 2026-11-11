// @vitest-environment node
/**
 * Personal secrets: saving through Settings and reading through the sandbox
 * broker. An in-memory provider stands in for the backend, so these tests
 * check Valet's rules, not a provider's behavior. `services/secret-store/
 * turnkey.test.ts` covers the Turnkey provider.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { agentSessions, secretStoreSpaces, teams } from "../schema/index.js";
import { SecretStoreError, type SecretLabels, type SecretOwner, type SecretStoreProvider } from "../services/secret-store/provider.js";
import { createSecretStoreService, parsePersonalReference } from "../services/secret-store/service.js";

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

/** A provider in memory: spaces hold named secrets, and every read records
 * its context. */
function memoryProvider(opts: { failRead?: boolean } = {}) {
  const spaces = new Map<string, StoredSecret[]>();
  const owners: SecretOwner[] = [];
  const reads: { spaceId: string; name: string; context: SecretLabels }[] = [];
  const provider: SecretStoreProvider = {
    id: "memory",
    label: "Memory",
    async createSpace(owner) {
      owners.push(owner);
      // A real provider takes a moment; a concurrent first save must wait, not race.
      await new Promise((r) => setTimeout(r, 20));
      const id = `space-${owners.length}`;
      spaces.set(id, []);
      return id;
    },
    async list(spaceId) {
      return (spaces.get(spaceId) ?? []).map(({ name, createdAt }) => ({ name, createdAt }));
    },
    async put(spaceId, { name, value, labels }) {
      const list = spaces.get(spaceId);
      if (!list) throw new Error("no such space");
      if (list.some((s) => s.name === name)) throw new Error("duplicate name");
      list.unshift({ name, value, labels, createdAt: Date.now() });
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

async function userSession(id: string, owner: string, tokenUser = owner): Promise<string> {
  await api!.providers.db.insert(agentSessions).values({
    id,
    userId: owner,
    orgId: "local-org",
    workspace: "/workspace",
    ownerType: "user",
    ownerId: owner,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const { token } = await mintSandboxToken(api!.providers.db, { sessionId: id, userId: tokenUser, orgId: "local-org" });
  return token;
}

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

describe("secret:// references", () => {
  it("parses only a personal reference with a valid name", () => {
    expect(parsePersonalReference("secret://personal/granola/api-key")).toEqual({ name: "granola/api-key" });
    expect(parsePersonalReference("secret://personal/GITHUB_TOKEN")).toEqual({ name: "GITHUB_TOKEN" });
    for (const bad of ["secret://personal/", "secret://personal/../x", "secret://team/x", "secret://personal/a//b", "secret://personal/a b"]) {
      expect(parsePersonalReference(bad), bad).toBeNull();
    }
  });
});

describe("personal secrets through the broker", () => {
  it("delivers the exact bytes to the owner's own session and records who asked", async () => {
    const fake = await bootWithStore();
    const value = 'pa"ss\\wörd 🔑\nsecond line\n';
    await api!.providers.secretStore.save({ orgId: "local-org", userId: "user-a" }, "granola/api-key", value);
    const token = await userSession("sess-a", "user-a");

    const res = await resolve(["secret://personal/granola/api-key"], token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Resp;
    expect(decode(body.values[0])).toBe(value);
    expect(fake.reads).toHaveLength(1);
    expect(fake.reads[0]!.context).toEqual({
      valet_org_id: "local-org",
      valet_user_id: "user-a",
      valet_session_id: "sess-a",
      valet_session_owner_type: "user",
      valet_session_owner_id: "user-a",
    });
    const saved = [...fake.spaces.values()].flat()[0]!;
    expect(saved.name).toBe("granola/api-key");
    expect(saved.labels).toEqual({
      scope: "personal",
      valet_org_id: "local-org",
      valet_owner_type: "user",
      valet_owner_id: "user-a",
      valet_created_by_user_id: "user-a",
    });
  });

  it("resolves 1Password and secret store references in one run", async () => {
    await bootWithStore();
    api!.providers.onePassword = {
      ...api!.providers.onePassword,
      resolveReference: async () => "OP-VALUE",
    };
    await api!.providers.secretStore.save({ orgId: "local-org", userId: "user-a" }, "k", "STORE-VALUE");
    const token = await userSession("sess-mixed", "user-a");
    const body = (await (await resolve(["op://v/i/f", "secret://personal/k"], token)).json()) as Resp;
    expect(body.values.map(decode)).toEqual(["OP-VALUE", "STORE-VALUE"]);
  });

  it("names a personal secret that does not exist instead of failing the request", async () => {
    await bootWithStore();
    await api!.providers.secretStore.save({ orgId: "local-org", userId: "user-a" }, "present", "x");
    const token = await userSession("sess-missing", "user-a");
    const body = (await (await resolve(["secret://personal/absent"], token)).json()) as Resp;
    expect(body.unresolved).toEqual(["secret://personal/absent"]);
  });

  it("never reads another user's secret: the name resolves in the caller's own space only", async () => {
    const fake = await bootWithStore();
    await api!.providers.secretStore.save({ orgId: "local-org", userId: "user-a" }, "shared-name", "ALICE");
    const token = await userSession("sess-b", "user-b");
    const body = (await (await resolve(["secret://personal/shared-name"], token)).json()) as Resp;
    expect(body.values[0]).toBeNull();
    expect(fake.reads).toHaveLength(0);
  });

  it("refuses a team session before any provider call", async () => {
    const fake = await bootWithStore();
    await api!.providers.secretStore.save({ orgId: "local-org", userId: "user-a" }, "k", "V");
    await api!.providers.db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "T", createdAt: Date.now() });
    await api!.providers.db.insert(agentSessions).values({
      id: "sess-team",
      userId: "user-a",
      orgId: "local-org",
      workspace: "/workspace",
      ownerType: "team",
      ownerId: "team-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { token } = await mintSandboxToken(api!.providers.db, { sessionId: "sess-team", userId: "user-a", orgId: "local-org" });
    const res = await resolve(["secret://personal/k"], token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("personal session");
    expect(fake.reads).toHaveLength(0);
  });

  it("refuses a token minted before the session changed hands", async () => {
    const fake = await bootWithStore();
    await api!.providers.secretStore.save({ orgId: "local-org", userId: "user-a" }, "k", "V");
    const token = await userSession("sess-moved", "user-b", "user-a");
    expect((await resolve(["secret://personal/k"], token)).status).toBe(403);
    expect(fake.reads).toHaveLength(0);
  });

  it("fails the whole run on a provider error and keeps the provider's text out", async () => {
    await bootWithStore({ failRead: true });
    await api!.providers.secretStore.save({ orgId: "local-org", userId: "user-a" }, "k", "V");
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

describe("secret store service", () => {
  it("creates one space per user under concurrent first saves", async () => {
    const fake = await bootWithStore();
    const svc = api!.providers.secretStore;
    const user = { orgId: "local-org", userId: "user-a" };
    await Promise.all([svc.save(user, "one", "1"), svc.save(user, "two", "2")]);
    expect(fake.owners).toEqual([{ orgId: "local-org", ownerType: "user", ownerId: "user-a" }]);
    const rows = await api!.providers.db.select().from(secretStoreSpaces);
    expect(rows).toEqual([expect.objectContaining({ ownerType: "user", ownerId: "user-a", provider: "memory", spaceId: "space-1" })]);
    expect((await svc.list(user)).map((s) => s.name).sort()).toEqual(["one", "two"]);
  });

  it("refuses a duplicate name, then accepts it after a delete", async () => {
    await bootWithStore();
    const svc = api!.providers.secretStore;
    const user = { orgId: "local-org", userId: "user-a" };
    await svc.save(user, "k", "old");
    await expect(svc.save(user, "k", "new")).rejects.toMatchObject({ kind: "exists" });
    await svc.remove(user, "k");
    await svc.save(user, "k", "new");
    expect(await svc.list(user)).toHaveLength(1);
  });

  it("gives each owner a new space when the operator changes provider", async () => {
    await bootWithStore();
    const user = { orgId: "local-org", userId: "user-a" };
    await api!.providers.secretStore.save(user, "k", "OLD");
    const next = memoryProvider();
    const switched = createSecretStoreService({
      db: api!.providers.db,
      provider: { ...next.provider, id: "memory-2" },
      log: () => {},
    });
    expect(await switched.list(user)).toEqual([]);
    await switched.save(user, "k", "NEW");
    const rows = await api!.providers.db.select().from(secretStoreSpaces);
    expect(rows.map((r) => r.provider).sort()).toEqual(["memory", "memory-2"]);
  });

  it("passes a provider's own SecretStoreError through and hides any other text", async () => {
    const fake = await bootWithStore();
    const user = { orgId: "local-org", userId: "user-a" };
    await api!.providers.secretStore.save(user, "k", "V");
    fake.provider.list = async () => {
      throw new SecretStoreError("More than 1000 secrets are saved. Delete some you no longer use.", "too_many");
    };
    await expect(api!.providers.secretStore.list(user)).rejects.toMatchObject({ kind: "too_many" });
    fake.provider.list = async () => {
      throw new Error("raw upstream text SENTINEL");
    };
    const err = await api!.providers.secretStore.list(user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect((err as SecretStoreError).kind).toBe("provider");
    expect((err as SecretStoreError).message).not.toContain("SENTINEL");
  });
});

describe("/api/secrets", () => {
  it("saves, lists names and references, and deletes; never returns a value", async () => {
    await bootWithStore();
    const base = `${api!.baseUrl}/api/secrets`;
    const created = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "granola/api-key", value: "TOP-SECRET" }),
    });
    expect(created.status).toBe(201);
    expect(await created.text()).not.toContain("TOP-SECRET");

    const listed = await fetch(base);
    const listText = await listed.text();
    expect(listText).not.toContain("TOP-SECRET");
    const list = JSON.parse(listText) as { enabled: boolean; provider: string | null; secrets: { name: string; reference: string }[] };
    expect(list.enabled).toBe(true);
    expect(list.provider).toBe("Memory");
    expect(list.secrets).toEqual([
      expect.objectContaining({ name: "granola/api-key", reference: "secret://personal/granola/api-key" }),
    ]);

    const dup = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "granola/api-key", value: "again" }),
    });
    expect(dup.status).toBe(409);

    expect((await fetch(`${base}?name=${encodeURIComponent("granola/api-key")}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}?name=gone`, { method: "DELETE" })).status).toBe(404);
  });

  it("reports the feature off when the deployment has no key", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/secrets`);
    expect(await res.json()).toEqual({ enabled: false, provider: null, secrets: [] });
  });

  it("refuses a sandbox token", async () => {
    await bootWithStore();
    const token = await userSession("sess-x", "local-user");
    const res = await fetch(`${api!.baseUrl}/api/secrets`, { headers: { "x-valet-sandbox": token } });
    expect(res.status).toBe(403);
  });
});
