import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CredentialStore, CredentialOwner, StoredCredential, ValetPlugin } from "@valet/engine";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-helpers/oauth-fixture.js";
import { mcpOauthClients } from "../schema/index.js";
import { isUnusableOAuthCredential } from "../services/credential-resolution.js";
import { PgCredentialStore } from "./credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import type { PgQueryable } from "@valet/store-postgres";
import { OAuthRefreshingCredentialStore, refreshErrorText } from "./oauth-refreshing-credential-store.js";

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
    async compareAndSwap(owner, service, expected, next) {
      if (rows.get(`${owner.type}:${owner.id}:${service}`) !== expected) return false;
      rows.set(`${owner.type}:${owner.id}:${service}`, next);
      return true;
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
  it("refreshes a team token without changing the same service on a personal account", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    const team: CredentialOwner = { type: "team", id: "team-1" };
    await inner.save(team, "linear", { type: "oauth2", accessToken: "team-old", refreshToken: "team-refresh", expiresAt: NOW });
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "personal", expiresAt: NOW + 3_600_000 });
    fake.tokenResponse = { access_token: "team-new", refresh_token: "team-rotated", expires_in: 3600 };
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
    expect(await store.get(team, "linear")).toMatchObject({ accessToken: "team-new", refreshToken: "team-rotated" });
    expect(fake.tokenRequests[0]).toMatchObject({ refresh_token: "team-refresh" });
    expect(await inner.get(OWNER, "linear")).toMatchObject({ accessToken: "personal" });
  });

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

  it("stamps metadata.refreshFailedAt and returns the stamped credential on refresh failure", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "stale", refreshToken: "rt", expiresAt: NOW + 30_000 });
    fake.tokenFailure = 400;
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });

    const got = await store.get(OWNER, "linear");
    expect(got?.accessToken).toBe("stale");
    // The caller sees the failure on this read, not only the next one.
    expect(got?.metadata?.refreshFailedAt).toBe(NOW);
    const persisted = await inner.get(OWNER, "linear");
    expect(persisted?.metadata?.refreshFailedAt).toBe(NOW);
    // A 400 from the token endpoint is a refusal: the row can be replaced.
    expect(persisted?.metadata?.refreshRefused).toBe(true);
  });

  it("keeps the provider's refusal text with the tokens masked", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "at-secret", refreshToken: "rt-secret", expiresAt: NOW - 1 });
    fake.tokenFailure = 400;
    // Greenhouse echoes a malformed refresh token back in its message.
    fake.tokenFailureBody = { message: "refresh_token=rt-secret does not contain a valid client ID suffix" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });

    const got = await store.get(OWNER, "linear");
    const persisted = await inner.get(OWNER, "linear");
    expect(persisted?.metadata?.refreshError).toBe(
      'MCP PKCE token refresh failed: 400 {"message":"refresh_token=[redacted] does not contain a valid client ID suffix"}',
    );
    expect(got?.metadata?.refreshError).toBe(persisted?.metadata?.refreshError);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("rt-secret");
    errors.mockRestore();
  });

  it("clears the failure stamps after a good refresh", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    await inner.save(OWNER, "linear", {
      type: "oauth2", accessToken: "stale", refreshToken: "rt", expiresAt: NOW - 1,
      metadata: { refreshFailedAt: NOW - 1000, refreshRefused: true, refreshError: "400 invalid_grant" },
    });
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
    await store.get(OWNER, "linear");
    expect((await inner.get(OWNER, "linear"))?.metadata).toBeUndefined();
  });

  it("masks token fields in form and JSON shapes and caps the length", () => {
    expect(refreshErrorText(new Error("bad: access_token=abc&code=xyz"), [])).toBe("bad: access_token=[redacted]&code=[redacted]");
    expect(refreshErrorText(new Error('{"refresh_token": "abc", "error": "invalid_grant"}'), []))
      .toBe('{"refresh_token": "[redacted]", "error": "invalid_grant"}');
    expect(refreshErrorText(new Error(`token sk-1 leaked`), ["sk-1", undefined])).toBe("token [redacted] leaked");
    expect(refreshErrorText(new Error("x".repeat(400)), [])).toHaveLength(301);
    // An escaped JSON message, and a value with no closing quote.
    expect(refreshErrorText(new Error('{"message":"bad client_secret=\\"abc12345\\""}'), [])).toBe('{"message":"bad client_secret=\\"[redacted]"}');
    expect(refreshErrorText(new Error('400 {"access_token":"abcdefgh12345'), [])).toBe('400 {"access_token":"[redacted]');
    // A cut-off start of a known secret at the end of the text.
    expect(refreshErrorText(new Error("failed: tok-12345678"), ["tok-1234567890abcdef"])).toBe("failed: [redacted]");
    // Escaped, cut-off and URL-encoded echoes of a known secret.
    const secret = "AbC/def+GhI/jkl0123456789xyzQRS=";
    expect(refreshErrorText(new Error('{"refresh_token":"AbC\\/def+GhI\\/jkl0123456789xyzQRS="}'), [secret])).toBe('{"refresh_token":"[redacted]"}');
    expect(refreshErrorText(new Error("Invalid client secret 'AbC\\/def+GhI\\/jkl0123456789xyzQRS='"), [secret])).toBe("Invalid client secret '[redacted]'");
    expect(refreshErrorText(new Error('400 {"error":"bad","hint":"AbC\\/def+GhI\\/jkl01'), [secret])).toBe('400 {"error":"bad","hint":"[redacted]');
    expect(refreshErrorText(new Error(`unknown token ${encodeURIComponent(secret)}`), [secret])).toBe("unknown token [redacted]");
    // An unknown escaped value in a token field.
    expect(refreshErrorText(new Error('{"refresh_token":"Zz\\/yy\\/xx12345"}'), [])).toBe('{"refresh_token":"[redacted]"}');
    // Prose that only mentions a code stays readable.
    expect(refreshErrorText(new Error("error code: invalid_grant"), [])).toBe("error code: invalid_grant");
  });

  it("masks the app's client secret that an authorization_code refusal echoes", async () => {
    const inner = memoryStore();
    await inner.save(OWNER, "widget", { type: "oauth2", accessToken: "at", refreshToken: "rt-widget", expiresAt: NOW - 1 });
    fake.tokenFailure = 401;
    fake.tokenFailureBody = { message: "Invalid client secret 'shared-app-secret-123'" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new OAuthRefreshingCredentialStore(inner, {
      db: testDb.appDb, plugins: authCodePlugins(), env: { X_ID: "cid", X_SECRET: "shared-app-secret-123" }, now: () => NOW,
    });
    await store.get(OWNER, "widget");
    const reason = (await inner.get(OWNER, "widget"))?.metadata?.refreshError;
    expect(reason).toContain("Invalid client secret '[redacted]'");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("shared-app-secret-123");
    errors.mockRestore();
  });

  it("masks a long refresh token that the 200-character error cap cuts off", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    const longToken = `rt-${"a1b2c3d4".repeat(33)}`;
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "at", refreshToken: longToken, expiresAt: NOW - 1 });
    fake.tokenFailure = 400;
    fake.tokenFailureBody = { refresh_token: longToken };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
    await store.get(OWNER, "linear");
    const reason = (await inner.get(OWNER, "linear"))?.metadata?.refreshError;
    expect(reason).toBe('MCP PKCE token refresh failed: 400 {"refresh_token":"[redacted]');
    vi.restoreAllMocks();
  });

  it("keeps no provider reply for an error that is not the token endpoint's answer", async () => {
    const inner = memoryStore();
    await inner.save(OWNER, "widget", { type: "oauth2", accessToken: "at", refreshToken: "rt", expiresAt: NOW - 1 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    // No client id or secret in env: the refresh throws before any request.
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: authCodePlugins(), env: {}, now: () => NOW });
    await store.get(OWNER, "widget");
    const persisted = await inner.get(OWNER, "widget");
    expect(persisted?.metadata?.refreshFailedAt).toBe(NOW);
    expect(persisted?.metadata?.refreshError).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("does not mark a temporary refresh failure as a refusal", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "stale", refreshToken: "rt", expiresAt: NOW - 1 });
    fake.tokenFailure = 503;
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
    await store.get(OWNER, "linear");
    const persisted = await inner.get(OWNER, "linear");
    expect(persisted?.metadata?.refreshFailedAt).toBe(NOW);
    expect(persisted?.metadata?.refreshRefused).toBeUndefined();
  });

  it("keeps a reconnect that lands while a refresh is in flight", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "dead", refreshToken: "dead-rt", expiresAt: NOW - 1 });
    fake.tokenFailure = 400;
    const reconnected: StoredCredential = { type: "oauth2", accessToken: "new", refreshToken: "new-rt", expiresAt: NOW + 3_600_000 };
    const actualFetch = globalThis.fetch;
    const tokenCall = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/token")) await inner.save(OWNER, "linear", reconnected);
      return actualFetch(input, init);
    });
    try {
      const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
      expect(await store.get(OWNER, "linear")).toMatchObject({ accessToken: "new" });
      expect(await inner.get(OWNER, "linear")).toEqual(reconnected);
    } finally {
      tokenCall.mockRestore();
    }
  });

  for (const mutation of ["reconnect", "delete"] as const) {
    for (const refused of [false, true]) {
      it(`does not ${mutation === "delete" ? "resurrect a deletion" : "overwrite a reconnect"} between the final read and ${refused ? "failure stamp" : "refresh save"}`, async () => {
        await seedMcpClient();
        const normal = new PgCredentialStore(testDb.pgdb, deriveSecretKey("race-key"));
        await normal.save(OWNER, "linear", { type: "oauth2", accessToken: "old", refreshToken: "old-rt", expiresAt: NOW - 1 });
        const replacement: StoredCredential = { type: "oauth2", accessToken: "reconnected", refreshToken: "new-rt", expiresAt: NOW + 3_600_000, metadata: { login: "new-user" } };
        let reads = 0;
        const interleaved: PgQueryable = {
          async query(sql, params) {
            const result = await testDb.pgdb.query(sql, params);
            if (sql.startsWith("SELECT * FROM credentials") && ++reads === 3) {
              if (mutation === "delete") await normal.delete(OWNER, "linear");
              else await normal.save(OWNER, "linear", replacement);
            }
            return result;
          },
        };
        fake.tokenFailure = refused ? 400 : undefined;
        fake.tokenResponse = { access_token: "refreshed-old-grant", expires_in: 3600 };
        const store = new OAuthRefreshingCredentialStore(new PgCredentialStore(interleaved, deriveSecretKey("race-key")), {
          db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW,
        });
        const got = await store.get(OWNER, "linear");
        expect(reads).toBeGreaterThanOrEqual(3);
        if (mutation === "delete") {
          expect(got).toBeNull();
          expect(await normal.get(OWNER, "linear")).toBeNull();
        } else {
          expect(got).toMatchObject(replacement);
          expect(await normal.get(OWNER, "linear")).toMatchObject(replacement);
        }
      });
    }
  }

  it("treats an empty refresh token returned by the provider as unusable after expiry", async () => {
    await seedMcpClient();
    const inner = new PgCredentialStore(testDb.pgdb, deriveSecretKey("empty-token"));
    const team: CredentialOwner = { type: "team", id: "team-empty-token" };
    await inner.save(team, "linear", { type: "oauth2", accessToken: "old", refreshToken: "old-rt", expiresAt: NOW });
    fake.tokenResponse = { access_token: "short-lived", refresh_token: "", expires_in: 1 };
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });
    const fresh = await store.get(team, "linear");
    expect(fresh?.refreshToken).toBe("");
    if (!fresh) throw new Error("Missing refreshed credential");
    expect(isUnusableOAuthCredential(fresh, NOW + 1000)).toBe(true);
    const persisted = await inner.get(team, "linear");
    if (!persisted) throw new Error("Missing persisted credential");
    expect(isUnusableOAuthCredential(persisted, NOW + 1000)).toBe(true);
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

  it("concurrent gets of the same near-expiry credential refresh once", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "stale", refreshToken: "rt-old", expiresAt: NOW + 30_000 });
    fake.tokenResponse = { access_token: "at-new", expires_in: 3600 };
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });

    const [a, b] = await Promise.all([store.get(OWNER, "linear"), store.get(OWNER, "linear")]);
    expect(a?.accessToken).toBe("at-new");
    expect(b?.accessToken).toBe("at-new");
    expect(fake.tokenRequests).toHaveLength(1);
  });

  it("a second get after a completed refresh does not refresh again", async () => {
    await seedMcpClient();
    const inner = memoryStore();
    await inner.save(OWNER, "linear", { type: "oauth2", accessToken: "stale", refreshToken: "rt-old", expiresAt: NOW + 30_000 });
    fake.tokenResponse = { access_token: "at-new", expires_in: 3600 };
    const store = new OAuthRefreshingCredentialStore(inner, { db: testDb.appDb, plugins: mcpPlugins(), env: {}, now: () => NOW });

    await store.get(OWNER, "linear");
    expect(fake.tokenRequests).toHaveLength(1);
    const second = await store.get(OWNER, "linear");
    expect(second?.accessToken).toBe("at-new");
    expect(fake.tokenRequests).toHaveLength(1);
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
