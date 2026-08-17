/**
 * Canonical GitHub token resolution tests (GitHub/repo integration plan,
 * Task 4). Covers the full precedence matrix (both purposes ×
 * installation/user/PAT/tokenless/none), strict explicit selection in both
 * directions, the refresh subsystem (rotation persisted, single-flight under
 * concurrency, unhealthy fallthrough), identity-only exclusion, and the
 * sole-installation fallback (positive + NOT-sole negative).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs, users, githubInstallations } from "../schema/index.js";
import { saveAppConfig, type GithubAppConfig } from "./github-app.js";
import { GitHubAuthError, resolveGitHubToken, type GitHubTokenDeps } from "./github-tokens.js";

const orgId = "org1";
const userId = "user1";
const NOW = 1_700_000_000_000;

// A real RSA key — installation-minting paths sign an App JWT with it
// (the fixture never verifies the signature, but `createPrivateKey` rejects
// a bogus PEM). The refresh path only reads client id/secret, not the key.
const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const appConfig: GithubAppConfig = {
  appId: "123456",
  appSlug: "valet-app",
  oauthClientId: "Iv1.abc123",
  htmlUrl: "https://github.com/apps/valet-app",
  oauthClientSecret: "oauth-client-secret",
  webhookSecret: "webhook-secret",
  privateKeyPem,
};

describe("resolveGitHubToken", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;
  let fixture: GithubFixture | undefined;

  beforeEach(async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
    await db.insert(users).values({ id: userId, name: "User One", email: "u1@example.com" });
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  function deps(overrides: Partial<GitHubTokenDeps> = {}): GitHubTokenDeps {
    return {
      db,
      credentials,
      key: deriveSecretKey("cache-key"),
      apiUrl: fixture?.url,
      githubUrl: fixture?.url,
      now: () => NOW,
      ...overrides,
    };
  }

  async function seedInstallation(overrides: Partial<typeof githubInstallations.$inferInsert> = {}): Promise<void> {
    await db.insert(githubInstallations).values({
      id: `ghi_${overrides.installationId ?? 999}`,
      orgId,
      installationId: 999,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    });
  }

  async function saveUserGithub(cred: Parameters<PgCredentialStore["save"]>[2]): Promise<void> {
    await credentials.save({ type: "user", id: userId }, "github", cred);
  }

  async function saveOrgGithub(cred: Parameters<PgCredentialStore["save"]>[2]): Promise<void> {
    await credentials.save({ type: "org", id: orgId }, "github", cred);
  }

  function oauthFixtureCalls(): number {
    return (fixture?.calls ?? []).filter((c) => c.path === "/login/oauth/access_token").length;
  }

  // ── explicit auth: "app" ─────────────────────────────────────────────
  describe('explicit auth: "app"', () => {
    it("returns an installation token for the repo owner", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "git",
        repo: { owner: "acme", name: "repo" },
        auth: "app",
      });
      expect(result).toEqual({ token: "inst-999", source: "installation" });
    });

    it("THROWS when the App is not installed on the owner — never falls back to a healthy user credential", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      // Healthy user credential IS available — must be ignored under explicit "app".
      await saveUserGithub({ type: "oauth2", accessToken: "user-tok", metadata: { login: "octocat" } });
      fixture = startGithubFixture();

      await expect(
        resolveGitHubToken(deps(), { orgId, userId, purpose: "git", repo: { owner: "acme", name: "repo" }, auth: "app" }),
      ).rejects.toThrow(new GitHubAuthError("the GitHub App is not installed on acme"));
    });

    it("THROWS when no repo owner is provided", async () => {
      fixture = startGithubFixture();
      await expect(resolveGitHubToken(deps(), { orgId, userId, purpose: "api", auth: "app" })).rejects.toBeInstanceOf(
        GitHubAuthError,
      );
    });
  });

  // ── explicit auth: "user" ────────────────────────────────────────────
  describe('explicit auth: "user"', () => {
    it("returns a healthy PAT (no expiresAt / no refreshToken) with its login", async () => {
      await saveUserGithub({ type: "api_key", accessToken: "pat-tok", metadata: { login: "octocat" } });
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "api", auth: "user" });
      expect(result).toEqual({ token: "pat-tok", source: "pat", login: "octocat" });
    });

    it("returns a fresh App-OAuth token as source=user", async () => {
      await saveUserGithub({
        type: "oauth2",
        accessToken: "oauth-tok",
        refreshToken: "refresh-tok",
        expiresAt: NOW + 10 * 60 * 1000, // 10 min out — outside the 5 min margin
        metadata: { login: "octocat" },
      });
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "api", auth: "user" });
      expect(result).toEqual({ token: "oauth-tok", source: "user", login: "octocat" });
      expect(oauthFixtureCalls()).toBe(0); // fresh — no refresh
    });

    it("THROWS naming the gap when no user credential is connected — never falls back to an installation", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation(); // installation IS available — must be ignored under explicit "user".
      fixture = startGithubFixture();

      await expect(
        resolveGitHubToken(deps(), { orgId, userId, purpose: "api", repo: { owner: "acme", name: "repo" }, auth: "user" }),
      ).rejects.toThrow(GitHubAuthError);
    });

    it("THROWS for an identity-only credential", async () => {
      await saveUserGithub({ type: "oauth2", accessToken: "id-tok", metadata: { login: "octocat", identityOnly: true } });
      fixture = startGithubFixture();

      await expect(resolveGitHubToken(deps(), { orgId, userId, purpose: "api", auth: "user" })).rejects.toThrow(
        /identity-only/,
      );
    });

    it("THROWS for a credential already marked refreshFailedAt", async () => {
      await saveUserGithub({
        type: "oauth2",
        accessToken: "dead-tok",
        refreshToken: "r",
        expiresAt: NOW + 10 * 60 * 1000,
        metadata: { login: "octocat", refreshFailedAt: NOW - 1000 },
      });
      fixture = startGithubFixture();

      await expect(resolveGitHubToken(deps(), { orgId, userId, purpose: "api", auth: "user" })).rejects.toThrow(
        GitHubAuthError,
      );
    });

    it("THROWS for a stale credential with no refresh token", async () => {
      await saveUserGithub({
        type: "oauth2",
        accessToken: "expiring-tok",
        expiresAt: NOW + 60 * 1000, // 1 min out — inside the margin, no refreshToken to refresh with
        metadata: { login: "octocat" },
      });
      fixture = startGithubFixture();

      await expect(resolveGitHubToken(deps(), { orgId, userId, purpose: "api", auth: "user" })).rejects.toThrow(
        GitHubAuthError,
      );
    });
  });

  // ── auto + git ───────────────────────────────────────────────────────
  describe("auto + git", () => {
    it("prefers the installation for the repo owner", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      // A user credential is also available — installation wins for git.
      await saveUserGithub({ type: "oauth2", accessToken: "user-tok", metadata: { login: "octocat" } });
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "git",
        repo: { owner: "acme", name: "repo" },
      });
      expect(result).toEqual({ token: "inst-999", source: "installation" });
    });

    it("falls back to the user credential when there is no installation", async () => {
      await saveUserGithub({
        type: "oauth2",
        accessToken: "user-tok",
        refreshToken: "r",
        expiresAt: NOW + 10 * 60 * 1000,
        metadata: { login: "octocat" },
      });
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "git",
        repo: { owner: "nobody", name: "repo" },
      });
      expect(result).toEqual({ token: "user-tok", source: "user", login: "octocat" });
    });

    it("uses the user credential when no repo is given (installation lookup skipped)", async () => {
      await saveUserGithub({ type: "api_key", accessToken: "pat-tok", metadata: { login: "octocat" } });
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "git" });
      expect(result).toEqual({ token: "pat-tok", source: "pat", login: "octocat" });
    });

    it("returns a tokenless result when nothing is available", async () => {
      fixture = startGithubFixture();
      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "git",
        repo: { owner: "nobody", name: "repo" },
      });
      expect(result).toEqual({ token: null, source: "none" });
    });

    it("is tokenless when the only user credential is identity-only", async () => {
      await saveUserGithub({ type: "oauth2", accessToken: "id-tok", metadata: { login: "octocat", identityOnly: true } });
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "git", repo: { owner: "nobody", name: "r" } });
      expect(result).toEqual({ token: null, source: "none" });
    });
  });

  // ── auto + api ───────────────────────────────────────────────────────
  describe("auto + api", () => {
    it("prefers the user credential even when an installation exists", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      await saveUserGithub({
        type: "oauth2",
        accessToken: "user-tok",
        refreshToken: "r",
        expiresAt: NOW + 10 * 60 * 1000,
        metadata: { login: "octocat" },
      });
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "api",
        repo: { owner: "acme", name: "repo" },
      });
      expect(result).toEqual({ token: "user-tok", source: "user", login: "octocat" });
    });

    it("falls back to the repo owner's installation when the user is not connected", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "api",
        repo: { owner: "acme", name: "repo" },
      });
      expect(result).toEqual({ token: "inst-999", source: "installation" });
    });

    it("falls back to the org's SOLE installation when no user + no repo", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "api" });
      expect(result).toEqual({ token: "inst-999", source: "installation" });
    });

    it("does NOT use the sole-installation fallback when TWO installations exist", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation({ id: "ghi_1", installationId: 111, accountLogin: "acme" });
      await seedInstallation({ id: "ghi_2", installationId: 222, accountLogin: "other" });
      fixture = startGithubFixture();

      await expect(resolveGitHubToken(deps(), { orgId, userId, purpose: "api" })).rejects.toThrow(GitHubAuthError);
    });

    it("THROWS with a connect hint when nothing is available", async () => {
      fixture = startGithubFixture();
      await expect(resolveGitHubToken(deps(), { orgId, userId, purpose: "api" })).rejects.toThrow(/connect your GitHub/i);
    });

    it("falls through to the installation when the user credential is unhealthy (refreshFailedAt)", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      await saveUserGithub({
        type: "oauth2",
        accessToken: "dead-tok",
        refreshToken: "r",
        expiresAt: NOW + 10 * 60 * 1000,
        metadata: { login: "octocat", refreshFailedAt: NOW - 1000 },
      });
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "api",
        repo: { owner: "acme", name: "repo" },
      });
      expect(result).toEqual({ token: "inst-999", source: "installation" });
    });
  });

  // ── presence ────────────────────────────────────────────────────────
  // An unattended request must not prefer a person's token. Presence only
  // reorders the two `auto` + `api` tiers; everything else is unchanged.
  describe("actor presence", () => {
    /** Healthy personal credential the unattended chain must rank BELOW
     * the installation. */
    async function connectUser(): Promise<void> {
      await saveUserGithub({ type: "oauth2", accessToken: "user-tok", metadata: { login: "octocat" } });
    }

    it('unattended + api: uses the installation even though a healthy user credential exists', async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      await connectUser();
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "api",
        repo: { owner: "acme", name: "repo" },
        presence: "unattended",
      });
      expect(result).toEqual({ token: "inst-999", source: "installation" });
    });

    it("unattended + api: uses the org's SOLE installation when the node names no repo", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      await connectUser();
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "api", presence: "unattended" });
      expect(result).toEqual({ token: "inst-999", source: "installation" });
    });

    // The migration promise: an org with no App installed keeps working.
    it("unattended + api: falls back to the user credential when the App is not installed", async () => {
      await connectUser();
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "api",
        repo: { owner: "acme", name: "repo" },
        presence: "unattended",
      });
      expect(result).toEqual({ token: "user-tok", source: "pat", login: "octocat" });
    });

    it("unattended + api: falls back to the user credential when the App is installed on ANOTHER account", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation({ id: "ghi_1", installationId: 111, accountLogin: "acme" });
      await seedInstallation({ id: "ghi_2", installationId: 222, accountLogin: "other" });
      await connectUser();
      fixture = startGithubFixture();

      // Two installations, neither matching the repo owner: the repo tier
      // misses and the sole-installation tier does not apply.
      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "api",
        repo: { owner: "nobody", name: "repo" },
        presence: "unattended",
      });
      expect(result).toEqual({ token: "user-tok", source: "pat", login: "octocat" });
    });

    // The single-org shape, which is the ordinary one. A named owner with no
    // installation must not borrow the token of the one account the org DID
    // install on: that token cannot reach the repository, and GitHub answers
    // 404 rather than 403, so the failure would name no cause.
    it("unattended + api: does NOT borrow the org's SOLE installation for a repo it does not cover", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation({ id: "ghi_1", installationId: 111, accountLogin: "other" });
      await connectUser();
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "api",
        repo: { owner: "nobody", name: "repo" },
        presence: "unattended",
      });
      expect(result).toEqual({ token: "user-tok", source: "pat", login: "octocat" });
    });

    it("attended + api: does NOT borrow the org's SOLE installation for a repo it does not cover", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation({ id: "ghi_1", installationId: 111, accountLogin: "other" });
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      // No user credential at all, so the installation tier is the only one
      // left before the throw. It must still refuse to guess an account.
      await expect(
        resolveGitHubToken(deps(), { orgId, userId, purpose: "api", repo: { owner: "nobody", name: "repo" } }),
      ).rejects.toThrow(GitHubAuthError);
    });

    it("unattended + api: still mints the installation when it covers the named owner", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation({ id: "ghi_1", installationId: 111, accountLogin: "acme" });
      await seedInstallation({ id: "ghi_2", installationId: 222, accountLogin: "other" });
      await connectUser();
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      // Two installations, so the sole tier cannot apply. Only an
      // owner-matched mint can produce this token.
      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "api",
        repo: { owner: "acme", name: "repo" },
        presence: "unattended",
      });
      expect(result).toEqual({ token: "inst-111", source: "installation" });
    });

    it("unattended + api: still THROWS with a connect hint when nothing at all is available", async () => {
      fixture = startGithubFixture();
      await expect(
        resolveGitHubToken(deps(), { orgId, userId, purpose: "api", presence: "unattended" }),
      ).rejects.toThrow(/connect your GitHub/i);
    });

    it('attended + api: keeps the user credential ahead of the installation', async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      await connectUser();
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "api",
        repo: { owner: "acme", name: "repo" },
        presence: "attended",
      });
      expect(result).toEqual({ token: "user-tok", source: "pat", login: "octocat" });
    });

    it("an omitted presence resolves exactly as attended does", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      await connectUser();
      fixture = startGithubFixture();

      const omitted = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "api",
        repo: { owner: "acme", name: "repo" },
      });
      expect(omitted).toEqual({ token: "user-tok", source: "pat", login: "octocat" });
    });

    it('presence does NOT loosen an explicit auth: "app" — it still throws when not installed', async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await connectUser();
      fixture = startGithubFixture();

      await expect(
        resolveGitHubToken(deps(), {
          orgId,
          userId,
          purpose: "api",
          repo: { owner: "acme", name: "repo" },
          auth: "app",
          presence: "attended",
        }),
      ).rejects.toThrow(new GitHubAuthError("the GitHub App is not installed on acme"));
    });

    it('presence does NOT redirect an explicit auth: "user" to the installation', async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      await connectUser();
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "api",
        repo: { owner: "acme", name: "repo" },
        auth: "user",
        presence: "unattended",
      });
      expect(result).toEqual({ token: "user-tok", source: "pat", login: "octocat" });
    });

    it("unattended + git is unchanged: the installation already ranked first there", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      await connectUser();
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      const unattended = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "git",
        repo: { owner: "acme", name: "repo" },
        presence: "unattended",
      });
      const attended = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "git",
        repo: { owner: "acme", name: "repo" },
        presence: "attended",
      });
      expect(unattended).toEqual({ token: "inst-999", source: "installation" });
      expect(attended).toEqual(unattended);
    });

    it("unattended + api: the org PAT stays BELOW the user credential", async () => {
      await connectUser();
      await saveOrgGithub({ type: "oauth2", accessToken: "org-pat", metadata: { login: "acme-bot" } });
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "api", presence: "unattended" });
      expect(result).toEqual({ token: "user-tok", source: "pat", login: "octocat" });
    });
  });

  // ── org-owned PAT ───────────────────────────────────────────────────
  describe("org-owned PAT", () => {
    it("auto + git falls through to the org PAT when no installation and no user credential", async () => {
      await saveOrgGithub({ type: "api_key", accessToken: "org-pat-tok", metadata: { login: "acme-bot" } });
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "git",
        repo: { owner: "nobody", name: "repo" },
      });
      expect(result).toEqual({ token: "org-pat-tok", source: "pat", login: "acme-bot" });
    });

    it("auto + api falls through to the org PAT after user/installation/sole-installation are all absent", async () => {
      await saveOrgGithub({ type: "api_key", accessToken: "org-pat-tok", metadata: { login: "acme-bot" } });
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "api" });
      expect(result).toEqual({ token: "org-pat-tok", source: "pat", login: "acme-bot" });
    });

    it("auto + api prefers the org's sole installation over the org PAT", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      await saveOrgGithub({ type: "api_key", accessToken: "org-pat-tok", metadata: { login: "acme-bot" } });
      fixture = startGithubFixture({
        createInstallationToken: (id) => ({ body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() } }),
      });

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "api" });
      expect(result).toEqual({ token: "inst-999", source: "installation" });
    });

    it("treats a stale org PAT (has expiresAt, no refresh path) as unhealthy — falls through to tokenless", async () => {
      await saveOrgGithub({
        type: "oauth2",
        accessToken: "org-pat-tok",
        expiresAt: NOW + 60 * 1000, // inside the 5 min margin — stale, no refresh path
        metadata: { login: "acme-bot" },
      });
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), {
        orgId,
        userId,
        purpose: "git",
        repo: { owner: "nobody", name: "repo" },
      });
      expect(result).toEqual({ token: null, source: "none" });
    });

    it('explicit auth: "user" still THROWS when only an org PAT is present — org PAT never satisfies "user"', async () => {
      await saveOrgGithub({ type: "api_key", accessToken: "org-pat-tok", metadata: { login: "acme-bot" } });
      fixture = startGithubFixture();

      await expect(resolveGitHubToken(deps(), { orgId, userId, purpose: "api", auth: "user" })).rejects.toThrow(
        GitHubAuthError,
      );
    });
  });

  // ── refresh subsystem ────────────────────────────────────────────────
  describe("refresh subsystem", () => {
    async function seedStaleOAuth(): Promise<void> {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await saveUserGithub({
        type: "oauth2",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: NOW + 4 * 60 * 1000, // 4 min out — inside the 5 min margin → stale
        metadata: { login: "octocat" },
      });
    }

    it("refreshes a stale credential and persists the rotated pair", async () => {
      await seedStaleOAuth();
      fixture = startGithubFixture({
        oauthAccessToken: () => ({
          body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 28800, token_type: "bearer" },
        }),
      });

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "api", auth: "user" });
      expect(result).toEqual({ token: "new-access", source: "user", login: "octocat" });
      expect(oauthFixtureCalls()).toBe(1);

      const persisted = await credentials.get({ type: "user", id: userId }, "github");
      expect(persisted?.accessToken).toBe("new-access");
      expect(persisted?.refreshToken).toBe("new-refresh");
      expect(persisted?.expiresAt).toBe(NOW + 28800 * 1000);
      expect(persisted?.metadata).toEqual({ login: "octocat" }); // login preserved, no refreshFailedAt
    });

    it("sends the App client id/secret and grant_type=refresh_token to the OAuth endpoint", async () => {
      await seedStaleOAuth();
      fixture = startGithubFixture({
        oauthAccessToken: () => ({ body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 28800 } }),
      });

      await resolveGitHubToken(deps(), { orgId, userId, purpose: "api", auth: "user" });
      const call = fixture.calls.find((c) => c.path === "/login/oauth/access_token");
      expect(call?.body).toEqual({
        client_id: appConfig.oauthClientId,
        client_secret: appConfig.oauthClientSecret,
        grant_type: "refresh_token",
        refresh_token: "old-refresh",
      });
    });

    it("refreshes single-flight under concurrency — two resolves, ONE OAuth hit", async () => {
      await seedStaleOAuth();
      fixture = startGithubFixture({
        oauthAccessToken: () => ({ body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 28800 } }),
      });

      const d = deps();
      const [a, b] = await Promise.all([
        resolveGitHubToken(d, { orgId, userId, purpose: "api", auth: "user" }),
        resolveGitHubToken(d, { orgId, userId, purpose: "api", auth: "user" }),
      ]);
      expect(a.token).toBe("new-access");
      expect(b.token).toBe("new-access");
      expect(oauthFixtureCalls()).toBe(1);
    });

    it("marks refreshFailedAt on failure and treats the credential as absent for auto", async () => {
      await seedStaleOAuth();
      // GitHub returns HTTP 200 with an error body on a bad refresh token.
      fixture = startGithubFixture({
        oauthAccessToken: () => ({ status: 200, body: { error: "bad_refresh_token", error_description: "expired" } }),
      });

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "git", repo: { owner: "nobody", name: "r" } });
      expect(result).toEqual({ token: null, source: "none" }); // fell through to tokenless

      const persisted = await credentials.get({ type: "user", id: userId }, "github");
      expect(persisted?.accessToken).toBe("old-access"); // credential kept
      const metadata = persisted?.metadata as Record<string, unknown>;
      expect(metadata.refreshFailedAt).toBe(NOW);
      expect(metadata.login).toBe("octocat");
    });

    it("STRICT-throws for explicit auth:user when refresh fails", async () => {
      await seedStaleOAuth();
      fixture = startGithubFixture({
        oauthAccessToken: () => ({ status: 200, body: { error: "bad_refresh_token" } }),
      });

      await expect(resolveGitHubToken(deps(), { orgId, userId, purpose: "api", auth: "user" })).rejects.toThrow(
        GitHubAuthError,
      );
    });

    it("a throwing loadAppConfig (malformed github_app row) falls through to the next tier in auto and marks refreshFailedAt — never propagates", async () => {
      // A malformed github_app credential row: metadata.appId is missing, so
      // `loadAppConfig` throws instead of returning null. `performRefresh`
      // must catch this, not let it reject the single-flight promise.
      await credentials.save({ type: "org", id: orgId }, "github_app", {
        type: "service_account",
        apiKey: "pem",
        accessToken: "oauth-client-secret",
        refreshToken: "webhook-secret",
        metadata: { appSlug: "valet-app", oauthClientId: "Iv1.abc123", htmlUrl: "https://github.com/apps/valet-app" },
      });
      await saveUserGithub({
        type: "oauth2",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: NOW + 4 * 60 * 1000, // stale
        metadata: { login: "octocat" },
      });
      fixture = startGithubFixture();

      const result = await resolveGitHubToken(deps(), { orgId, userId, purpose: "git", repo: { owner: "nobody", name: "r" } });
      expect(result).toEqual({ token: null, source: "none" }); // fell through to tokenless, no unhandled rejection

      const persisted = await credentials.get({ type: "user", id: userId }, "github");
      expect(persisted?.accessToken).toBe("old-access"); // credential kept, unrotated
      const metadata = persisted?.metadata as Record<string, unknown>;
      expect(metadata.refreshFailedAt).toBe(NOW);
    });
  });

  // ── installation-mint HTTP failures ─────────────────────────────────
  describe("installation-mint HTTP failures", () => {
    it("wraps a non-2xx access_tokens response in GitHubAuthError", async () => {
      await saveAppConfig({ credentials }, orgId, appConfig);
      await seedInstallation();
      fixture = startGithubFixture({
        createInstallationToken: () => ({ status: 500, body: { message: "internal error" } }),
      });

      await expect(
        resolveGitHubToken(deps(), { orgId, userId, purpose: "git", repo: { owner: "acme", name: "repo" }, auth: "app" }),
      ).rejects.toBeInstanceOf(GitHubAuthError);
    });
  });
});
