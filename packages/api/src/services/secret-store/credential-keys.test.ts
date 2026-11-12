// @vitest-environment node
/**
 * Owner keys for the credentials table: the keyring against an in-memory
 * provider, the cipher's two formats, and `PgCredentialStore` moving a row
 * from the instance key to an owner key as it reads it.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDbFromPglite } from "@valet/store-postgres";
import { applyAppMigrations, buildAppDb } from "../../lib/drizzle.js";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../../lib/secret-crypto.js";
import { PgCredentialStore } from "../../plugins/credential-store.js";
import { createCredentialKeyring, credentialCipher, OWNER_KEY_PREFIX, ownerKeyName } from "./credential-keys.js";
import type { SecretLabels, SecretStoreProvider } from "./provider.js";

const pglite = new PGlite();
const pg = pgDbFromPglite(pglite);
const db = buildAppDb(pglite);
const instanceKey = deriveSecretKey("test-key");

beforeAll(async () => {
  await applyAppMigrations(pg);
});
afterAll(async () => {
  await pg.close();
});

function memoryProvider() {
  const stored = new Map<string, { value: string; labels: SecretLabels }>();
  const reads: { name: string; context: SecretLabels }[] = [];
  const refuse = async (): Promise<never> => {
    throw new Error("not used");
  };
  const provider: SecretStoreProvider = {
    id: "memory",
    label: "Memory",
    deploymentSpace: () => "deploy",
    createPersonalSpace: refuse,
    list: async (_space, prefix) => [...stored.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name, createdAt: 0 })),
    put: async (_space, { name, value, labels }) => {
      if (stored.has(name)) throw new Error("duplicate");
      stored.set(name, { value, labels });
    },
    beginImport: refuse,
    finishImport: refuse,
    remove: async (_space, name) => stored.delete(name),
    read: async (_space, name, context) => {
      reads.push({ name, context });
      const hit = stored.get(name);
      // The provider's policy: release a key only to a read naming its owner.
      if (hit && hit.labels.valet_key_owner !== context.valet_key_owner) throw new Error("forbidden");
      return hit?.value ?? null;
    },
  };
  return { provider, stored, reads };
}

const user = { type: "user" as const, id: "u1" };

describe("credential keyring", () => {
  it("creates one key per owner, labels it, and reads it with the owner in the context", async () => {
    const fake = memoryProvider();
    const keyring = createCredentialKeyring({ provider: fake.provider, db, orgId: async () => "org-1" });
    const [a, b] = await Promise.all([keyring.keyFor(user), keyring.keyFor(user)]);
    expect(a.length).toBe(32);
    expect(b.equals(a)).toBe(true);
    expect(fake.stored.get(ownerKeyName(user))?.labels).toEqual({
      scope: "credential_key",
      valet_company_org_id: "org-1",
      valet_key_owner: "user:u1",
    });
    // A second keyring (another api process) reads the same key.
    const other = createCredentialKeyring({ provider: fake.provider, db, orgId: async () => "org-1" });
    expect((await other.keyFor(user)).equals(a)).toBe(true);
    expect(fake.reads.at(-1)?.context).toEqual({ valet_company_org_id: "org-1", valet_key_owner: "user:u1" });
    const team = await keyring.keyFor({ type: "team", id: "t1" });
    expect(team.equals(a)).toBe(false);
  });

  it("serves a cached key without a provider read until it expires", async () => {
    const fake = memoryProvider();
    let clock = 0;
    const keyring = createCredentialKeyring({ provider: fake.provider, db, orgId: async () => "org-1", ttlMs: 1000, now: () => clock });
    await keyring.keyFor(user);
    const readsAfterFirst = fake.reads.length;
    await keyring.keyFor(user);
    expect(fake.reads.length).toBe(readsAfterFirst);
    clock = 2000;
    await keyring.keyFor(user);
    expect(fake.reads.length).toBe(readsAfterFirst + 1);
  });
});

describe("credential cipher", () => {
  it("writes owner-key ciphertext and still reads instance-key ciphertext", async () => {
    const keyring = createCredentialKeyring({ provider: memoryProvider().provider, db, orgId: async () => "org-1" });
    const cipher = credentialCipher(instanceKey, keyring, true);
    const sealed = await cipher.encrypt(user, "token-1");
    expect(sealed.startsWith(OWNER_KEY_PREFIX)).toBe(true);
    expect(await cipher.decrypt(user, sealed)).toBe("token-1");
    expect(await cipher.decrypt(user, encryptSecret("legacy", instanceKey))).toBe("legacy");
    expect(cipher.isCurrent(sealed)).toBe(true);
    expect(cipher.isCurrent(encryptSecret("legacy", instanceKey))).toBe(false);
  });

  it("reads owner-key rows but writes instance-key rows when the setting is off", async () => {
    const keyring = createCredentialKeyring({ provider: memoryProvider().provider, db, orgId: async () => "org-1" });
    const writing = credentialCipher(instanceKey, keyring, true);
    const off = credentialCipher(instanceKey, keyring, false);
    const sealed = await writing.encrypt(user, "token-2");
    expect(await off.decrypt(user, sealed)).toBe("token-2");
    expect((await off.encrypt(user, "x")).startsWith(OWNER_KEY_PREFIX)).toBe(false);
    expect(off.isCurrent(sealed)).toBe(false);
  });

  it("names the fix when an owner-key row is read with no secret store", async () => {
    const keyring = createCredentialKeyring({ provider: memoryProvider().provider, db, orgId: async () => "org-1" });
    const sealed = await credentialCipher(instanceKey, keyring, true).encrypt(user, "t");
    await expect(credentialCipher(instanceKey).decrypt(user, sealed)).rejects.toThrow(/Set VALET_SECRET_STORE/);
  });
});

describe("PgCredentialStore with owner keys", () => {
  it("stores tokens under the owner's key and moves an instance-key row as it reads it", async () => {
    const fake = memoryProvider();
    const keyring = createCredentialKeyring({ provider: fake.provider, db, orgId: async () => "org-1" });
    const legacyStore = new PgCredentialStore(pg, instanceKey);
    await legacyStore.save(user, "linear", { type: "oauth2", accessToken: "at-1", refreshToken: "rt-1", expiresAt: 5 });
    const raw = async () =>
      (await pg.query(`SELECT access_token_enc, refresh_token_enc FROM credentials WHERE owner_id = 'u1' AND service = 'linear'`)).rows[0] as {
        access_token_enc: string;
        refresh_token_enc: string;
      };
    expect((await raw()).access_token_enc.startsWith(OWNER_KEY_PREFIX)).toBe(false);

    const store = new PgCredentialStore(pg, instanceKey);
    store.useCipher(credentialCipher(instanceKey, keyring, true));
    expect(await store.get(user, "linear")).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });
    // The rewrite runs after the read returns.
    await new Promise((r) => setTimeout(r, 50));
    const moved = await raw();
    expect(moved.access_token_enc.startsWith(OWNER_KEY_PREFIX)).toBe(true);
    expect(() => decryptSecret(moved.access_token_enc, instanceKey)).toThrow();
    expect(await store.get(user, "linear")).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });

    await store.save(user, "slack", { type: "oauth2", accessToken: "at-2" });
    const slack = (await pg.query(`SELECT access_token_enc FROM credentials WHERE owner_id = 'u1' AND service = 'slack'`)).rows[0] as {
      access_token_enc: string;
    };
    expect(slack.access_token_enc.startsWith(OWNER_KEY_PREFIX)).toBe(true);
  });
});
