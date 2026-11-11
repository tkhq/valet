// @vitest-environment node
/**
 * The Turnkey provider against a fake SDK client: what it sends to Turnkey,
 * how it pages, and how it reads its settings. The service rules are covered
 * in `routes/sandbox-secrets.secret-store.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { secretStoreProviderFromEnv } from "./config.js";
import { SecretStoreError } from "./provider.js";
import { createTurnkeySecretStore, turnkeyConfigFromEnv, type TurnkeyApiClient, type TurnkeySecretMetadata } from "./turnkey.js";

const CONFIG = {
  apiBaseUrl: "https://api.turnkey.example",
  parentOrgId: "parent-org",
  apiPublicKey: "02broker",
  apiPrivateKey: "private",
};

function fakeClient() {
  const secrets = new Map<string, (TurnkeySecretMetadata & { plaintext: string; staticProperties: Record<string, string> })[]>();
  const calls: { method: string; input: unknown }[] = [];
  let nextId = 0;
  const client: TurnkeyApiClient = {
    async createSubOrganization(input) {
      calls.push({ method: "createSubOrganization", input });
      secrets.set("sub-1", []);
      return { subOrganizationId: "sub-1" };
    },
    async importSecret(params) {
      calls.push({ method: "importSecret", input: params });
      const secretId = `sec-${++nextId}`;
      secrets.get(params.organizationId)!.unshift({
        secretId,
        name: params.name,
        createdAtUnixMs: String(1_700_000_000_000 + nextId),
        plaintext: params.plaintext,
        staticProperties: params.staticProperties,
      });
      return secretId;
    },
    async getSecrets({ organizationId, paginationOptions }) {
      calls.push({ method: "getSecrets", input: paginationOptions });
      const list = secrets.get(organizationId) ?? [];
      const start = paginationOptions.after ? list.findIndex((s) => s.secretId === paginationOptions.after) + 1 : 0;
      return list.slice(start, start + Number(paginationOptions.limit));
    },
    async deleteSecrets({ organizationId, secretIds }) {
      calls.push({ method: "deleteSecrets", input: secretIds });
      secrets.set(organizationId, (secrets.get(organizationId) ?? []).filter((s) => !secretIds.includes(s.secretId)));
    },
    async exportSecret(params) {
      calls.push({ method: "exportSecret", input: params });
      return secrets.get(params.organizationId)!.find((s) => s.secretId === params.secretId)!.plaintext;
    },
  };
  return { client, secrets, calls };
}

describe("Turnkey secret store", () => {
  it("creates a sub-organization whose only root is the broker key", async () => {
    const fake = fakeClient();
    const store = createTurnkeySecretStore(CONFIG, { client: fake.client });
    expect(await store.createSpace({ orgId: "o", ownerType: "user", ownerId: "u1" })).toBe("sub-1");
    expect(fake.calls[0]!.input).toEqual({
      organizationId: "parent-org",
      subOrganizationName: "valet-user-u1",
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName: "valet-broker",
          apiKeys: [{ apiKeyName: "valet-broker", publicKey: "02broker", curveType: "API_KEY_CURVE_P256" }],
          authenticators: [],
          oauthProviders: [],
        },
      ],
    });
  });

  it("sends labels as static properties and the read context as request context", async () => {
    const fake = fakeClient();
    const store = createTurnkeySecretStore(CONFIG, { client: fake.client });
    const space = await store.createSpace({ orgId: "o", ownerType: "user", ownerId: "u1" });
    await store.put(space, { name: "k", value: "V\n", labels: { scope: "personal", valet_owner_id: "u1" } });
    expect(fake.secrets.get(space)![0]!.staticProperties).toEqual({ scope: "personal", valet_owner_id: "u1" });
    expect(await store.read(space, "k", { valet_session_id: "s1" })).toBe("V\n");
    const exported = fake.calls.find((c) => c.method === "exportSecret")!.input;
    expect(exported).toMatchObject({ organizationId: space, requestContext: { valet_session_id: "s1" } });
    expect(await store.list(space)).toEqual([{ name: "k", createdAt: 1_700_000_000_001 }]);
  });

  it("finds a name past the first page and deletes it by id", async () => {
    const fake = fakeClient();
    const store = createTurnkeySecretStore(CONFIG, { client: fake.client });
    const space = await store.createSpace({ orgId: "o", ownerType: "user", ownerId: "u1" });
    await store.put(space, { name: "oldest", value: "FIRST", labels: {} });
    for (let i = 0; i < 120; i++) await store.put(space, { name: `n${i}`, value: "x", labels: {} });
    expect(await store.read(space, "oldest", {})).toBe("FIRST");
    expect(await store.remove(space, "oldest")).toBe(true);
    expect(fake.calls.at(-1)).toEqual({ method: "deleteSecrets", input: ["sec-1"] });
    expect(await store.remove(space, "oldest")).toBe(false);
    expect(await store.read(space, "oldest", {})).toBeNull();
  });

  it("names an export that waits for approval instead of a generic failure", async () => {
    const fake = fakeClient();
    const approval = Object.assign(new Error("Secret export requires consensus."), { code: "EXPORT_SECRET_CONSENSUS_NEEDED" });
    const client: TurnkeyApiClient = { ...fake.client, exportSecret: async () => Promise.reject(approval) };
    const store = createTurnkeySecretStore(CONFIG, { client });
    const space = await store.createSpace({ orgId: "o", ownerType: "user", ownerId: "u1" });
    await store.put(space, { name: "k", value: "V", labels: {} });
    const err = await store.read(space, "k", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect((err as SecretStoreError).message).toMatch(/needs an approval.*Remove the approval rule/);
  });

  it("passes any other export error to the service unchanged", async () => {
    const fake = fakeClient();
    const boom = new Error("socket hang up");
    const client: TurnkeyApiClient = { ...fake.client, exportSecret: async () => Promise.reject(boom) };
    const store = createTurnkeySecretStore(CONFIG, { client });
    const space = await store.createSpace({ orgId: "o", ownerType: "user", ownerId: "u1" });
    await store.put(space, { name: "k", value: "V", labels: {} });
    expect(await store.read(space, "k", {}).catch((e: unknown) => e)).toBe(boom);
  });

  it("refuses a partial list rather than report a saved secret as missing", async () => {
    const full: TurnkeySecretMetadata[] = Array.from({ length: 100 }, (_, i) => ({
      secretId: `s${i}`,
      name: `n${i}`,
      createdAtUnixMs: "0",
    }));
    const client: TurnkeyApiClient = { ...fakeClient().client, getSecrets: async () => full };
    const store = createTurnkeySecretStore(CONFIG, { client });
    const err = await store.list("sub").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect((err as SecretStoreError).kind).toBe("too_many");
  });
});

describe("secret store settings", () => {
  const keys = {
    VALET_TURNKEY_ORG_ID: "parent",
    VALET_TURNKEY_API_PUBLIC_KEY: "pub",
    VALET_TURNKEY_API_PRIVATE_KEY: "priv",
  };

  it("is off when VALET_SECRET_STORE is unset, even with Turnkey keys", () => {
    expect(secretStoreProviderFromEnv({ ...keys })).toBeNull();
  });

  it("builds the Turnkey provider when selected", () => {
    const provider = secretStoreProviderFromEnv({ VALET_SECRET_STORE: "turnkey", ...keys });
    expect(provider?.id).toBe("turnkey");
    expect(provider?.label).toBe("Turnkey");
  });

  it("names the missing Turnkey settings", () => {
    expect(() => secretStoreProviderFromEnv({ VALET_SECRET_STORE: "turnkey", VALET_TURNKEY_ORG_ID: "parent" })).toThrow(
      /VALET_TURNKEY_API_PUBLIC_KEY, VALET_TURNKEY_API_PRIVATE_KEY/,
    );
  });

  it("refuses an unknown provider and lists the known ones", () => {
    expect(() => secretStoreProviderFromEnv({ VALET_SECRET_STORE: "vault" })).toThrow(/Use one of: turnkey/);
  });

  it("defaults the Turnkey API URL", () => {
    expect(turnkeyConfigFromEnv({ ...keys }).apiBaseUrl).toBe("https://api.turnkey.com");
  });
});
