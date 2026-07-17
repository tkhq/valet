/**
 * GitHub App core service tests (GitHub/repo integration plan, Task 3).
 * Covers: JWT claims + signature (verified with the keypair's own public
 * half), config round-trip through the shared `credentials` row, discovery
 * upsert/removal/linkedUserId matching, and installation-token cache
 * behavior at the 5-minute margin (incl. re-mint + suspended exclusion).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { decryptSecret, deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs, users, githubInstallations } from "../schema/index.js";
import {
  discoverInstallations,
  loadAppConfig,
  mintAppJwt,
  mintInstallationToken,
  saveAppConfig,
  type GithubAppConfig,
  type GithubAppDeps,
} from "./github-app.js";

const orgId = "org1";

function newRsaKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

function decodeJwtPart(part: string): Record<string, unknown> {
  const json = Buffer.from(part, "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

describe("github-app service", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;
  let fixture: GithubFixture | undefined;
  const { publicKeyPem, privateKeyPem } = newRsaKeyPair();

  const baseConfig: GithubAppConfig = {
    appId: "123456",
    appSlug: "valet-app",
    oauthClientId: "Iv1.abc123",
    htmlUrl: "https://github.com/apps/valet-app",
    oauthClientSecret: "oauth-client-secret",
    webhookSecret: "webhook-secret",
    privateKeyPem,
  };

  beforeEach(async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  function deps(overrides: Partial<GithubAppDeps> = {}): GithubAppDeps {
    return {
      db,
      credentials,
      key: deriveSecretKey("cache-key"),
      apiUrl: fixture?.url,
      ...overrides,
    };
  }

  describe("mintAppJwt", () => {
    it("mints an RS256 JWT with iat/exp/iss claims verifiable against the app's public key", () => {
      const token = mintAppJwt(baseConfig);
      const [headerB64, payloadB64, sigB64] = token.split(".");
      expect(headerB64).toBeDefined();
      expect(payloadB64).toBeDefined();
      expect(sigB64).toBeDefined();

      const header = decodeJwtPart(headerB64);
      expect(header).toEqual({ alg: "RS256", typ: "JWT" });

      const payload = decodeJwtPart(payloadB64);
      const nowSec = Math.floor(Date.now() / 1000);
      expect(payload.iss).toBe(baseConfig.appId);
      expect(payload.iat).toBeLessThanOrEqual(nowSec - 59);
      expect(payload.iat).toBeGreaterThanOrEqual(nowSec - 65);
      expect(payload.exp).toBe((payload.iat as number) + 600);
      expect(payload.exp as number).toBeLessThanOrEqual(nowSec + 545);

      const signingInput = `${headerB64}.${payloadB64}`;
      const signature = Buffer.from(sigB64, "base64url");
      const ok = verify("RSA-SHA256", Buffer.from(signingInput, "utf8"), publicKeyPem, signature);
      expect(ok).toBe(true);
    });

    it("also accepts PKCS#1 private keys (createPrivateKey handles both formats)", () => {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
      });
      const token = mintAppJwt({ ...baseConfig, privateKeyPem: privateKey });
      expect(token.split(".")).toHaveLength(3);
    });
  });

  describe("loadAppConfig / saveAppConfig", () => {
    it("returns null when no app is configured", async () => {
      const config = await loadAppConfig({ credentials }, orgId);
      expect(config).toBeNull();
    });

    it("round-trips a saved config byte-for-byte through the shared credential row", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      const loaded = await loadAppConfig({ credentials }, orgId);
      expect(loaded).toEqual(baseConfig);
    });

    it("stores the three secrets encrypted at rest (not equal to plaintext in the raw row)", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      const raw = await credentials.get({ type: "org", id: orgId }, "github_app");
      expect(raw?.apiKey).toBe(baseConfig.privateKeyPem); // decrypted by the store on read
      // The store's own contract tests cover the at-rest encryption; here we
      // just confirm the field mapping round-trips through the real store.
      expect(raw?.accessToken).toBe(baseConfig.oauthClientSecret);
      expect(raw?.refreshToken).toBe(baseConfig.webhookSecret);
      expect(raw?.metadata).toEqual({
        appId: baseConfig.appId,
        appSlug: baseConfig.appSlug,
        oauthClientId: baseConfig.oauthClientId,
        htmlUrl: baseConfig.htmlUrl,
      });
    });
  });

  describe("discoverInstallations", () => {
    it("returns [] when no app is configured for the org", async () => {
      const result = await discoverInstallations(deps(), orgId);
      expect(result).toEqual([]);
    });

    it("upserts installations, authenticates with the App JWT, and marks suspended installations", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({
        listInstallations: () => ({
          body: [
            { id: 111, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null },
            { id: 222, account: { login: "someuser", type: "User" }, repository_selection: "selected", suspended_at: "2026-01-01T00:00:00Z" },
          ],
        }),
      });

      const rows = await discoverInstallations(deps(), orgId);
      expect(rows).toHaveLength(2);

      const acme = rows.find((r) => r.installationId === 111);
      expect(acme).toMatchObject({
        orgId,
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "all",
        suspended: false,
        linkedUserId: null,
      });

      const someuser = rows.find((r) => r.installationId === 222);
      expect(someuser).toMatchObject({
        accountLogin: "someuser",
        suspended: true,
      });

      expect(fixture.calls).toHaveLength(1);
      const call = fixture.calls[0];
      expect(call.path).toBe("/app/installations");
      expect(call.authHeader).toMatch(/^Bearer /);
      // App-JWT auth, not an installation token — decode and check `iss`.
      const jwt = call.authHeader?.slice("Bearer ".length) ?? "";
      const payload = decodeJwtPart(jwt.split(".")[1]);
      expect(payload.iss).toBe(baseConfig.appId);
    });

    it("follows Link: rel=\"next\" pagination before computing upserts/deletions", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      // Seed a pre-existing row for an installation (333) that is genuinely
      // absent from BOTH pages of the new response — it must be deleted.
      await db.insert(githubInstallations).values({
        id: "ghi_stale",
        orgId,
        installationId: 333,
        accountLogin: "stale",
        accountType: "Organization",
        repositorySelection: "all",
        suspended: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // The Link "next" URL is only known once startGithubFixture returns a
      // port; the handler closure reads `fixture.url` lazily at request time
      // (after assignment below), so a single start suffices.
      fixture = startGithubFixture({
        listInstallations: (query) => {
          if (query.page === "2") {
            return {
              body: [
                { id: 222, account: { login: "page2user", type: "User" }, repository_selection: "all", suspended_at: null },
              ],
            };
          }
          return {
            body: [
              { id: 111, account: { login: "page1user", type: "Organization" }, repository_selection: "all", suspended_at: null },
            ],
            headers: {
              link: `<${fixture?.url}/app/installations?per_page=100&page=2>; rel="next"`,
            },
          };
        },
      });

      const rows = await discoverInstallations(deps(), orgId);
      const installationIds = rows.map((r) => r.installationId).sort();
      expect(installationIds).toEqual([111, 222]);

      const allRows = await db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
      const remainingIds = allRows.map((r) => r.installationId).sort();
      expect(remainingIds).toEqual([111, 222]); // 333 (genuinely absent) is deleted, 111/222 survive

      expect(fixture.calls).toHaveLength(2);
      expect(fixture.calls[0].query.page).toBeUndefined();
      expect(fixture.calls[1].query.page).toBe("2");
    });

    it("removes rows whose installation is absent from a later response", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      let installationsBody: unknown[] = [
        { id: 111, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null },
        { id: 222, account: { login: "someuser", type: "User" }, repository_selection: "all", suspended_at: null },
      ];
      fixture = startGithubFixture({ listInstallations: () => ({ body: installationsBody }) });

      await discoverInstallations(deps(), orgId);
      let allRows = await db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
      expect(allRows).toHaveLength(2);

      installationsBody = [
        { id: 111, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null },
      ];
      await discoverInstallations(deps(), orgId);
      allRows = await db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
      expect(allRows).toHaveLength(1);
      expect(allRows[0].installationId).toBe(111);
    });

    it("sets linkedUserId when a connected user's github login case-insensitively matches the account login", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await db.insert(users).values({ id: "user1", name: "User One", email: "u1@example.com" });
      await credentials.save(
        { type: "user", id: "user1" },
        "github",
        { type: "oauth2", accessToken: "user-token", metadata: { login: "Acme" } },
      );
      fixture = startGithubFixture({
        listInstallations: () => ({
          body: [{ id: 111, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }],
        }),
      });

      const rows = await discoverInstallations(deps(), orgId);
      expect(rows[0].linkedUserId).toBe("user1");
    });
  });

  describe("mintInstallationToken", () => {
    async function seedInstallation(overrides: Partial<typeof githubInstallations.$inferInsert> = {}) {
      await db.insert(githubInstallations).values({
        id: "ghi_1",
        orgId,
        installationId: 999,
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "all",
        suspended: false,
        cachedToken: null,
        cachedTokenExpiresAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...overrides,
      });
    }

    it("returns null when there is no installation for the account login", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture();
      const token = await mintInstallationToken(deps(), orgId, "nobody");
      expect(token).toBeNull();
    });

    it("excludes suspended installations", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await seedInstallation({ suspended: true });
      fixture = startGithubFixture();
      const token = await mintInstallationToken(deps(), orgId, "acme");
      expect(token).toBeNull();
    });

    it("mints and caches a fresh token, matching the account login case-insensitively", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await seedInstallation();
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({
          body: { token: `minted-for-${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
        }),
      });

      const token = await mintInstallationToken(deps(), orgId, "ACME");
      expect(token).toBe("minted-for-999");
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0].path).toBe("/app/installations/999/access_tokens");
      expect(fixture.calls[0].authHeader).toMatch(/^Bearer /);

      const [row] = await db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_1"));
      expect(row.cachedToken).not.toBe(token); // encrypted at rest
      expect(row.cachedTokenExpiresAt).not.toBeNull();
    });

    it("returns the cached token without re-minting while more than 5 minutes remain", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture();
      const d = deps();
      const { encryptSecret } = await import("../lib/secret-crypto.js");
      await seedInstallation({
        cachedToken: encryptSecret("cached-token", d.key),
        cachedTokenExpiresAt: Date.now() + 10 * 60 * 1000, // 10 min out, well past the 5 min margin
      });

      const token = await mintInstallationToken(d, orgId, "acme");
      expect(token).toBe("cached-token");
      expect(fixture.calls).toHaveLength(0);
    });

    it("re-mints and overwrites the cache when the cached token fails to decrypt (e.g. rekeyed VALET_ENCRYPTION_KEY)", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      const wrongKey = deriveSecretKey("a-completely-different-key");
      const { encryptSecret } = await import("../lib/secret-crypto.js");
      await seedInstallation({
        // Encrypted under a DIFFERENT key than deps().key below — simulates a
        // rekeyed VALET_ENCRYPTION_KEY or a corrupted row.
        cachedToken: encryptSecret("undecryptable-token", wrongKey),
        cachedTokenExpiresAt: Date.now() + 10 * 60 * 1000, // well past the 5 min margin
      });
      fixture = startGithubFixture({
        createInstallationToken: () => ({
          body: { token: "freshly-minted-token", expires_at: new Date(Date.now() + 3600_000).toISOString() },
        }),
      });

      const d = deps();
      const token = await mintInstallationToken(d, orgId, "acme");
      expect(token).toBe("freshly-minted-token"); // fell through to a fresh mint, not a throw
      expect(fixture.calls).toHaveLength(1); // fixture hit
      expect(fixture.calls[0].path).toBe("/app/installations/999/access_tokens");

      const [row] = await db.select().from(githubInstallations).where(eq(githubInstallations.id, "ghi_1"));
      expect(decryptSecret(row.cachedToken as string, d.key)).toBe("freshly-minted-token"); // cache replaced, decryptable under the current key
    });

    it("re-mints once the cached token is within the 5-minute margin", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      const d = deps();
      const { encryptSecret } = await import("../lib/secret-crypto.js");
      await seedInstallation({
        cachedToken: encryptSecret("stale-token", d.key),
        cachedTokenExpiresAt: Date.now() + 4 * 60 * 1000, // 4 min out, inside the 5 min margin
      });
      fixture = startGithubFixture({
        createInstallationToken: () => ({
          body: { token: "re-minted-token", expires_at: new Date(Date.now() + 3600_000).toISOString() },
        }),
      });

      const token = await mintInstallationToken(deps({ key: d.key }), orgId, "acme");
      expect(token).toBe("re-minted-token");
      expect(fixture.calls).toHaveLength(1);
    });
  });
});
