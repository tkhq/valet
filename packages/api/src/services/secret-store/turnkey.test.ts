// @vitest-environment node
/**
 * The Turnkey provider against fake SDK clients: what each service user sends
 * to Turnkey, how a personal space is set up, how it pages, and how it reads
 * its settings. The service rules are covered in
 * `routes/sandbox-secrets.secret-store.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { secretStoreProviderFromEnv } from "./config.js";
import { SecretStoreError } from "./provider.js";
import {
  BROKER_USER_NAME,
  createTurnkeySecretStore,
  PROVISIONER_USER_NAME,
  subOrganizationIdOf,
  turnkeyConfigFromEnv,
  TURNKEY_SEAL_KIND,
  type TurnkeyApiClient,
  type TurnkeySecretMetadata,
} from "./turnkey.js";

const CONFIG = {
  apiBaseUrl: "https://api.turnkey.example",
  orgId: "parent-org",
  provisioner: { apiPublicKey: "02prov", apiPrivateKey: "p1" },
  broker: { apiPublicKey: "02brok", apiPrivateKey: "p2" },
};

type Stored = TurnkeySecretMetadata & { plaintext: string; staticProperties: Record<string, string> };

/** One Turnkey shared by both fake clients; `calls` records who did what. */
function fakeTurnkey() {
  const secrets = new Map<string, Stored[]>([["parent-org", []]]);
  const calls: { who: string; method: string; input: unknown }[] = [];
  let nextId = 0;
  const add = (organizationId: string, name: string, plaintext: string, staticProperties: Record<string, string>) => {
    const secretId = `sec-${++nextId}`;
    secrets.get(organizationId)!.unshift({
      secretId,
      name,
      createdAtUnixMs: String(1_700_000_000_000 + nextId),
      plaintext,
      staticProperties,
    });
    return secretId;
  };
  const client = (who: string): TurnkeyApiClient => ({
    async createSubOrganization(input) {
      calls.push({ who, method: "createSubOrganization", input });
      secrets.set("sub-1", []);
      return { subOrganizationId: "sub-1" };
    },
    async getUsers(input) {
      calls.push({ who, method: "getUsers", input });
      return {
        users: [
          { userId: "u-prov", userName: PROVISIONER_USER_NAME },
          { userId: "u-brok", userName: BROKER_USER_NAME },
        ],
      };
    },
    async createPolicy(input) {
      calls.push({ who, method: "createPolicy", input });
      return { policyId: `pol-${calls.length}` };
    },
    async updateRootQuorum(input) {
      calls.push({ who, method: "updateRootQuorum", input });
    },
    async command(url, body) {
      calls.push({ who, method: "command", input: { url, body } });
      return { enclaveTargetMessages: ["bundle-1"] };
    },
    async importSecrets(input) {
      calls.push({ who, method: "importSecrets", input });
      const s = input.secrets[0]!;
      const props = Object.fromEntries(s.staticProperties.map(({ key, value }) => [key, value]));
      return { secretIds: [add(input.organizationId, s.name, `sealed:${s.secretPayload}`, props)] };
    },
    async importSecret(params) {
      calls.push({ who, method: "importSecret", input: params });
      return add(params.organizationId, params.name, params.plaintext, params.staticProperties);
    },
    async getSecrets({ organizationId, paginationOptions }) {
      calls.push({ who, method: "getSecrets", input: paginationOptions });
      const list = secrets.get(organizationId) ?? [];
      const start = paginationOptions.after ? list.findIndex((s) => s.secretId === paginationOptions.after) + 1 : 0;
      return list.slice(start, start + Number(paginationOptions.limit));
    },
    async deleteSecrets({ organizationId, secretIds }) {
      calls.push({ who, method: "deleteSecrets", input: secretIds });
      secrets.set(organizationId, (secrets.get(organizationId) ?? []).filter((s) => !secretIds.includes(s.secretId)));
    },
    async exportSecret(params) {
      calls.push({ who, method: "exportSecret", input: params });
      return secrets.get(params.organizationId)!.find((s) => s.secretId === params.secretId)!.plaintext;
    },
  });
  return { provisioner: client("provisioner"), broker: client("broker"), secrets, calls };
}

function storeWith(fake: ReturnType<typeof fakeTurnkey>, overrides: { broker?: Partial<TurnkeyApiClient> } = {}) {
  return createTurnkeySecretStore(CONFIG, {
    provisioner: fake.provisioner,
    broker: { ...fake.broker, ...overrides.broker },
  });
}

describe("Turnkey secret store", () => {
  it("sets up a personal sub-organization: both service users as roots, two policies, then a 2-of-2 quorum", async () => {
    const fake = fakeTurnkey();
    const store = storeWith(fake);
    expect(await store.createPersonalSpace({ orgId: "o", userId: "u1" })).toBe("sub-1");
    expect(fake.calls.map((c) => `${c.who}:${c.method}`)).toEqual([
      "provisioner:createSubOrganization",
      "provisioner:getUsers",
      "provisioner:createPolicy",
      "provisioner:createPolicy",
      "provisioner:updateRootQuorum",
    ]);
    expect(fake.calls[0]!.input).toMatchObject({
      organizationId: "parent-org",
      subOrganizationName: "valet-user-u1",
      rootQuorumThreshold: 1,
      rootUsers: [
        { userName: PROVISIONER_USER_NAME, apiKeys: [{ publicKey: "02prov" }] },
        { userName: BROKER_USER_NAME, apiKeys: [{ publicKey: "02brok" }] },
      ],
    });
    const [provisionerPolicy, brokerPolicy] = [fake.calls[2]!.input, fake.calls[3]!.input] as { consensus: string; condition: string }[];
    expect(provisionerPolicy!.consensus).toContain("'u-prov'");
    expect(provisionerPolicy!.condition).not.toContain("EXPORT");
    expect(brokerPolicy!.consensus).toContain("'u-brok'");
    expect(brokerPolicy!.condition).toContain("ACTIVITY_TYPE_EXPORT_SECRETS");
    expect(brokerPolicy!.condition).toContain("request_context['valet_session_owner_id'] == secret.static_properties['valet_owner_user_id']");
    expect(fake.calls[4]!.input).toEqual({ organizationId: "sub-1", threshold: 2, userIds: ["u-prov", "u-brok"] });
  });

  it("reads the sub-organization id from the activity when the SDK names another result version", () => {
    expect(subOrganizationIdOf({ activity: { result: { createSubOrganizationResultV8: { subOrganizationId: "sub-v8" } } } })).toBe("sub-v8");
    expect(subOrganizationIdOf({ activity: { result: {} } })).toBeUndefined();
  });

  it("imports with the provisioner and exports with the broker, with labels and request context", async () => {
    const fake = fakeTurnkey();
    const store = storeWith(fake);
    await store.put("parent-org", { name: "company/k", value: "V\n", labels: { scope: "company" } });
    expect(fake.secrets.get("parent-org")![0]!.staticProperties).toEqual({ scope: "company" });
    expect(await store.read("parent-org", "company/k", { valet_session_id: "s1" })).toBe("V\n");
    const exported = fake.calls.find((c) => c.method === "exportSecret")!;
    expect(exported.who).toBe("broker");
    expect(exported.input).toMatchObject({ organizationId: "parent-org", requestContext: { valet_session_id: "s1" } });
    expect(fake.calls.find((c) => c.method === "importSecret")!.who).toBe("provisioner");
  });

  it("starts a sealed import with an enclave target and finishes it without plaintext", async () => {
    const fake = fakeTurnkey();
    const store = storeWith(fake);
    const envelope = await store.beginImport("parent-org");
    expect(envelope).toEqual({ kind: TURNKEY_SEAL_KIND, ingressTargetBundle: "bundle-1", organizationId: "parent-org" });
    await store.finishImport("parent-org", {
      name: "team/t1/DB",
      sealed: { kind: TURNKEY_SEAL_KIND, secretPayload: "CIPHER", targetPublicKey: "04abc" },
      labels: { scope: "team", valet_owner_team_id: "t1" },
    });
    const imported = fake.calls.find((c) => c.method === "importSecrets")!.input as { secrets: { staticProperties: unknown }[] };
    expect(imported.secrets[0]!.staticProperties).toEqual([
      { key: "scope", value: "team" },
      { key: "valet_owner_team_id", value: "t1" },
    ]);
    await expect(
      store.finishImport("parent-org", { name: "x", sealed: { kind: "other" }, labels: {} }),
    ).rejects.toMatchObject({ kind: "invalid_value" });
  });

  it("lists by prefix, finds a name past the first page, and deletes it by id", async () => {
    const fake = fakeTurnkey();
    const store = storeWith(fake);
    await store.put("parent-org", { name: "company/oldest", value: "FIRST", labels: {} });
    for (let i = 0; i < 120; i++) await store.put("parent-org", { name: `team/t1/n${i}`, value: "x", labels: {} });
    expect((await store.list("parent-org", "company/")).map((m) => m.name)).toEqual(["company/oldest"]);
    expect(await store.read("parent-org", "company/oldest", {})).toBe("FIRST");
    expect(await store.remove("parent-org", "company/oldest")).toBe(true);
    expect(fake.calls.at(-1)).toMatchObject({ method: "deleteSecrets", input: ["sec-1"] });
    expect(await store.remove("parent-org", "company/oldest")).toBe(false);
    expect(await store.read("parent-org", "company/oldest", {})).toBeNull();
  });

  it("names a refused export instead of a generic failure", async () => {
    const fake = fakeTurnkey();
    const parked = Object.assign(new Error("Secret export requires consensus."), { code: "EXPORT_SECRET_CONSENSUS_NEEDED" });
    const store = storeWith(fake, { broker: { exportSecret: async () => Promise.reject(parked) } });
    await store.put("parent-org", { name: "company/k", value: "V", labels: {} });
    const err = await store.read("parent-org", "company/k", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect((err as SecretStoreError).kind).toBe("forbidden");
  });

  it("passes any other export error to the service unchanged", async () => {
    const fake = fakeTurnkey();
    const boom = new Error("socket hang up");
    const store = storeWith(fake, { broker: { exportSecret: async () => Promise.reject(boom) } });
    await store.put("parent-org", { name: "company/k", value: "V", labels: {} });
    expect(await store.read("parent-org", "company/k", {}).catch((e: unknown) => e)).toBe(boom);
  });

  it("refuses a partial list rather than report a saved secret as missing", async () => {
    const full: TurnkeySecretMetadata[] = Array.from({ length: 100 }, (_, i) => ({ secretId: `s${i}`, name: `n${i}`, createdAtUnixMs: "0" }));
    const fake = fakeTurnkey();
    const store = createTurnkeySecretStore(CONFIG, { provisioner: { ...fake.provisioner, getSecrets: async () => full }, broker: fake.broker });
    const err = await store.list("sub", "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect((err as SecretStoreError).kind).toBe("too_many");
  });
});

describe("secret store settings", () => {
  const keys = {
    VALET_TURNKEY_ORG_ID: "parent",
    VALET_TURNKEY_PROVISIONER_API_PUBLIC_KEY: "pub1",
    VALET_TURNKEY_PROVISIONER_API_PRIVATE_KEY: "priv1",
    VALET_TURNKEY_BROKER_API_PUBLIC_KEY: "pub2",
    VALET_TURNKEY_BROKER_API_PRIVATE_KEY: "priv2",
  };

  it("is off when VALET_SECRET_STORE is unset, even with Turnkey keys", () => {
    expect(secretStoreProviderFromEnv({ ...keys })).toBeNull();
  });

  it("builds the Turnkey provider when selected", () => {
    const provider = secretStoreProviderFromEnv({ VALET_SECRET_STORE: "turnkey", ...keys });
    expect(provider?.id).toBe("turnkey");
    expect(provider?.deploymentSpace()).toBe("parent");
  });

  it("names the missing Turnkey settings", () => {
    expect(() => secretStoreProviderFromEnv({ VALET_SECRET_STORE: "turnkey", VALET_TURNKEY_ORG_ID: "parent" })).toThrow(
      /VALET_TURNKEY_PROVISIONER_API_PUBLIC_KEY.*VALET_TURNKEY_BROKER_API_PRIVATE_KEY/,
    );
  });

  it("refuses one key for both service users", () => {
    expect(() =>
      turnkeyConfigFromEnv({ ...keys, VALET_TURNKEY_BROKER_API_PUBLIC_KEY: "pub1" }),
    ).toThrow(/different Turnkey API keys/);
  });

  it("refuses an unknown provider and lists the known ones", () => {
    expect(() => secretStoreProviderFromEnv({ VALET_SECRET_STORE: "vault" })).toThrow(/Use one of: turnkey/);
  });

  it("defaults the Turnkey API URL", () => {
    expect(turnkeyConfigFromEnv({ ...keys }).apiBaseUrl).toBe("https://api.turnkey.com");
  });
});
