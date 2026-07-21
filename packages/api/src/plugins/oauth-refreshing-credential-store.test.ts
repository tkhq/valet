import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { CredentialStore, CredentialOwner, StoredCredential, ValetPlugin } from "@valet/engine";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-helpers/oauth-fixture.js";
import { mcpOauthClients } from "../schema/index.js";
import { OAuthRefreshingCredentialStore } from "./oauth-refreshing-credential-store.js";

const OWNER: CredentialOwner = { type: "user", id: "u1" };
const NOW = 1_800_000_000_000;

function memoryStore(): CredentialStore & { rows: Map<string, StoredCredential> } {
  const rows = new Map<string, StoredCredential>();
  return {
    rows,
    async get(owner, service) {
      return rows.get(`${owner.type}:${owner.id}:${service}`) ?? null;
    },
    async save(owner, service, credential) {
      rows.set(`${owner.type}:${owner.id}:${service}`, credential);
    },
    async delete(owner, service) {
      rows.delete(`${owner.type}:${owner.id}:${service}`);
    },
    async list() {
      return [];
    },
  };
}

let fake: FakeOAuthServer;
let testDb: TestPgDb;
beforeEach(async () => {
  fake = await startFakeOAuthServer();
  testDb = await freshTestPgDb();
});
afterEach(async () => {
  await fake.close();
  await testDb.cleanup();
});

function mcpPlugins(): ValetPlugin[] {
  return [
    {
      name: "linear",
      version: "0.1.0",
      credentials: [{ type: "oauth2", configKeys: ["accessToken"], oauth: { mode: "mcp", serverUrl: fake.url } }],
    },
  ];
}

function authCodePlugins(): ValetPlugin[] {
  return [
    {
      name: "widget",
      version: "0.1.0",
      credentials: [
        {
          type: "oauth2",
          configKeys: ["accessToken"],
          oauth: {
            mode: "authorization_code",
            authorizationUrl: `${fake.url}/authorize`,
            tokenUrl: `${fake.url}/token`,
            clientIdEnv: "X_ID",
            clientSecretEnv: "X_SECRET",
          },
        },
      ],
    },
  ];
}

async function seedMcpClient(): Promise<void> {
  await testDb.appDb.insert(mcpOauthClients).values({
    service: "linear",
    clientId: "client-1",
    authorizationEndpoint: `${fake.url}/authorize`,
    tokenEndpoint: `${fake.url}/token`,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe("OAuthRefreshingCredentialStore", () => {
  it("returns non-expiring credentials untouched", async () => {
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "fresh", refreshToken: "rt", expiresAt: NOW + 3_600_000 });
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
    const got = await store.get(OWNER, "linear");
    expect(got?.accessToken).toBe("fresh");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("refreshes an mcp credential expiring within 60s and persists the new tokens", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "stale", refreshToken: "rt-old", expiresAt: NOW + 30_000 });
    fake.tokenResponse = { access_token: "at-new", expires_in: 3600 }; // no refresh_token in response
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });

    const got = await store.get(OWNER, "linear");
    expect(got?.accessToken).toBe("at-new");
    expect(got?.refreshToken).toBe("rt-old"); // preserved when response omits one
    expect(got?.expiresAt).toBe(NOW + 3_600_000);
    expect(fake.tokenRequests[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-old", client_id: "client-1" });
    expect((await inner.get(OWNER, "linear"))?.accessToken).toBe("at-new"); // persisted
  });

  it("stamps metadata.refreshFailedAt and returns the stored credential on refresh failure", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "stale", refreshToken: "rt", expiresAt: NOW + 30_000 });
    fake.tokenFailure = 400;
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });

    const got = await store.get(OWNER, "linear");
    expect(got?.accessToken).toBe("stale");
    const persisted = await inner.get(OWNER, "linear");
    expect(persisted?.metadata?.refreshFailedAt).toBe(NOW);
  });

  it("never refreshes github (excluded service)", async () => {
    const inner = memoryStore();
    await inner.save(OWNER, "github", { type: "oauth2", accessToken: "gh", refreshToken: "rt", expiresAt: NOW + 1_000 });
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
    const got = await store.get(OWNER, "github");
    expect(got?.accessToken).toBe("gh");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("skips credentials without a refreshToken or without expiresAt", async () => {
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "no-rt", expiresAt: NOW + 1_000 });
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
    expect((await store.get(OWNER, "linear"))?.accessToken).toBe("no-rt");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("refreshes an authorization_code credential using client id/secret from env", async () => {
    const inner = memoryStore();
    await inner.save(OWNER, "widget", { type: "oauth2", accessToken: "stale", refreshToken: "rt-ac", expiresAt: NOW + 30_000 });
    fake.tokenResponse = { access_token: "at-ac-new", refresh_token: "rt-ac-new", expires_in: 3600 };
    const store = new OAuthRefreshingCredentialStore(inner, {
      db: testDb.appDb,
      plugins: authCodePlugins(),
      env: { X_ID: "cid", X_SECRET: "shh" },
      now: () => NOW,
    });

    const got = await store.get(OWNER, "widget");
    expect(got?.accessToken).toBe("at-ac-new");
    expect(got?.refreshToken).toBe("rt-ac-new");
    expect(fake.tokenRequests[0]).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-ac",
      client_id: "cid",
      client_secret: "shh",
    });
  });
});
