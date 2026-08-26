/**
 * The tenancy rule for skill sync: which GitHub credential a source may use.
 *
 * These cases exist because picking the wrong credential here is a privilege
 * escalation, not a bug in a message. The rule under test is:
 *
 *   - a personal source uses its OWNER's credential;
 *   - a team source uses the credential of the user who ADDED it;
 *   - an org source uses the org's GitHub App installation token;
 *   - anything else reads anonymously.
 *
 * The negative cases matter most. A source must never borrow a credential
 * its owner does not hold, and it must never climb to the App to keep
 * working when its own credential is gone.
 *
 * The binding is checked on EVERY sync, not once when the row is written.
 * The row outlives the membership that justified it, so the cases below take
 * membership away — from the team, and from the org — and assert that the
 * credential goes with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { and, eq } from "drizzle-orm";
import {
  githubInstallations,
  orgMembers,
  orgs,
  teamMembers,
  teams,
  users,
  type SkillSourceRow,
} from "../schema/index.js";
import { saveAppConfig, type GithubAppConfig } from "./github-app.js";
import type { GitHubTokenDeps } from "./github-tokens.js";
import {
  GitHubSkillRepoReader,
  SkillRepoNotFoundError,
} from "./skill-repo-reader.js";
import { resolveSkillSourceCredential } from "./skill-source-credential.js";

const ORG = "org1";
const TEAM = "team_1";
const NOW = 1_700_000_000_000;

// A real RSA key: installation minting signs an App JWT with it. The fixture
// never verifies the signature, but `createPrivateKey` rejects a bogus PEM.
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

/** A source row shaped like one `createSkillSource` writes. */
function sourceRow(overrides: Partial<SkillSourceRow>): SkillSourceRow {
  return {
    id: "skillsrc_1",
    orgId: ORG,
    ownerType: "user",
    ownerId: "u1",
    createdBy: "u1",
    repoFullName: "tkhq/tk-brain",
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

describe("resolveSkillSourceCredential", () => {
  let db: AppDb;
  let pgdb: Awaited<ReturnType<typeof freshTestPgDb>>["pgdb"];
  let credentials: PgCredentialStore;
  let fixture: GithubFixture | undefined;

  beforeEach(async () => {
    const fresh = await freshTestPgDb();
    pgdb = fresh.pgdb;
    db = fresh.appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    for (const id of ["u1", "u2"]) {
      await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
      await db.insert(orgMembers).values({ orgId: ORG, userId: id, role: "member" });
    }
    // A real team with both users in it. The team cases below take membership
    // AWAY, which is the state that has to change the answer.
    await db.insert(teams).values({ id: TEAM, orgId: ORG, name: "Team", createdAt: NOW });
    for (const id of ["u1", "u2"]) {
      await db.insert(teamMembers).values({ teamId: TEAM, userId: id, role: "member" });
    }
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  function deps(): GitHubTokenDeps {
    return {
      db,
      credentials,
      key: deriveSecretKey("cache-key"),
      apiUrl: fixture?.url,
      githubUrl: fixture?.url,
      now: () => NOW,
    };
  }

  /** A healthy personal GitHub credential — a PAT, so no refresh is needed. */
  async function connectGitHub(userId: string, token: string, login: string): Promise<void> {
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: token,
      metadata: { login },
    });
  }

  /** An org GitHub App with one installation, and a fixture that mints for it. */
  async function installApp(): Promise<void> {
    await saveAppConfig({ credentials }, ORG, appConfig);
    await db.insert(githubInstallations).values({
      id: "ghi_999",
      orgId: ORG,
      installationId: 999,
      accountLogin: "tkhq",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  describe("a personal source", () => {
    it("uses its owner's own GitHub credential", async () => {
      await connectGitHub("u1", "ghu_u1", "octocat");
      fixture = startGithubFixture();

      const credential = await resolveSkillSourceCredential(deps(), sourceRow({}));

      expect(credential).toEqual({ kind: "user", token: "ghu_u1", ownerScope: "user", login: "octocat" });
    });

    it("never picks up another user's credential", async () => {
      // u2 is connected, u1 is not. A source u1 owns must stay anonymous.
      await connectGitHub("u2", "ghu_u2", "hubot");
      fixture = startGithubFixture();

      expect(await resolveSkillSourceCredential(deps(), sourceRow({}))).toEqual({ kind: "none" });
    });

    it("stays anonymous rather than climbing to the org App", async () => {
      // The escalation this whole module exists to prevent: an owner with no
      // GitHub connection must NOT be handed the App's reach, which covers
      // every repository the org installed it on.
      await installApp();
      fixture = startGithubFixture({
        createInstallationToken: () => ({
          body: { token: "ghs_install", expires_at: new Date(NOW + 3600_000).toISOString() },
        }),
      });

      expect(await resolveSkillSourceCredential(deps(), sourceRow({}))).toEqual({ kind: "none" });
      expect(fixture.calls.filter((c) => c.path.includes("access_tokens"))).toHaveLength(0);
    });

    it("stays anonymous rather than using the org's shared PAT", async () => {
      // An org-owned PAT is the last `auto` tier. Strict `auth: "user"` must
      // not reach it, or one person's source reads through the org's token.
      await credentials.save({ type: "org", id: ORG }, "github", {
        type: "oauth2",
        accessToken: "org_pat",
        metadata: { login: "tkhq-bot" },
      });
      fixture = startGithubFixture();

      expect(await resolveSkillSourceCredential(deps(), sourceRow({}))).toEqual({ kind: "none" });
    });

    it("stays anonymous when the connected account is identity-only", async () => {
      // Sign-in scopes cannot read repositories. Treating that credential as
      // usable would produce a 404 naming the wrong corrective action.
      await credentials.save({ type: "user", id: "u1" }, "github", {
        type: "oauth2",
        accessToken: "ghu_identity",
        metadata: { login: "octocat", identityOnly: true },
      });
      fixture = startGithubFixture();

      expect(await resolveSkillSourceCredential(deps(), sourceRow({}))).toEqual({ kind: "none" });
    });
  });

  describe("a team source", () => {
    it("uses the credential of the user who added it", async () => {
      await connectGitHub("u2", "ghu_u2", "hubot");
      fixture = startGithubFixture();

      const credential = await resolveSkillSourceCredential(
        deps(),
        sourceRow({ ownerType: "team", ownerId: TEAM, createdBy: "u2" }),
      );

      expect(credential).toEqual({ kind: "user", token: "ghu_u2", ownerScope: "team", login: "hubot" });
    });

    it("reads anonymously when the row names nobody", async () => {
      // Rows written before `created_by` existed. A sync must not guess an
      // identity, and must not fall back to the App.
      await installApp();
      await connectGitHub("u1", "ghu_u1", "octocat");
      fixture = startGithubFixture();

      const credential = await resolveSkillSourceCredential(
        deps(),
        sourceRow({ ownerType: "team", ownerId: TEAM, createdBy: null }),
      );

      expect(credential).toEqual({ kind: "none" });
    });

    it("drops to anonymous, not to the App, when the creator disconnects", async () => {
      await installApp();
      fixture = startGithubFixture({
        createInstallationToken: () => ({
          body: { token: "ghs_install", expires_at: new Date(NOW + 3600_000).toISOString() },
        }),
      });

      const credential = await resolveSkillSourceCredential(
        deps(),
        sourceRow({ ownerType: "team", ownerId: TEAM, createdBy: "u2" }),
      );

      expect(credential).toEqual({ kind: "none" });
    });

    it("drops the creator's credential once they leave the TEAM", async () => {
      // The case a creation-time check cannot cover. The row was legitimate
      // when it was written: u2 was a member and added the source with their
      // own credential. `removeMember` then deletes one `team_members` row
      // and nothing else. Without a re-check here the sweep keeps pulling a
      // private repository with the ex-member's token every interval, into
      // skill rows the remaining team reads, and any remaining member can
      // force a fresh pull with "Sync now".
      await connectGitHub("u2", "ghu_exmember", "hubot");
      fixture = startGithubFixture();
      const source = sourceRow({ ownerType: "team", ownerId: TEAM, createdBy: "u2" });

      // Legitimate while u2 is a member.
      expect(await resolveSkillSourceCredential(deps(), source)).toEqual({
        kind: "user",
        token: "ghu_exmember",
        ownerScope: "team",
        login: "hubot",
      });

      await db
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, TEAM), eq(teamMembers.userId, "u2")));

      expect(await resolveSkillSourceCredential(deps(), source)).toEqual({ kind: "none" });
    });

    it("drops the creator's credential once they leave the ORG", async () => {
      // De-provisioning by the Keycloak sweep, or removal from the org, both
      // delete only an `org_members` row. The team row can outlive it.
      await connectGitHub("u2", "ghu_exmember", "hubot");
      fixture = startGithubFixture();
      const source = sourceRow({ ownerType: "team", ownerId: TEAM, createdBy: "u2" });

      await db.delete(orgMembers).where(and(eq(orgMembers.orgId, ORG), eq(orgMembers.userId, "u2")));

      expect(await resolveSkillSourceCredential(deps(), source)).toEqual({ kind: "none" });
    });

    it("does not read the ex-member's credential out of the store at all", async () => {
      // The membership questions come BEFORE the token is resolved, so a
      // departed person's secret is never decrypted for this read.
      await connectGitHub("u2", "ghu_exmember", "hubot");
      fixture = startGithubFixture();
      await db
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, TEAM), eq(teamMembers.userId, "u2")));

      const spy = vi.spyOn(credentials, "get");
      await resolveSkillSourceCredential(
        deps(),
        sourceRow({ ownerType: "team", ownerId: TEAM, createdBy: "u2" }),
      );

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("a personal source whose owner left the org", () => {
    it("drops to anonymous", async () => {
      // A de-provisioned user's own source must stop syncing under their
      // token as well. Their `users` row and credential can both survive the
      // sweep that deletes the membership.
      await connectGitHub("u1", "ghu_u1", "octocat");
      fixture = startGithubFixture();

      await db.delete(orgMembers).where(and(eq(orgMembers.orgId, ORG), eq(orgMembers.userId, "u1")));

      expect(await resolveSkillSourceCredential(deps(), sourceRow({}))).toEqual({ kind: "none" });
    });
  });

  describe("a credential the server cannot read", () => {
    /** Deps whose credential store fails the way a rotated `ENCRYPTION_KEY`
     * does: `decryptSecret` throws a raw Node crypto error. */
    function depsWithUnreadableCredential(): GitHubTokenDeps {
      const broken = new PgCredentialStore(pgdb, deriveSecretKey("a-different-key"));
      return { ...deps(), credentials: broken };
    }

    it("reads anonymously instead of failing the sync", async () => {
      // Before this branch a source with no credential read anonymously and
      // worked. A fault in reading a credential must not take that away: a
      // public repository needs no credential, so it must keep syncing.
      await connectGitHub("u1", "ghu_u1", "octocat");
      fixture = startGithubFixture();

      const credential = await resolveSkillSourceCredential(
        depsWithUnreadableCredential(),
        sourceRow({}),
      );

      expect(credential).toEqual({ kind: "unavailable" });
    });

    it("names a corrective action rather than showing the crypto error", async () => {
      // The raw error is `Unsupported state or unable to authenticate data`,
      // which names nothing the user can do. It must not reach the row.
      await connectGitHub("u1", "ghu_u1", "octocat");
      fixture = startGithubFixture({
        getCommit: () => ({ status: 404, body: { message: "Not Found" } }),
      });
      const credential = await resolveSkillSourceCredential(
        depsWithUnreadableCredential(),
        sourceRow({}),
      );
      const reader = new GitHubSkillRepoReader({ apiUrl: fixture.url, credential });

      const err = await reader.head("tkhq/tk-brain", "").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SkillRepoNotFoundError);
      expect((err as Error).message).not.toContain("authenticate data");
      expect((err as Error).message).toContain("Connect GitHub again");
    });
  });

  describe("an org source", () => {
    it("uses the App installation token for the repository owner", async () => {
      await installApp();
      fixture = startGithubFixture({
        createInstallationToken: () => ({
          body: { token: "ghs_install", expires_at: new Date(NOW + 3600_000).toISOString() },
        }),
      });

      const credential = await resolveSkillSourceCredential(
        deps(),
        sourceRow({ ownerType: "org", ownerId: ORG, createdBy: "u1" }),
      );

      expect(credential).toEqual({ kind: "installation", token: "ghs_install" });
    });

    it("never falls back to the adding admin's own credential", async () => {
      // Strict `auth: "app"` in both directions. An org source is the org's,
      // and it must not quietly become one admin's personal reach.
      await connectGitHub("u1", "ghu_u1", "octocat");
      fixture = startGithubFixture();

      const credential = await resolveSkillSourceCredential(
        deps(),
        sourceRow({ ownerType: "org", ownerId: ORG, createdBy: "u1" }),
      );

      expect(credential).toEqual({ kind: "missing_app" });
    });

    it("reads anonymously when the App does not cover the repository owner", async () => {
      await installApp();
      fixture = startGithubFixture();

      const credential = await resolveSkillSourceCredential(
        deps(),
        sourceRow({ ownerType: "org", ownerId: ORG, repoFullName: "other-org/skills" }),
      );

      expect(credential).toEqual({ kind: "missing_app" });
    });

    it("names the App install when no token is available", async () => {
      fixture = startGithubFixture();
      const credential = await resolveSkillSourceCredential(
        deps(),
        sourceRow({ ownerType: "org", ownerId: ORG }),
      );
      expect(credential).toEqual({ kind: "missing_app" });
    });
  });

  it("carries no token material in what it returns for an anonymous read", async () => {
    fixture = startGithubFixture();
    expect(await resolveSkillSourceCredential(deps(), sourceRow({}))).toEqual({ kind: "none" });
  });
});
