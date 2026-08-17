/**
 * The per-source reader resolver behind skill sync. The rule under test:
 * ONLY an org-scoped source may read through the org's GitHub App
 * installation; personal and team sources stay unauthenticated, and an org
 * source with no reachable installation falls back to the public reader
 * instead of failing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { orgs, githubInstallations, type SkillSourceRow } from "../schema/index.js";
import { saveAppConfig, type GithubAppConfig } from "./github-app.js";
import type { GitHubTokenDeps } from "./github-tokens.js";
import { skillSourceReaderProvider } from "./skill-source-reader.js";

const orgId = "org1";
const NOW = 1_700_000_000_000;

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

function sourceRow(overrides: Partial<SkillSourceRow> = {}): SkillSourceRow {
  return {
    id: "skillsrc_1",
    orgId,
    ownerType: "org",
    ownerId: orgId,
    repoFullName: "acme/skills",
    ref: "",
    subpath: "",
    enabled: true,
    status: "pending",
    attempts: 0,
    nextAttemptAt: NOW,
    lastSha: null,
    lastManifestHash: null,
    lastSyncedAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("skillSourceReaderProvider", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;
  let fixture: GithubFixture;

  beforeEach(async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
    fixture = startGithubFixture({
      getCommit: () => ({ body: { sha: "commit-1" } }),
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
  });

  afterEach(async () => {
    await fixture.close();
  });

  function deps(): GitHubTokenDeps {
    return {
      db,
      credentials,
      key: deriveSecretKey("cache-key"),
      apiUrl: fixture.url,
      githubUrl: fixture.url,
      now: () => NOW,
    };
  }

  async function seedInstallation(): Promise<void> {
    await db.insert(githubInstallations).values({
      id: "ghi_999",
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
    });
  }

  it("reads an org-scoped source with the App installation token", async () => {
    await saveAppConfig({ credentials }, orgId, appConfig);
    await seedInstallation();
    const readerFor = skillSourceReaderProvider(deps(), { apiUrl: fixture.url });

    const reader = await readerFor(sourceRow({ ownerType: "org" }));
    await reader.headSha("acme/skills", "");

    const commitCall = fixture.calls.find((c) => c.path.includes("/commits/"));
    expect(commitCall?.authHeader).toBe("Bearer inst-999");
  });

  it("falls back to the public reader when the App reaches no installation", async () => {
    const readerFor = skillSourceReaderProvider(deps(), { apiUrl: fixture.url });

    const reader = await readerFor(sourceRow({ ownerType: "org" }));
    expect(await reader.headSha("acme/skills", "")).toBe("commit-1");

    const commitCall = fixture.calls.find((c) => c.path.includes("/commits/"));
    expect(commitCall?.authHeader).toBeUndefined();
  });

  it("never authenticates a personal source, even with the App installed", async () => {
    await saveAppConfig({ credentials }, orgId, appConfig);
    await seedInstallation();
    const readerFor = skillSourceReaderProvider(deps(), { apiUrl: fixture.url });

    const reader = await readerFor(sourceRow({ ownerType: "user", ownerId: "u1" }));
    expect(await reader.headSha("acme/skills", "")).toBe("commit-1");

    const commitCall = fixture.calls.find((c) => c.path.includes("/commits/"));
    expect(commitCall?.authHeader).toBeUndefined();
    // No token was minted at all: the App's reach stays away from
    // non-org sources, it is not merely unused.
    expect(fixture.calls.some((c) => c.path.includes("/access_tokens"))).toBe(false);
  });
});
