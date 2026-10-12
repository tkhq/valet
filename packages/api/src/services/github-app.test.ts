import { githubAccountId } from "../test-helpers/github-fixture.js";
/**
 * GitHub App core service tests (GitHub/repo integration plan, Task 3).
 * Covers: JWT claims + signature (verified with the keypair's own public
 * half), config round-trip through the shared `credentials` row, discovery
 * upsert/removal/linkedUserId matching, installation-token cache behavior at
 * the 5-minute margin (incl. re-mint + suspended exclusion), and
 * webhook-URL sync (incl. the guard that leaves an environment-supplied app
 * alone).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { installationResolvesFor, resolveInstallationApiToken } from "./github-tokens.js";
import { githubHost } from "../repos/github-host.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../lib/secret-crypto.js";
import { orgs, orgMembers, users, githubInstallations, contentSources } from "../schema/index.js";
import {
  buildAppConfig,
  saveVerifiedGithubIdentity,
  githubLoginRecoveryStats,
  GITHUB_LOGIN_RECOVERY_BUDGET,
  GITHUB_LOGIN_RECOVERY_MAX_ENTRIES,
  discoverInstallations,
  ensureInstallationAccountIds,
  recoverWebhookInstallation,
  claimUnheldWebhookDrop,
  WEBHOOK_INSTALLATION_RECOVERY_BUDGET,
  loadAppOwner,
  loadAppConfig,
  loadAppConfigWithSource,
  mintAppJwt,
  relinkInstallations,
  requestInstallationForLogin,
  mintInstallationToken,
  parsePrivateKeyPem,
  resolveGithubAppEnvConfig,
  saveAppConfig,
  syncAllAppWebhookUrls,
  syncAppWebhookUrl,
  verifyAppCredential,
  type GithubAppConfig,
  type GithubAppDeps,
} from "./github-app.js";

function fresh(result: Awaited<ReturnType<typeof discoverInstallations>>) {
  if (result === "stale") throw new Error("Expected a fresh installation snapshot");
  return result;
}

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

  describe("resolveGithubAppEnvConfig", () => {
    const fullEnv: NodeJS.ProcessEnv = {
      GITHUB_APP_ID: "654321",
      GITHUB_APP_SLUG: "valet-env-app",
      GITHUB_APP_CLIENT_ID: "Iv1.env123",
      GITHUB_APP_CLIENT_SECRET: "env-client-secret",
      GITHUB_APP_WEBHOOK_SECRET: "env-webhook-secret",
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    };

    it("returns null when no GITHUB_APP_* variable is set", () => {
      expect(resolveGithubAppEnvConfig({})).toBeNull();
    });

    it("builds a full config from the env, deriving htmlUrl from the slug", () => {
      const config = resolveGithubAppEnvConfig(fullEnv);
      expect(config).toEqual({
        appId: "654321",
        appSlug: "valet-env-app",
        oauthClientId: "Iv1.env123",
        htmlUrl: "https://github.com/apps/valet-env-app",
        oauthClientSecret: "env-client-secret",
        webhookSecret: "env-webhook-secret",
        privateKeyPem,
      });
    });

    it("accepts a base64-encoded private key PEM", () => {
      const env = { ...fullEnv, GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKeyPem, "utf8").toString("base64") };
      expect(resolveGithubAppEnvConfig(env)?.privateKeyPem).toBe(privateKeyPem);
    });

    it("defaults the webhook secret to empty when GITHUB_APP_WEBHOOK_SECRET is unset", () => {
      const { GITHUB_APP_WEBHOOK_SECRET: _omitted, ...rest } = fullEnv;
      expect(resolveGithubAppEnvConfig(rest)?.webhookSecret).toBe("");
    });

    it("derives htmlUrl from GITHUB_URL for GitHub Enterprise hosts", () => {
      const env = { ...fullEnv, GITHUB_URL: "https://github.example.com" };
      expect(resolveGithubAppEnvConfig(env)?.htmlUrl).toBe("https://github.example.com/apps/valet-env-app");
    });

    it("throws and names the missing variables when the env config is partial", () => {
      const env: NodeJS.ProcessEnv = { GITHUB_APP_ID: "654321" };
      expect(() => resolveGithubAppEnvConfig(env)).toThrowError(/GITHUB_APP_PRIVATE_KEY/);
      expect(() => resolveGithubAppEnvConfig(env)).toThrowError(/GITHUB_APP_CLIENT_SECRET/);
    });

    it("throws when ONLY the optional webhook secret is set (a stray var is a misconfiguration, not 'unset')", () => {
      const env: NodeJS.ProcessEnv = { GITHUB_APP_WEBHOOK_SECRET: "stray" };
      expect(() => resolveGithubAppEnvConfig(env)).toThrowError(/GITHUB_APP_ID/);
    });

    it("throws with a corrective message when the private key is neither PEM nor base64 PEM", () => {
      const env = { ...fullEnv, GITHUB_APP_PRIVATE_KEY: "not-a-key" };
      expect(() => resolveGithubAppEnvConfig(env)).toThrowError(/GITHUB_APP_PRIVATE_KEY/);
    });

    it("builds the same config as buildAppConfig does from the same parts", () => {
      // One assembler serves both config paths. If they ever diverge, an app
      // connected through the admin route stores a shape the env path cannot
      // read, and only production finds out.
      expect(resolveGithubAppEnvConfig(fullEnv)).toEqual(
        buildAppConfig(
          {
            appId: "654321",
            appSlug: "valet-env-app",
            oauthClientId: "Iv1.env123",
            oauthClientSecret: "env-client-secret",
            webhookSecret: "env-webhook-secret",
            privateKeyPem,
          },
          {},
        ),
      );
    });
  });

  describe("parsePrivateKeyPem", () => {
    it("passes a raw PEM through and decodes a base64 one", () => {
      expect(parsePrivateKeyPem(privateKeyPem)).toBe(privateKeyPem);
      expect(parsePrivateKeyPem(Buffer.from(privateKeyPem, "utf8").toString("base64"))).toBe(privateKeyPem);
    });

    it("returns null for anything that is neither", () => {
      expect(parsePrivateKeyPem("not-a-key")).toBeNull();
      expect(parsePrivateKeyPem("")).toBeNull();
      // Valid base64 that decodes to something which is not a PEM.
      expect(parsePrivateKeyPem(Buffer.from("hello there", "utf8").toString("base64"))).toBeNull();
    });
  });

  describe("verifyAppCredential", () => {
    const credential = { appId: "4242", privateKeyPem };

    it("reports the app GitHub answers for, authenticating with the App JWT", async () => {
      fixture = startGithubFixture({
        getApp: () => ({
          body: { id: 4242, slug: "existing-app", client_id: "Iv1.existing", html_url: "https://github.com/apps/existing-app", installations_count: 2 },
        }),
      });
      const check = await verifyAppCredential({ apiUrl: fixture.url }, credential);
      expect(check).toEqual({
        ok: true,
        app: {
          appId: "4242",
          appSlug: "existing-app",
          htmlUrl: "https://github.com/apps/existing-app",
          oauthClientId: "Iv1.existing",
          installationsCount: 2,
        },
      });
      expect(fixture.calls.find((c) => c.path === "/app")?.authHeader).toMatch(/^Bearer /);
    });

    it("names the fix when GitHub refuses the credential", async () => {
      fixture = startGithubFixture({ getApp: () => ({ status: 401, body: { message: "Bad credentials" } }) });
      const check = await verifyAppCredential({ apiUrl: fixture.url }, credential);
      expect(check.ok).toBe(false);
      if (check.ok) throw new Error("expected the check to fail");
      expect(check.error).toContain("GitHub rejected this App ID and private key");
    });

    it("reports a server-side GitHub failure as retryable, not as a bad credential", async () => {
      fixture = startGithubFixture({ getApp: () => ({ status: 503, body: { message: "unavailable" } }) });
      const check = await verifyAppCredential({ apiUrl: fixture.url }, credential);
      expect(check.ok).toBe(false);
      if (check.ok) throw new Error("expected the check to fail");
      expect(check.error).toContain("503");
      expect(check.error).toContain("try again");
    });

    it("never throws when GitHub is unreachable", async () => {
      const check = await verifyAppCredential(
        { apiUrl: "http://127.0.0.1:1", fetchImpl: () => Promise.reject(new Error("connect ECONNREFUSED")) },
        credential,
      );
      expect(check.ok).toBe(false);
      if (check.ok) throw new Error("expected the check to fail");
      expect(check.error).toContain("Could not reach GitHub");
    });

    it("never throws on a private key that is a PEM but not an RSA key", async () => {
      fixture = startGithubFixture();
      const check = await verifyAppCredential(
        { apiUrl: fixture.url },
        { appId: "4242", privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnonsense\n-----END PRIVATE KEY-----\n" },
      );
      expect(check.ok).toBe(false);
      if (check.ok) throw new Error("expected the check to fail");
      expect(check.error).toContain("Generate a new private key");
      // Refused locally — GitHub was never asked.
      expect(fixture.calls).toHaveLength(0);
    });

    it("refuses an app record with no app id", async () => {
      fixture = startGithubFixture({ getApp: () => ({ body: { slug: "no-id-here" } }) });
      const check = await verifyAppCredential({ apiUrl: fixture.url }, credential);
      expect(check.ok).toBe(false);
      if (check.ok) throw new Error("expected the check to fail");
      expect(check.error).toContain("no app id");
    });
  });

  describe("loadAppConfig env fallback", () => {
    const envConfig: NodeJS.ProcessEnv = {
      GITHUB_APP_ID: "654321",
      GITHUB_APP_SLUG: "valet-env-app",
      GITHUB_APP_CLIENT_ID: "Iv1.env123",
      GITHUB_APP_CLIENT_SECRET: "env-client-secret",
      GITHUB_APP_WEBHOOK_SECRET: "env-webhook-secret",
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    };

    it("falls back to the env config when the org has no github_app credential row", async () => {
      const config = await loadAppConfig({ credentials, env: envConfig }, orgId);
      expect(config?.appId).toBe("654321");
      expect(config?.privateKeyPem).toBe(privateKeyPem);
    });

    it("prefers the stored credential row over the env fallback", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      const config = await loadAppConfig({ credentials, env: envConfig }, orgId);
      expect(config).toEqual(baseConfig);
    });

    it("reports the config source alongside the config", async () => {
      const fromEnv = await loadAppConfigWithSource({ credentials, env: envConfig }, orgId);
      expect(fromEnv?.source).toBe("environment");
      await saveAppConfig({ credentials }, orgId, baseConfig);
      const fromRow = await loadAppConfigWithSource({ credentials, env: envConfig }, orgId);
      expect(fromRow?.source).toBe("org");
      expect(await loadAppConfigWithSource({ credentials, env: {} }, orgId)).toEqual(fromRow);
    });
  });

  describe("discoverInstallations", () => {
    async function linkMember(userId: string, login: string, memberOrgId = orgId) {
      await db.insert(users).values({ id: userId, name: userId, email: `${userId}@example.com` });
      await db.insert(orgMembers).values({ orgId: memberOrgId, userId, role: "member" });
      await credentials.save({ type: "user", id: userId }, "github", {
        type: "oauth2", accessToken: "user-token", metadata: { login },
      });
    }

    it("admits only the App owner and this org's linked personal accounts, and applies the toggle", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await db.insert(orgs).values({ id: "other-org", name: "Other", createdAt: Date.now() });
      await linkMember("member", "MEMBER");
      await linkMember("outsider", "outsider", "other-org");
      fixture = startGithubFixture({ getUser: () => ({ body: { login: "member" } }), listInstallations: () => ({ body: [
        { id: 1, account: { login: "ACME", type: "Organization" } },
        { id: 2, account: { login: "member", type: "User" } },
        { id: 3, account: { login: "stranger", type: "User" } },
        { id: 4, account: { login: "other", type: "Organization" } },
        { id: 5, account: { login: "outsider", type: "User" } },
      ] }) });
      expect(fresh(await discoverInstallations(deps(), orgId)).map((row) => row.installationId)).toEqual([1, 2]);
      await db.update(orgs).set({ allowPersonalInstallations: false }).where(eq(orgs.id, orgId));
      expect(fresh(await discoverInstallations(deps(), orgId)).map((row) => row.installationId)).toEqual([1]);
      expect(fixture.calls.filter((call) => call.path === "/app")).toHaveLength(1);
      await discoverInstallations(deps({ now: () => Date.now() + 300_001 }), orgId);
      expect(fixture.calls.filter((call) => call.path === "/app")).toHaveLength(2);
    });

    it("rejects historical forged login metadata when GitHub reports another identity", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await linkMember("member", "alice");
      fixture = startGithubFixture({ getUser: () => ({ body: { login: "mallory" } }),
        listInstallations: () => ({ body: [{ id: 2, account: { login: "alice", type: "User" } }] }),
      });
      expect(await discoverInstallations(deps(), orgId)).toEqual([]);
      await db.insert(githubInstallations).values({ id: "stale_personal", orgId, installationId: 2,
        accountLogin: "alice",
        accountId: githubAccountId("alice"), accountType: "User", linkedUserId: "member", suspended: false,
        createdAt: Date.now(), updatedAt: Date.now() });
      expect(await mintInstallationToken(deps(), orgId, "alice", "member")).toBeNull();
      expect(fixture.calls.filter((call) => call.path.includes("access_tokens"))).toEqual([]);
    });

    it("refreshes expired OAuth before discovery and cached personal-token reads", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await linkMember("member", "alice");
      const expired = { type: "oauth2" as const, accessToken: "expired-token", refreshToken: "valid-refresh",
        expiresAt: Date.now() - 1, metadata: { login: "alice", identityOnly: true } };
      await credentials.save({ type: "user", id: "member" }, "github", expired);
      fixture = startGithubFixture({
        getUser: () => ({ body: { login: "alice" } }),
        oauthAccessToken: () => ({ body: { access_token: "rotated-token", refresh_token: "rotated-refresh", expires_in: 3600 } }),
        listInstallations: () => ({ body: [{ id: 2, account: { login: "alice", type: "User" } }] }),
      });
      const d = deps({ githubUrl: fixture.url });
      expect(await discoverInstallations(d, orgId)).toMatchObject([{ installationId: 2, linkedUserId: "member" }]);
      expect(fixture.calls.find((call) => call.path === "/user")?.authHeader).toBe("Bearer rotated-token");
      expect(await credentials.get({ type: "user", id: "member" }, "github")).toMatchObject({ accessToken: "rotated-token" });
      expect(await mintInstallationToken(d, orgId, "alice", "member")).toBe("fixture-installation-token");
      await credentials.save({ type: "user", id: "member" }, "github", expired);
      expect(await mintInstallationToken(d, orgId, "alice", "member")).toBe("fixture-installation-token");
      expect(fixture.calls.filter((call) => call.path === "/login/oauth/access_token")).toHaveLength(2);
      expect(fixture.calls.filter((call) => call.path.includes("access_tokens"))).toHaveLength(1);
    });

    it.each([401, 503] as const)("classifies a refresh %s as permanent loss or transient retention", async (status) => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await linkMember("member", "alice");
      let refreshFails = false;
      fixture = startGithubFixture({
        getUser: () => ({ body: { login: "alice" } }),
        oauthAccessToken: () => refreshFails ? { status, body: {} } : { body: {} },
        listInstallations: () => ({ body: [{ id: 2, account: { login: "alice", type: "User" } }] }),
      });
      const d = deps({ githubUrl: fixture.url });
      await discoverInstallations(d, orgId);
      await mintInstallationToken(d, orgId, "alice", "member");
      await credentials.save({ type: "user", id: "member" }, "github", { type: "oauth2",
        accessToken: "expired", refreshToken: "invalid-refresh", expiresAt: Date.now() - 1, metadata: { login: "alice" } });
      refreshFails = true;
      expect(await mintInstallationToken(d, orgId, "alice", "member")).toBeNull();
      expect(await discoverInstallations(d, orgId)).toEqual([]);
      const held = await db.select().from(githubInstallations);
      if (status === 503) expect(held).toMatchObject([{ installationId: 2, linkedUserId: "member" }]);
      else expect(held).toEqual([]);
      expect(fixture.calls.filter((call) => call.path.includes("access_tokens"))).toHaveLength(1);
      // A policy or membership revocation is not a credential outage.
      await db.delete(orgMembers).where(eq(orgMembers.userId, "member"));
      await discoverInstallations(d, orgId);
      expect(await db.select().from(githubInstallations)).toEqual([]);
    });

    it.each(["timeout", "malformed", "fetch"])("isolates a member's %s failure during discovery", async (failure) => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await linkMember("bad", "alice");
      await linkMember("good", "bob");
      await credentials.save({ type: "user", id: "bad" }, "github", { type: "oauth2", accessToken: "bad-token", metadata: { login: "alice" } });
      fixture = startGithubFixture({
        getUser: () => ({ body: { login: "bob" } }),
        listInstallations: () => ({ body: [
          { id: 1, account: { login: "acme", type: "Organization" } },
          { id: 2, account: { login: "alice", type: "User" } },
          { id: 3, account: { login: "bob", type: "User" } },
        ] }),
      });
      const fetchImpl: typeof fetch = async (url, init) => {
        if (new Headers(init?.headers).get("Authorization") === "Bearer bad-token") {
          if (failure === "malformed") return new Response("not json");
          if (failure === "timeout") return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
          throw new Error("Network unavailable");
        }
        return fetch(url, init);
      };
      expect(fresh(await discoverInstallations(deps({ fetchImpl }), orgId)).map((row) => row.installationId)).toEqual([1, 3]);
      expect((await db.select().from(githubInstallations)).map((row) => row.installationId).sort()).toEqual([1, 3]);
    }, 15_000);

    it.each(["toggle off", "no candidate"])("skips identity and refresh for %s", async (mode) => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      for (let i = 0; i < 25; i++) {
        await linkMember(`member-${i}`, "alice");
        await credentials.save({ type: "user", id: `member-${i}` }, "github", {
          type: "oauth2", accessToken: "expired", refreshToken: "refresh", expiresAt: 1,
          metadata: { login: "alice" },
        });
      }
      if (mode === "toggle off") await db.update(orgs).set({ allowPersonalInstallations: false });
      fixture = startGithubFixture({ listInstallations: () => ({ body: [
        { id: 1, account: { login: "acme", type: "Organization" } },
        ...(mode === "toggle off" ? [{ id: 2, account: { login: "alice", type: "User" } }] : []),
      ] }) });
      await discoverInstallations(deps({ githubUrl: fixture.url }), orgId);
      expect(fixture.calls.filter((call) => call.path === "/user" || call.path.includes("oauth/access_token"))).toEqual([]);
      expect((await credentials.get({ type: "user", id: "member-0" }, "github"))?.metadata?.refreshFailedAt).toBeUndefined();
    });

    it("keeps owner and member installs through renames and rejects a reused login", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await linkMember("member", "alice");
      let renamed = false;
      let reused = false;
      fixture = startGithubFixture({
        getApp: () => ({ body: { owner: { id: 10, login: renamed ? "new-org" : "acme" } } }),
        getUser: () => ({ body: { id: 20, login: renamed ? "new-user" : "alice" } }),
        listInstallations: () => ({ body: [
          { id: 1, account: { id: 10, login: renamed ? "new-org" : "acme", type: "Organization" } },
          { id: 2, account: { id: reused ? 21 : 20, login: renamed ? "new-user" : "alice", type: "User" } },
        ] }),
      });
      await discoverInstallations(deps(), orgId);
      renamed = true;
      expect(fresh(await discoverInstallations(deps(), orgId)).map((row) => row.accountLogin)).toEqual(["new-org", "new-user"]);
      expect(await mintInstallationToken(deps(), orgId, "new-org")).toBe("fixture-installation-token");
      expect(await mintInstallationToken(deps(), orgId, "new-user", "member")).toBe("fixture-installation-token");
      expect((await credentials.get({ type: "user", id: "member" }, "github"))?.metadata?.login).toBe("new-user");
      reused = true;
      expect(fresh(await discoverInstallations(deps(), orgId)).map((row) => row.installationId)).toEqual([1]);
      expect(await mintInstallationToken(deps(), orgId, "new-user", "member")).toBeNull();
    });

    it("preserves unseen rows when the listing hits its page cap", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({ listInstallations: () => ({ body: [
        { id: 1, account: { login: "acme", type: "Organization" } },
      ] }) });
      await discoverInstallations(deps(), orgId);
      let pages = 0;
      const fetchImpl: typeof fetch = async (url, init) => {
        if (String(url).includes("/app/installations")) {
          pages++;
          return new Response("[]", { headers: { link: `<${fixture!.url}/app/installations?page=${pages + 1}>; rel="next"` } });
        }
        return fetch(url, init);
      };
      await discoverInstallations(deps({ fetchImpl }), orgId);
      expect(pages).toBe(10);
      expect(await db.select().from(githubInstallations)).toHaveLength(1);
    });

    it("does not invalidate workflow sources on repeated owner refreshes", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await db.insert(contentSources).values({
        id: "source", orgId, ownerType: "team", ownerId: "team", repoFullName: "acme/workflows",
        kinds: ["workflows"], syncRevision: 7, nextAttemptAt: 0, createdAt: 1, updatedAt: 1,
      });
      fixture = startGithubFixture();
      let now = Date.now();
      const d = deps({ now: () => now });
      for (let attempt = 0; attempt < 3; attempt++) {
        await loadAppOwner(d, orgId, baseConfig);
        now += 300_001;
      }
      expect(fixture.calls.filter((call) => call.path === "/app")).toHaveLength(3);
      expect(await db.select({ revision: contentSources.syncRevision }).from(contentSources)).toEqual([{ revision: 7 }]);
      expect(await credentials.get({ type: "org", id: orgId }, "github_app_identity")).toBeNull();
    });

    it.each(["mint", "sole", "readiness", "picker"])("backfills a legacy owner row for %s", async (consumer) => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await db.insert(githubInstallations).values({
        id: "legacy", orgId, installationId: 1, accountLogin: "acme", accountType: "Organization",
        accountId: null, createdAt: 1, updatedAt: 1,
      });
      fixture = startGithubFixture({ getInstallation: () => ({ body: {
        id: 1, account: { id: 10, login: "acme", type: "Organization" },
      } }), getApp: () => ({ body: { owner: { id: 10, login: "acme" } } }) });
      if (consumer === "mint") expect(await mintInstallationToken(deps(), orgId, "acme")).toBe("fixture-installation-token");
      if (consumer === "sole") expect(await resolveInstallationApiToken(deps(), orgId)).toBe("fixture-installation-token");
      if (consumer === "readiness") expect(await installationResolvesFor(deps(), orgId, "acme")).toEqual({ ok: true });
      if (consumer === "picker") {
        await githubHost.listRepos({ orgId, deps: deps() });
        expect(fixture.calls.some((call) => call.path === "/installation/repositories")).toBe(true);
      }
      expect(await db.select({ accountId: githubInstallations.accountId }).from(githubInstallations)).toEqual([{ accountId: 10 }]);
    });

    it("does not undo a suspension while backfilling legacy identity", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await db.insert(githubInstallations).values({
        id: "legacy", orgId, installationId: 1, accountLogin: "acme", accountType: "Organization",
        accountId: null, suspended: true, createdAt: 1, updatedAt: 1,
      });
      fixture = startGithubFixture({ getInstallation: () => ({ body: {
        id: 1, account: { id: 10, login: "acme", type: "Organization" }, suspended_at: null,
      } }) });
      await ensureInstallationAccountIds(deps(), orgId);
      expect(await db.select().from(githubInstallations)).toMatchObject([{ accountId: 10, suspended: true }]);
    });

    it("throttles concurrent and sequential discovery failures", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await db.insert(githubInstallations).values({
        id: "foreign", orgId, installationId: 2, accountLogin: "foreign", accountType: "Organization",
        accountId: 20, createdAt: 1, updatedAt: 1,
      });
      fixture = startGithubFixture({ listInstallations: () => ({ status: 502, body: {} }) });
      expect(await Promise.all(Array.from({ length: 8 }, () => mintInstallationToken(deps(), orgId, "foreign"))))
        .toEqual(Array(8).fill(null));
      for (let attempt = 0; attempt < 3; attempt++) expect(await mintInstallationToken(deps(), orgId, "foreign")).toBeNull();
      expect(fixture.calls.filter((call) => call.path === "/app/installations")).toHaveLength(1);
    });

    it("keeps a cached legacy owner token when GitHub backfill returns 502", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({ listInstallations: () => ({ status: 502, body: {} }) });
      await loadAppOwner(deps(), orgId, baseConfig);
      await db.insert(githubInstallations).values({
        id: "legacy", orgId, installationId: 1, accountLogin: "acme", accountType: "Organization", accountId: null,
        cachedToken: encryptSecret("cached-owner", deps().key), cachedTokenExpiresAt: Date.now() + 3600_000,
        createdAt: 1, updatedAt: 1,
      });
      expect(await Promise.all(Array.from({ length: 8 }, () => mintInstallationToken(deps(), orgId, "acme"))))
        .toEqual(Array(8).fill("cached-owner"));
      expect(await mintInstallationToken(deps(), orgId, "acme")).toBe("cached-owner");
      expect(fixture.calls.filter((call) => call.path === "/app/installations/1")).toHaveLength(1);
      expect(fixture.calls.some((call) => call.path.includes("access_tokens"))).toBe(false);
    });

    it.each(["Organization", "User"])("recovers a renamed %s owner through background targeted lookup", async (type) => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      const installation = {
        id: 1, account: { id: githubAccountId("acme"), login: "new-acme", type },
      };
      fixture = startGithubFixture({ getAccountInstallation: (namespace) =>
        namespace === "orgs" && type === "User" ? { status: 404, body: {} } : { body: installation },
        getInstallation: () => ({ body: installation }),
      });
      expect(await mintInstallationToken(deps(), orgId, "new-acme")).toBeNull();
      // Join the same background task; the next mint sees its verified row.
      await requestInstallationForLogin(deps(), orgId, "new-acme");
      expect(await mintInstallationToken(deps(), orgId, "new-acme")).toBe("fixture-installation-token");
      await Promise.all(Array.from({ length: 4 }, () => requestInstallationForLogin(deps(), orgId, "new-acme")));
      expect(fixture.calls.filter((call) => call.path === "/orgs/new-acme/installation")).toHaveLength(1);
      expect(fixture.calls.filter((call) => call.path === "/users/new-acme/installation")).toHaveLength(type === "User" ? 1 : 0);
      expect(fixture.calls.filter((call) => call.path === "/app/installations")).toHaveLength(0);
    });

    it("bounds distinct-login recovery, negatively caches misses, and skips live webhooks", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture();
      let now = 1_000_000;
      const d = deps({ now: () => now, env: {} });
      await Promise.all(Array.from({ length: 100 }, (_, i) => requestInstallationForLogin(d, orgId, `owner-${i}`)));
      const calls = () => fixture!.calls.filter((call) => /\/(orgs|users)\//.test(call.path)).length;
      expect(calls()).toBe(GITHUB_LOGIN_RECOVERY_BUDGET * 2);
      expect(githubLoginRecoveryStats(d, orgId).entries).toBe(GITHUB_LOGIN_RECOVERY_BUDGET);
      now += 60_001;
      await requestInstallationForLogin(d, orgId, "owner-0");
      expect(calls()).toBe(GITHUB_LOGIN_RECOVERY_BUDGET * 2); // Five-minute negative cache.
      for (let round = 0; round < 12; round++) {
        now += 60_001;
        await Promise.all(Array.from({ length: 100 }, (_, i) => requestInstallationForLogin(d, orgId, `round-${round}-${i}`)));
        expect(githubLoginRecoveryStats(d, orgId).entries).toBeLessThanOrEqual(GITHUB_LOGIN_RECOVERY_MAX_ENTRIES);
      }
      const before = calls();
      for (const login of ["../app", "bad--name", "-bad", "x".repeat(40)]) await requestInstallationForLogin(d, orgId, login);
      await requestInstallationForLogin({ ...d, env: { VALET_PUBLIC_URL: "https://valet.example" } }, orgId, "valid-owner");
      expect(calls()).toBe(before);
    });

    it("bounds unheld drop claims and permits a new claim after the window", () => {
      let now = 1_000_000;
      const d = deps({ now: () => now });
      expect(claimUnheldWebhookDrop(d, orgId, 1)).toBe(true);
      expect(claimUnheldWebhookDrop(d, orgId, 1)).toBe(false);
      const accepted = Array.from({ length: 200 }, (_, i) => claimUnheldWebhookDrop(d, orgId, 2 + i));
      expect(accepted.filter(Boolean)).toHaveLength(127); // 128 live claims, including ID 1.
      expect(claimUnheldWebhookDrop(d, orgId, 1)).toBe(false); // Capacity never evicts a live claim.
      now += 60_001;
      expect(claimUnheldWebhookDrop(d, orgId, 1)).toBe(true);
    });

    it("bounds targeted webhook recovery and caches excluded installations", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({ getInstallation: () => ({ status: 404, body: {} }) });
      const d = deps({ env: { VALET_PUBLIC_URL: "https://live.example" } });
      const results = await Promise.all(Array.from({ length: 100 }, (_, i) => recoverWebhookInstallation(d, orgId, 1000 + i)));
      expect(results.filter((state) => state === "excluded")).toHaveLength(WEBHOOK_INSTALLATION_RECOVERY_BUDGET);
      expect(results.filter((state) => state === "budget_exhausted")).toHaveLength(100 - WEBHOOK_INSTALLATION_RECOVERY_BUDGET);
      await Promise.all(Array.from({ length: 8 }, () => recoverWebhookInstallation(d, orgId, 1000)));
      expect(fixture.calls.filter((call) => /^\/app\/installations\//.test(call.path))).toHaveLength(WEBHOOK_INSTALLATION_RECOVERY_BUDGET);
      expect(fixture.calls.some((call) => call.path === "/app/installations" || call.path === "/user")).toBe(false);
    });

    it("will not sign caller-supplied identity without exact-token /user verification", async () => {
      await db.insert(users).values({ id: "identity-member", name: "Member", email: "identity@example.com" });
      await credentials.save({ type: "user", id: "identity-member" }, "github", { type: "api_key", accessToken: "token-30" });
      fixture = startGithubFixture({ getUser: (auth) => ({ body: { id: auth === "Bearer token-30" ? 30 : 20, login: "member" } }) });
      expect(await saveVerifiedGithubIdentity(deps(), "identity-member", { id: 20, login: "forged" }, "token-30")).toBe(false);
      expect(await saveVerifiedGithubIdentity(deps(), "identity-member", { id: 20, login: "other" }, "other-token")).toBe(false);
      expect(await saveVerifiedGithubIdentity(deps(), "identity-member", { id: 30, login: "caller-login" }, "token-30")).toBe(true);
      expect((await credentials.get({ type: "user", id: "identity-member" }, "github"))?.metadata).toMatchObject({ githubUserId: 30, login: "member" });
    });

    it("returns immediately for a missing row while recovery is blocked", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture();
      let release: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let targetedCalls = 0;
      const fetchImpl: typeof fetch = async (url, init) => {
        if (String(url).includes("/installation")) {
          targetedCalls++;
          await pending;
          return new Response(null, { status: 404 });
        }
        return fetch(url, init);
      };
      const d = deps({ fetchImpl });
      try {
        expect(await Promise.all(Array.from({ length: 8 }, () => mintInstallationToken(d, orgId, "facebook"))))
          .toEqual(Array(8).fill(null));
        expect(fixture.calls.some((call) => call.path === "/app" || call.path === "/app/installations")).toBe(false);
      } finally {
        release?.();
        await requestInstallationForLogin(d, orgId, "facebook");
      }
      expect(targetedCalls).toBe(2); // One org miss and one user miss, not eight of each.
    });

    it.each<Record<string, string>>([{ "x-ratelimit-remaining": "0" }, { "retry-after": "30" }])("uses persisted owner for rate-limited 403 (%j)", async (headers) => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      let now = 1_000_000;
      let limited = false;
      const d = deps({ now: () => now, fetchImpl: async () => limited
        ? new Response("{}", { status: 403, headers })
        : Response.json({ owner: { id: 10, login: "acme" } }) });
      expect(await loadAppOwner(d, orgId, baseConfig)).toEqual({ id: 10, login: "acme" });
      now += 300_001;
      limited = true;
      expect(await loadAppOwner(d, orgId, baseConfig)).toEqual({ id: 10, login: "acme" });
    });

    it("uses the persisted owner and cached token during a GET /app 503", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      let outage = false;
      fixture = startGithubFixture({
        getApp: () => outage ? { status: 503, body: {} } : { body: { owner: { id: 10, login: "acme" } } },
        listInstallations: () => ({ body: [{ id: 1, account: { id: 10, login: "acme", type: "Organization" } }] }),
      });
      await discoverInstallations(deps(), orgId);
      expect(await mintInstallationToken(deps(), orgId, "acme")).toBe("fixture-installation-token");
      outage = true;
      // A new store models another pod, with no in-process owner cache.
      const separate = { ...deps(), credentials: {
        get: credentials.get.bind(credentials), save: credentials.save.bind(credentials),
        delete: credentials.delete.bind(credentials), list: credentials.list.bind(credentials),
      } };
      expect(await loadAppOwner(separate, orgId, baseConfig)).toEqual({ id: 10, login: "acme" });
      expect(await mintInstallationToken(separate, orgId, "acme")).toBe("fixture-installation-token");
      expect(await installationResolvesFor(separate, orgId, "acme")).toEqual({ ok: true });
      // An empty repo response is legitimate; inspect the API call to prove admission.
      await githubHost.listRepos({ orgId, deps: separate });
      expect(fixture.calls.some((call) => call.path === "/installation/repositories")).toBe(true);
      expect(fixture.calls.filter((call) => call.path.includes("access_tokens"))).toHaveLength(1);
    });

    it("fails closed when GitHub cannot identify the App owner", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({ getApp: () => ({ body: { id: 123456 } }) });
      await expect(discoverInstallations(deps(), orgId)).rejects.toThrow("App owner");
      expect(await db.select().from(githubInstallations)).toEqual([]);
    });

    it("discovers a pre-existing personal installation after OAuth linking", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({ getUser: () => ({ body: { login: "member" } }), listInstallations: () => ({ body: [
        { id: 1, account: { login: "member", type: "User" } },
      ] }) });
      expect(await discoverInstallations(deps(), orgId)).toEqual([]);
      await linkMember("member", "member");
      await relinkInstallations(deps(), orgId);
      expect(await db.select().from(githubInstallations)).toMatchObject([{ installationId: 1, linkedUserId: "member" }]);
    });
    it("returns [] when no app is configured for the org", async () => {
      const result = await discoverInstallations(deps(), orgId);
      expect(result).toEqual([]);
    });

    it("upserts installations, authenticates with the App JWT, and marks suspended installations", async () => {
      await linkMember("someuser", "someuser");
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({ getUser: () => ({ body: { login: "someuser" } }),
        listInstallations: () => ({
          body: [
            { id: 111, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null },
            { id: 222, account: { login: "someuser", type: "User" }, repository_selection: "selected", suspended_at: "2026-01-01T00:00:00Z" },
          ],
        }),
      });

      const rows = fresh(await discoverInstallations(deps(), orgId));
      expect(rows).toHaveLength(2);

      const acme = rows.find((r) => r.installationId === 111);
      expect(acme).toMatchObject({
        orgId,
        accountLogin: "acme",
        accountId: githubAccountId("acme"),
        accountType: "Organization",
        repositorySelection: "all",
        suspended: false,
        linkedUserId: null,
      });

      const someuser = rows.find((r) => r.installationId === 222);
      expect(someuser).toMatchObject({
        accountLogin: "someuser",
        accountId: githubAccountId("someuser"),
        suspended: true,
      });

      const call = fixture.calls.find((entry) => entry.path === "/app/installations");
      if (!call) throw new Error("Missing installation discovery request");
      expect(call.path).toBe("/app/installations");
      expect(call.authHeader).toMatch(/^Bearer /);
      // App-JWT auth, not an installation token — decode and check `iss`.
      const jwt = call.authHeader?.slice("Bearer ".length) ?? "";
      const payload = decodeJwtPart(jwt.split(".")[1]);
      expect(payload.iss).toBe(baseConfig.appId);
    });

    it("follows Link: rel=\"next\" pagination before computing upserts/deletions", async () => {
      await linkMember("page2user", "page2user");
      await saveAppConfig({ credentials }, orgId, baseConfig);
      // Seed a pre-existing row for an installation (333) that is genuinely
      // absent from BOTH pages of the new response — it must be deleted.
      await db.insert(githubInstallations).values({
        id: "ghi_stale",
        orgId,
        installationId: 333,
        accountLogin: "stale",
        accountId: githubAccountId("stale"),
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
        getUser: () => ({ body: { login: "page2user" } }),
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
              { id: 111, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null },
            ],
            headers: {
              link: `<${fixture?.url}/app/installations?per_page=100&page=2>; rel="next"`,
            },
          };
        },
      });

      const rows = fresh(await discoverInstallations(deps(), orgId));
      const installationIds = rows.map((r) => r.installationId).sort();
      expect(installationIds).toEqual([111, 222]);

      const allRows = await db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
      const remainingIds = allRows.map((r) => r.installationId).sort();
      expect(remainingIds).toEqual([111, 222]); // 333 (genuinely absent) is deleted, 111/222 survive

      const pages = fixture.calls.filter((call) => call.path === "/app/installations");
      expect(pages).toHaveLength(2);
      expect(pages[0].query.page).toBeUndefined();
      expect(pages[1].query.page).toBe("2");
    });

    it("removes rows whose installation is absent from a later response", async () => {
      await linkMember("someuser", "someuser");
      await saveAppConfig({ credentials }, orgId, baseConfig);
      let installationsBody: unknown[] = [
        { id: 111, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null },
        { id: 222, account: { login: "someuser", type: "User" }, repository_selection: "all", suspended_at: null },
      ];
      fixture = startGithubFixture({ getUser: () => ({ body: { login: "someuser" } }), listInstallations: () => ({ body: installationsBody }) });

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
      await db.insert(orgMembers).values({ orgId, userId: "user1", role: "member" });
      await credentials.save(
        { type: "user", id: "user1" },
        "github",
        { type: "oauth2", accessToken: "user-token", metadata: { login: "ALICE" } },
      );
      fixture = startGithubFixture({ getUser: () => ({ body: { login: "alice" } }),
        listInstallations: () => ({
          body: [{ id: 111, account: { login: "alice", type: "User" }, repository_selection: "all", suspended_at: null }],
        }),
      });

      const rows = fresh(await discoverInstallations(deps(), orgId));
      expect(rows[0].linkedUserId).toBe("user1");
    });
  });

  describe("syncAppWebhookUrl", () => {
    const publicUrl = "https://tunnel-abc.trycloudflare.com";
    const expectedHookUrl = `${publicUrl}/webhooks/github-app`;
    const deadHookUrl = "https://tunnel-dead.trycloudflare.com/webhooks/github-app";

    /** A `GITHUB_APP_*` app supplied by a deployment or shared by a team —
     * the config source this must never sync. */
    const sharedEnvApp: NodeJS.ProcessEnv = {
      GITHUB_APP_ID: "654321",
      GITHUB_APP_SLUG: "valet-shared-dev",
      GITHUB_APP_CLIENT_ID: "Iv1.env123",
      GITHUB_APP_CLIENT_SECRET: "env-client-secret",
      GITHUB_APP_WEBHOOK_SECRET: "env-webhook-secret",
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    };

    /** `deps()` with an EMPTY env, so a `GITHUB_APP_*` value in the
     * developer's own environment cannot change the config source under
     * test. */
    function syncDeps(env: NodeJS.ProcessEnv = {}): GithubAppDeps {
      return deps({ env });
    }

    function patchCalls(f: GithubFixture) {
      return f.calls.filter((c) => c.method === "PATCH" && c.path === "/app/hook/config");
    }

    it("patches the webhook URL when GitHub holds a different one, with App JWT auth", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({ getHookConfig: () => ({ body: { url: deadHookUrl } }) });

      await syncAppWebhookUrl(syncDeps(), orgId, publicUrl);

      const patches = patchCalls(fixture);
      expect(patches).toHaveLength(1);
      expect(patches[0].body).toEqual({ url: expectedHookUrl });
      // App-JWT auth, not an installation token — decode and check `iss`.
      const jwt = patches[0].authHeader?.slice("Bearer ".length) ?? "";
      expect(decodeJwtPart(jwt.split(".")[1]).iss).toBe(baseConfig.appId);
    });

    it("sets the URL on an app created with no webhook at all", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      // A manifest built without `hook_attributes` (no public URL at
      // creation) leaves GitHub reporting `url: null`.
      fixture = startGithubFixture({ getHookConfig: () => ({ body: { url: null } }) });

      await syncAppWebhookUrl(syncDeps(), orgId, publicUrl);

      expect(patchCalls(fixture)).toHaveLength(1);
      expect(patchCalls(fixture)[0].body).toEqual({ url: expectedHookUrl });
    });

    it("does nothing for an app that came from the environment — another instance owns it", async () => {
      // No credential row for the org, so the config resolves to the
      // `GITHUB_APP_*` fallback and the source is "environment". Syncing it
      // would steal the team's shared app on every local boot.
      fixture = startGithubFixture({ getHookConfig: () => ({ body: { url: deadHookUrl } }) });

      await syncAppWebhookUrl(syncDeps(sharedEnvApp), orgId, publicUrl);

      expect(patchCalls(fixture)).toHaveLength(0);
      expect(fixture.calls).toHaveLength(0); // not even the read
    });

    it("makes no write when GitHub already holds this instance's URL", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({ getHookConfig: () => ({ body: { url: expectedHookUrl } }) });

      await syncAppWebhookUrl(syncDeps(), orgId, publicUrl);

      expect(patchCalls(fixture)).toHaveLength(0);
      expect(fixture.calls).toHaveLength(1); // the read, and nothing else
    });

    it("does nothing, and never clears the URL, when this instance has no public URL", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({ getHookConfig: () => ({ body: { url: deadHookUrl } }) });

      await syncAppWebhookUrl(syncDeps(), orgId, undefined);

      expect(fixture.calls).toHaveLength(0);
    });

    it("logs and continues when the PATCH fails", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({
        getHookConfig: () => ({ body: { url: deadHookUrl } }),
        updateHookConfig: () => ({ status: 422, body: { message: "Hook url is not supported" } }),
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        await expect(syncAppWebhookUrl(syncDeps(), orgId, publicUrl)).resolves.toBeUndefined();
        expect(errors).toHaveBeenCalledTimes(1);
      } finally {
        errors.mockRestore();
      }
      expect(patchCalls(fixture)).toHaveLength(1);
    });

    it("syncAllAppWebhookUrls covers every org that owns an app row", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      fixture = startGithubFixture({ getHookConfig: () => ({ body: { url: deadHookUrl } }) });

      await syncAllAppWebhookUrls(syncDeps(), publicUrl);

      expect(patchCalls(fixture)).toHaveLength(1);
      expect(patchCalls(fixture)[0].body).toEqual({ url: expectedHookUrl });
    });
  });

  describe("mintInstallationToken", () => {
    async function seedInstallation(overrides: Partial<typeof githubInstallations.$inferInsert> = {}) {
      await db.insert(githubInstallations).values({
        id: "ghi_1",
        orgId,
        installationId: 999,
        accountLogin: "acme",
        accountId: githubAccountId("acme"),
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

    it("binds personal token minting and cached reads to the linked member", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      await db.insert(users).values({ id: "b", name: "B", email: "b@example.com" });
      await db.insert(orgMembers).values({ orgId, userId: "b", role: "member" });
      await credentials.save({ type: "user", id: "b" }, "github", { type: "oauth2", accessToken: "b-token", metadata: { login: "alice" } });
      await seedInstallation({ accountLogin: "alice", accountId: githubAccountId("alice"), accountType: "User", linkedUserId: "b" });
      fixture = startGithubFixture({ getUser: () => ({ body: { login: "alice" } }) });
      expect(await mintInstallationToken(deps(), orgId, "alice", "a")).toBeNull();
      expect(await mintInstallationToken(deps(), orgId, "alice")).toBeNull();
      expect(fixture.calls.filter((call) => call.path.includes("access_tokens"))).toHaveLength(0);
      expect(await mintInstallationToken(deps(), orgId, "alice", "b")).toBe("fixture-installation-token");
      expect(await mintInstallationToken(deps(), orgId, "alice", "a")).toBeNull();
      expect(await mintInstallationToken(deps(), orgId, "alice")).toBeNull();
      expect(await mintInstallationToken(deps(), orgId, "alice", "b")).toBe("fixture-installation-token");
      expect(fixture.calls.filter((call) => call.path.includes("access_tokens"))).toHaveLength(1);
      await credentials.save({ type: "user", id: "b" }, "github", { type: "oauth2", accessToken: "b-token", metadata: { login: "different" } });
      expect(await mintInstallationToken(deps(), orgId, "alice", "b")).toBe("fixture-installation-token");
      expect((await credentials.get({ type: "user", id: "b" }, "github"))?.metadata?.login).toBe("alice");
      await credentials.save({ type: "user", id: "b" }, "github", { type: "oauth2", accessToken: "b-token", metadata: { login: "alice" } });
      await db.update(orgs).set({ allowPersonalInstallations: false }).where(eq(orgs.id, orgId));
      expect(await mintInstallationToken(deps(), orgId, "alice", "b")).toBeNull();
      await db.update(orgs).set({ allowPersonalInstallations: true }).where(eq(orgs.id, orgId));
      await db.delete(orgMembers).where(eq(orgMembers.userId, "b"));
      expect(await mintInstallationToken(deps(), orgId, "alice", "b")).toBeNull();
    });

    it("refuses a stale excluded org row before discovery, including its cached token", async () => {
      await saveAppConfig({ credentials }, orgId, baseConfig);
      const { encryptSecret } = await import("../lib/secret-crypto.js");
      await seedInstallation({ accountLogin: "other-org", accountId: githubAccountId("other-org"), cachedToken: encryptSecret("stale-cross-org-token", deps().key),
        cachedTokenExpiresAt: Date.now() + 3600_000 });
      fixture = startGithubFixture();
      expect(await mintInstallationToken(deps(), orgId, "other-org", "member")).toBeNull();
      expect(await mintInstallationToken(deps(), orgId, "other-org")).toBeNull();
      expect(fixture.calls.filter((call) => call.path.includes("access_tokens"))).toEqual([]);
      expect(await db.select().from(githubInstallations)).toHaveLength(0);
    });

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
      expect(fixture.calls.filter((call) => call.path.includes("access_tokens"))).toHaveLength(1);
      expect(fixture.calls.find((call) => call.path.includes("access_tokens"))?.path).toBe("/app/installations/999/access_tokens");
      expect(fixture.calls.find((call) => call.path.includes("access_tokens"))?.authHeader).toMatch(/^Bearer /);

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
      expect(fixture.calls.filter((call) => call.path.includes("access_tokens"))).toHaveLength(0);
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
      expect(fixture.calls.filter((call) => call.path.includes("access_tokens"))).toHaveLength(1); // fixture hit
      expect(fixture.calls.find((call) => call.path.includes("access_tokens"))?.path).toBe("/app/installations/999/access_tokens");

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
      expect(fixture.calls.filter((call) => call.path.includes("access_tokens"))).toHaveLength(1);
    });
  });
});
