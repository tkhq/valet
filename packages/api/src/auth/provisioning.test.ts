/**
 * Tests for auth provisioning: the admission rule and the better-auth hooks
 * that wire it into signup/social/SSO flows and post-create bookkeeping.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { APIError, type AuthMiddleware } from "better-auth/api";
import type { Account, BetterAuthOptions, User } from "better-auth";
import type { CredentialStore } from "@valet/engine";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { orgMembers, orgs, users, invites, teams, teamMembers } from "../schema/index.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { createInvite } from "./invites.js";
import { ensureOrg, setOrgFeatures } from "../services/org.js";
import type { AuthConfig } from "./config.js";
import type { InstanceConfig } from "../config/instance-config.js";
import { buildAuthHooks, evaluateAdmission, INVITE_REQUIRED_MESSAGE } from "./provisioning.js";

// better-auth's real `GenericEndpointContext` is a large request-plumbing object
// (session config, adapters, cookie helpers, rate-limit state, …) that's
// impractical to fabricate whole in a test, and isn't importable here without
// adding `@better-auth/core` as a direct dependency (it's better-auth's own
// transitive dep). `provisioning.ts`'s hook functions are deliberately typed
// against a narrower `HookContext` (`{ path?, body? }`) that every real context
// structurally satisfies — see that type's doc comment — so a real context
// always carries what these hooks read. These two helpers hold the single cast
// each bridging that gap; they don't paper over a genuine type disagreement.
type DbHookContext = Parameters<
  NonNullable<NonNullable<NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["user"]>["create"]>["before"]>
>[1];

function dbHookCtx(partial: { path: string; body?: Record<string, unknown> }): DbHookContext {
  return partial as DbHookContext;
}

function middlewareCtx(partial: { path: string; body?: Record<string, unknown> }): Parameters<AuthMiddleware>[0] {
  return partial as Parameters<AuthMiddleware>[0];
}

function baseConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: "test-secret",
    baseUrl: "http://localhost:8788",
    trustedOrigins: [],
    allowedEmailDomains: [],
    social: {},
    sandboxJwtMaster: "test-secret",
    ...overrides,
  };
}

async function seedUser(db: AppDb, id: string, email: string) {
  await db.insert(users).values({ id, email, name: id, role: "member" });
}

describe("evaluateAdmission", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("admits the first user in the db as admin, regardless of domain/invite", async () => {
    const cfg = baseConfig();
    const result = await evaluateAdmission(db, cfg, "anyone@nowhere.test");
    expect(result).toEqual({ allowed: true, role: "admin" });
  });

  it("admits a matching email domain as member (case-insensitive, exact domain)", async () => {
    await seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
    expect(await evaluateAdmission(db, cfg, "New@Example.COM")).toEqual({ allowed: true, role: "member" });
  });

  it("does NOT match a subdomain of an allowed domain", async () => {
    await seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
    expect(await evaluateAdmission(db, cfg, "user@sub.example.com")).toEqual({ allowed: false });
  });

  it("admits a valid invite by code with the invite's role", async () => {
    await seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig();
    const { invite, code } = await createInvite(db, { role: "admin", createdBy: "admin1" });
    expect(await evaluateAdmission(db, cfg, "whoever@nowhere.test", code)).toEqual({
      allowed: true,
      role: "admin",
      inviteId: invite.id,
    });
  });

  it("admits a valid invite by email with the invite's role, when no code is given", async () => {
    await seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig();
    const { invite } = await createInvite(db, { email: "invitee@nowhere.test", role: "member", createdBy: "admin1" });
    expect(await evaluateAdmission(db, cfg, "invitee@nowhere.test")).toEqual({
      allowed: true,
      role: "member",
      inviteId: invite.id,
    });
  });

  it("denies when nothing matches", async () => {
    await seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig();
    expect(await evaluateAdmission(db, cfg, "nobody@nowhere.test")).toEqual({ allowed: false });
  });

  it("precedence: first-user beats domain and invite", async () => {
    const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
    await createInvite(db, { email: "first@nowhere.test", role: "member", createdBy: "admin1" });
    // db has zero users still — first-user wins over domain match and invite.
    expect(await evaluateAdmission(db, cfg, "first@nowhere.test")).toEqual({ allowed: true, role: "admin" });
  });

  it("precedence: an admin invite beats an allowlisted domain (invite role wins, inviteId set)", async () => {
    await seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
    const { invite } = await createInvite(db, { email: "person@example.com", role: "admin", createdBy: "admin1" });
    // The invite rule runs before the domain rule, so a declared admin whose
    // domain is also allowlisted is admitted as admin, not downgraded to member.
    const result = await evaluateAdmission(db, cfg, "person@example.com");
    expect(result).toEqual({ allowed: true, role: "admin", inviteId: invite.id });
    // evaluateAdmission never mutates — the invite stays unaccepted until acceptInvite runs.
    const rows = await db.select().from(invites).where(eq(invites.id, invite.id)).limit(1);
    expect(rows[0]?.acceptedBy).toBeNull();
  });

  it("an allowlisted-domain email with NO invite falls through to the domain rule as member", async () => {
    await seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
    // No invite for this email — the domain rule is the fallback and grants member.
    expect(await evaluateAdmission(db, cfg, "nobody@example.com")).toEqual({ allowed: true, role: "member" });
  });

  it("a non-allowlisted email with an invite gets the invite's role (domain rule irrelevant)", async () => {
    await seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
    const { invite } = await createInvite(db, { email: "outsider@other.test", role: "member", createdBy: "admin1" });
    expect(await evaluateAdmission(db, cfg, "outsider@other.test")).toEqual({
      allowed: true,
      role: "member",
      inviteId: invite.id,
    });
  });

  it("an invalid/expired code falls back to an email-matched invite", async () => {
    await seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig();
    const { invite } = await createInvite(db, { email: "person@nowhere.test", role: "member", createdBy: "admin1" });
    expect(await evaluateAdmission(db, cfg, "person@nowhere.test", "not-a-real-code")).toEqual({
      allowed: true,
      role: "member",
      inviteId: invite.id,
    });
  });
});

function makeUser(overrides: Partial<User & Record<string, unknown>> = {}): User & Record<string, unknown> {
  const now = new Date();
  return {
    id: "u-new",
    email: "new@nowhere.test",
    name: "New User",
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
    role: "member",
    ...overrides,
  };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  const now = new Date();
  return {
    id: "acct-1",
    createdAt: now,
    updatedAt: now,
    providerId: "google",
    accountId: "google-sub-1",
    userId: "u-new",
    ...overrides,
  };
}

describe("buildAuthHooks", () => {
  let db: AppDb;
  let credentialStore: CredentialStore;

  beforeEach(async () => {
    const fresh = await freshTestPgDb();
    db = fresh.appDb;
    credentialStore = new PgCredentialStore(fresh.pgdb, deriveSecretKey("test-key"));
    // Seed one existing user so "first user → admin" doesn't dominate every test.
    await seedUser(db, "existing", "existing@x.test");
  });

  describe("beforeHook (signup invite gate)", () => {
    it("throws APIError with the exact rejection copy when signup is denied", async () => {
      const cfg = baseConfig();
      const { beforeHook } = buildAuthHooks({ db, cfg, credentialStore });

      let caught: unknown;
      try {
        await beforeHook(middlewareCtx({ path: "/sign-up/email", body: { email: "nobody@nowhere.test" } }));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(APIError);
      expect((caught as APIError).message).toBe(INVITE_REQUIRED_MESSAGE);
      expect((caught as APIError).message).toBe("an invite is required to join this deployment");
    });

    it("does not throw when the domain admits the signup", async () => {
      const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
      const { beforeHook } = buildAuthHooks({ db, cfg, credentialStore });
      await expect(
        beforeHook(middlewareCtx({ path: "/sign-up/email", body: { email: "person@example.com" } })),
      ).resolves.not.toThrow();
    });

    it("ignores non-signup paths entirely", async () => {
      const cfg = baseConfig();
      const { beforeHook } = buildAuthHooks({ db, cfg, credentialStore });
      await expect(beforeHook(middlewareCtx({ path: "/callback/google", body: {} }))).resolves.not.toThrow();
    });
  });

  describe("databaseHooks.user.create.before", () => {
    it("social path: denied without a matching invite (returns false)", async () => {
      const cfg = baseConfig();
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });
      const result = await databaseHooks!.user!.create!.before!(
        makeUser({ email: "outsider@nowhere.test" }),
        dbHookCtx({ path: "/callback/google" }),
      );
      expect(result).toBe(false);
    });

    it("social path: admitted with an email-targeted invite, role stamped from the invite", async () => {
      const cfg = baseConfig();
      const { invite } = await createInvite(db, { email: "invitee@nowhere.test", role: "admin", createdBy: "admin1" });
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });
      const result = await databaseHooks!.user!.create!.before!(
        makeUser({ email: "invitee@nowhere.test" }),
        dbHookCtx({ path: "/callback/google" }),
      );
      expect(result).not.toBe(false);
      expect(result).toMatchObject({ data: { role: "admin" } });
      // The invite is not yet consumed — that happens in `.after`.
      const rows = await db.select().from(invites).where(eq(invites.id, invite.id)).limit(1);
      expect(rows[0]?.acceptedBy).toBeNull();
    });

    it("SSO path: always admitted, role member for a non-first user", async () => {
      const cfg = baseConfig();
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });
      const result = await databaseHooks!.user!.create!.before!(
        makeUser({ email: "sso-user@nowhere.test" }),
        dbHookCtx({ path: "/sso/callback/keycloak" }),
      );
      expect(result).not.toBe(false);
      expect(result).toMatchObject({ data: { role: "member" } });
    });

    it("SSO path: first user (empty db) is stamped admin", async () => {
      const fresh = await freshTestPgDb();
      db = fresh.appDb;
      credentialStore = new PgCredentialStore(fresh.pgdb, deriveSecretKey("test-key"));
      const cfg = baseConfig();
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });
      const result = await databaseHooks!.user!.create!.before!(
        makeUser({ email: "first@nowhere.test" }),
        dbHookCtx({ path: "/sso/callback/keycloak" }),
      );
      expect(result).toMatchObject({ data: { role: "admin" } });
    });

    it("password signup path: role stamped from the admission rule (domain match)", async () => {
      const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });
      const result = await databaseHooks!.user!.create!.before!(
        makeUser({ email: "person@example.com" }),
        dbHookCtx({ path: "/sign-up/email", body: { email: "person@example.com" } }),
      );
      expect(result).toMatchObject({ data: { role: "member" } });
    });
  });

  describe("databaseHooks.user.create.after", () => {
    it("creates the org (if absent), inserts org_members, and accepts the matched invite", async () => {
      const cfg = baseConfig();
      const { invite } = await createInvite(db, { email: "invitee@nowhere.test", role: "admin", createdBy: "admin1" });
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });

      const user = makeUser({ id: "u-invitee", email: "invitee@nowhere.test" });
      const before = await databaseHooks!.user!.create!.before!(user, dbHookCtx({ path: "/callback/google" }));
      expect(before).not.toBe(false);
      const stampedRole = (before as { data: { role: string } }).data.role;

      // Simulate the persisted row `.after` receives: same email, stamped role.
      await db
        .insert(users)
        .values({ id: user.id, email: user.email, name: user.name, role: stampedRole as "admin" | "member" });
      await databaseHooks!.user!.create!.after!({ ...user, role: stampedRole }, dbHookCtx({ path: "/callback/google" }));

      const orgRows = await db.select().from(orgs).limit(1);
      const org = orgRows[0];
      expect(org).toBeDefined();
      const membershipRows = await db
        .select()
        .from(orgMembers)
        .where(eq(orgMembers.userId, "u-invitee"))
        .limit(1);
      expect(membershipRows[0]).toMatchObject({ orgId: org!.id, userId: "u-invitee", role: "admin" });

      const inviteRows = await db.select().from(invites).where(eq(invites.id, invite.id)).limit(1);
      expect(inviteRows[0]?.acceptedBy).toBe("u-invitee");
    });

    it("reuses the existing org row rather than creating a second one", async () => {
      const cfg = baseConfig();
      await db.insert(orgs).values({ id: "org-preexisting", name: "Pre-existing", createdAt: Date.now() });
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });

      const user = makeUser({ id: "u-plain", email: "plain@nowhere.test", role: "member" });
      await db.insert(users).values({ id: user.id, email: user.email, name: user.name, role: "member" });
      await databaseHooks!.user!.create!.after!(user, dbHookCtx({ path: "/callback/google" }));

      const allOrgs = await db.select().from(orgs);
      expect(allOrgs).toHaveLength(1);
      expect(allOrgs[0].id).toBe("org-preexisting");
    });
  });

  describe("databaseHooks.account.create.after", () => {
    it("writes google tokens to the credential store under both google plugin services", async () => {
      const cfg = baseConfig();
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });

      await databaseHooks!.account!.create!.after!(
        makeAccount({ providerId: "google", userId: "u-new", accessToken: "gtok", refreshToken: "grefresh" }),
        dbHookCtx({ path: "/callback/google" }),
      );

      const calendarCred = await credentialStore.get({ type: "user", id: "u-new" }, "google_calendar");
      const workspaceCred = await credentialStore.get({ type: "user", id: "u-new" }, "google_workspace");
      expect(calendarCred).toEqual({ type: "oauth2", accessToken: "gtok", refreshToken: "grefresh" });
      expect(workspaceCred).toEqual({ type: "oauth2", accessToken: "gtok", refreshToken: "grefresh" });
    });

    it("writes github tokens as identity-only, capturing expiresAt from the account row", async () => {
      const cfg = baseConfig();
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });
      const expiresAt = new Date("2026-08-01T00:00:00Z");

      await databaseHooks!.account!.create!.after!(
        makeAccount({ providerId: "github", userId: "u-new", accessToken: "htok", accessTokenExpiresAt: expiresAt }),
        dbHookCtx({ path: "/callback/github" }),
      );

      const cred = await credentialStore.get({ type: "user", id: "u-new" }, "github");
      expect(cred).toEqual({
        type: "oauth2",
        accessToken: "htok",
        refreshToken: undefined,
        expiresAt: expiresAt.getTime(),
        metadata: { identityOnly: true },
      });
    });

    it("writes github tokens with expiresAt undefined when the account row has no expiry", async () => {
      const cfg = baseConfig();
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });

      await databaseHooks!.account!.create!.after!(
        makeAccount({ providerId: "github", userId: "u-new", accessToken: "htok" }),
        dbHookCtx({ path: "/callback/github" }),
      );

      const cred = await credentialStore.get({ type: "user", id: "u-new" }, "github");
      expect(cred).toEqual({
        type: "oauth2",
        accessToken: "htok",
        refreshToken: undefined,
        expiresAt: undefined,
        metadata: { identityOnly: true },
      });
    });

    it("ignores password accounts (providerId: credential) — nothing written", async () => {
      const cfg = baseConfig();
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });

      await databaseHooks!.account!.create!.after!(
        makeAccount({ providerId: "credential", userId: "u-new", accessToken: undefined, accountId: "u-new" }),
        dbHookCtx({ path: "/sign-up/email" }),
      );

      const cred = await credentialStore.get({ type: "user", id: "u-new" }, "github");
      const calCred = await credentialStore.get({ type: "user", id: "u-new" }, "google_calendar");
      expect(cred).toBeNull();
      expect(calCred).toBeNull();
    });

    it("ignores social accounts with no access token", async () => {
      const cfg = baseConfig();
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });

      await databaseHooks!.account!.create!.after!(
        makeAccount({ providerId: "google", userId: "u-new", accessToken: undefined }),
        dbHookCtx({ path: "/callback/google" }),
      );

      const cred = await credentialStore.get({ type: "user", id: "u-new" }, "google_calendar");
      expect(cred).toBeNull();
    });
  });

  describe("databaseHooks.user.create.after — instanceConfig team bind", () => {
    function makeInstanceConfig(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
      return { version: 1, ...overrides };
    }

    it("inserts a team_members row when the new user's email is declared in a config team", async () => {
      const cfg = baseConfig();
      // Create the org and team row the provisioner will look up. The row
      // carries `origin: "config"` because that is what the boot reconciler
      // stamps on a declared team, and the bind writes config rows only.
      const orgId = "org-team-test";
      await db.insert(orgs).values({ id: orgId, name: "Team Test Org", createdAt: Date.now() });
      await db
        .insert(teams)
        .values({ id: "team-platform", orgId, name: "Platform", origin: "config", createdAt: Date.now() });

      const instanceConfig = makeInstanceConfig({
        teams: [{ name: "Platform", members: [{ email: "member@example.com", role: "admin" }] }],
      });

      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore, instanceConfig });

      const user = makeUser({ id: "u-member", email: "member@example.com", role: "member" });
      await db.insert(users).values({ id: user.id, email: user.email, name: user.name, role: "member" });
      await databaseHooks!.user!.create!.after!({ ...user }, dbHookCtx({ path: "/sign-up/email" }));

      const rows = await db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.userId, "u-member"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ teamId: "team-platform", userId: "u-member", role: "admin" });
    });

    it("does not insert a team_members row when the new user's email is not declared", async () => {
      const cfg = baseConfig();
      const orgId = "org-team-test2";
      await db.insert(orgs).values({ id: orgId, name: "Team Test Org 2", createdAt: Date.now() });
      await db
        .insert(teams)
        .values({ id: "team-eng", orgId, name: "Engineering", origin: "config", createdAt: Date.now() });

      const instanceConfig = makeInstanceConfig({
        teams: [{ name: "Engineering", members: [{ email: "declared@example.com", role: "member" }] }],
      });

      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore, instanceConfig });

      const user = makeUser({ id: "u-undeclared", email: "undeclared@example.com", role: "member" });
      await db.insert(users).values({ id: user.id, email: user.email, name: user.name, role: "member" });
      await databaseHooks!.user!.create!.after!({ ...user }, dbHookCtx({ path: "/sign-up/email" }));

      const rows = await db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.userId, "u-undeclared"));
      expect(rows).toHaveLength(0);
    });

    it("does not bind to a same-named team the identity provider owns", async () => {
      // The reconciler fails boot on this collision, so it can only exist
      // between a config edit and the next restart. Until then the scope on
      // the lookup is what stops the bind: writing here would add a member
      // that the next group claim removes, once per login, forever.
      const cfg = baseConfig();
      const orgId = "org-team-test-idp";
      await db.insert(orgs).values({ id: orgId, name: "Idp Collision Org", createdAt: Date.now() });
      await db.insert(teams).values({
        id: "team-mirror",
        orgId,
        name: "Platform",
        origin: "idp",
        externalId: "/platform",
        createdAt: Date.now(),
      });

      const instanceConfig = makeInstanceConfig({
        teams: [{ name: "Platform", members: [{ email: "member@example.com", role: "admin" }] }],
      });

      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore, instanceConfig });

      const user = makeUser({ id: "u-collide", email: "member@example.com", role: "member" });
      await db.insert(users).values({ id: user.id, email: user.email, name: user.name, role: "member" });
      await databaseHooks!.user!.create!.after!({ ...user }, dbHookCtx({ path: "/sign-up/email" }));

      const rows = await db.select().from(teamMembers).where(eq(teamMembers.userId, "u-collide"));
      expect(rows).toHaveLength(0);
    });

    it("does not throw when a declared team is missing from the db", async () => {
      const cfg = baseConfig();
      // No team row created — team "Missing" does not exist in db.
      const instanceConfig = makeInstanceConfig({
        teams: [{ name: "Missing", members: [{ email: "member@example.com", role: "member" }] }],
      });

      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore, instanceConfig });

      const user = makeUser({ id: "u-missing-team", email: "member@example.com", role: "member" });
      await db.insert(users).values({ id: user.id, email: user.email, name: user.name, role: "member" });
      await expect(
        databaseHooks!.user!.create!.after!({ ...user }, dbHookCtx({ path: "/sign-up/email" })),
      ).resolves.not.toThrow();

      // No team_members row written.
      const rows = await db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.userId, "u-missing-team"));
      expect(rows).toHaveLength(0);
    });
  });

  describe("provisionUser (team sync)", () => {
    const ssoUser = { id: "existing", email: "existing@x.test" };

    function ssoConfig(overrides: { teamGroups?: string[] } = {}): AuthConfig {
      return baseConfig({
        oidc: {
          issuer: "https://idp.test/realms/valet",
          clientId: "valet",
          clientSecret: "shh",
          name: "SSO",
          domain: "idp.test",
          teamClaim: "groups",
          teamAssertedClaim: "groups_asserted",
          teamAdminGroup: "admins",
          // The allowlist. Declared in every test that expects a team,
          // because an absent list mirrors nothing.
          teamGroups: ["/platform", "/research"],
          ...overrides,
        },
      });
    }

    /**
     * Puts the deployment in the state an operator reaches deliberately:
     * an org exists and `ssoTeamSync` is on. Returns the org id.
     *
     * Nothing here is the default. A test that does not call this is testing
     * a deployment that set nothing, which must mirror nothing.
     */
    async function enableMirroring(): Promise<string> {
      const org = await ensureOrg(db);
      await setOrgFeatures(db, org.id, { ssoTeamSync: true });
      return org.id;
    }

    async function teamsOf(userId: string): Promise<Array<{ team: string; role: string }>> {
      return db
        .select({ team: teams.name, role: teamMembers.role })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(eq(teamMembers.userId, userId))
        .orderBy(teams.name);
    }

    async function allTeams(): Promise<Array<{ id: string; name: string; origin: string }>> {
      return db.select({ id: teams.id, name: teams.name, origin: teams.origin }).from(teams).orderBy(teams.name);
    }

    it("mirrors the group claim into teams on a sign-in", async () => {
      await enableMirroring();
      const { provisionUser } = buildAuthHooks({ db, cfg: ssoConfig(), credentialStore });

      await provisionUser({
        user: ssoUser,
        userInfo: { groups: ["/platform/admins", "/research"], groups_asserted: "true" },
      });

      expect(await teamsOf("existing")).toEqual([
        { team: "platform", role: "admin" },
        { team: "research", role: "member" },
      ]);
    });

    it("changes nothing when the group claim is missing", async () => {
      await enableMirroring();
      const { provisionUser } = buildAuthHooks({ db, cfg: ssoConfig(), credentialStore });
      await provisionUser({ user: ssoUser, userInfo: { groups: ["/platform"], groups_asserted: "true" } });

      // Same user, next sign-in, mapper no longer configured.
      await provisionUser({ user: ssoUser, userInfo: { email: ssoUser.email } });

      expect(await teamsOf("existing")).toEqual([{ team: "platform", role: "member" }]);
    });

    it("empties the mirrored teams when the marker arrives without groups", async () => {
      await enableMirroring();
      const { provisionUser } = buildAuthHooks({ db, cfg: ssoConfig(), credentialStore });
      await provisionUser({ user: ssoUser, userInfo: { groups: ["/platform"], groups_asserted: "true" } });

      await provisionUser({ user: ssoUser, userInfo: { groups_asserted: "true" } });

      expect(await teamsOf("existing")).toEqual([]);
    });

    it("does nothing when no OIDC provider is configured", async () => {
      const { provisionUser } = buildAuthHooks({ db, cfg: baseConfig(), credentialStore });

      await provisionUser({
        user: ssoUser,
        userInfo: { groups: ["/platform"], groups_asserted: "true" },
      });

      expect(await teamsOf("existing")).toEqual([]);
    });

    it("swallows a database fault instead of blocking the sign-in", async () => {
      // The plugin awaits this hook BEFORE it sets the session cookie, so an
      // exception here locks everybody out. Dropping the table the reconcile
      // reads first is the fault; the next test re-applies the migrations.
      await enableMirroring();
      const { provisionUser } = buildAuthHooks({ db, cfg: ssoConfig(), credentialStore });
      await db.execute(sql`DROP TABLE "teams" CASCADE`);

      await expect(
        provisionUser({
          user: ssoUser,
          userInfo: { groups: ["/platform"], groups_asserted: "true" },
        }),
      ).resolves.toBeUndefined();
    });
  });

  /**
   * The `ssoTeamSync` gate. Off is the default, and the first test here is
   * the property the whole feature exists for.
   */
  describe("provisionUser — the ssoTeamSync gate", () => {
    const ssoUser = { id: "existing", email: "existing@x.test" };

    function ssoConfig(teamGroups: string[] = ["/platform", "/research"]): AuthConfig {
      return baseConfig({
        oidc: {
          issuer: "https://idp.test/realms/valet",
          clientId: "valet",
          clientSecret: "shh",
          name: "SSO",
          domain: "idp.test",
          teamClaim: "groups",
          teamAssertedClaim: "groups_asserted",
          teamAdminGroup: "admins",
          teamGroups,
        },
      });
    }

    async function teamsOf(userId: string): Promise<Array<{ team: string; role: string }>> {
      return db
        .select({ team: teams.name, role: teamMembers.role })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(eq(teamMembers.userId, userId))
        .orderBy(teams.name);
    }

    async function teamRows(): Promise<Array<{ id: string; name: string; origin: string }>> {
      return db
        .select({ id: teams.id, name: teams.name, origin: teams.origin })
        .from(teams)
        .orderBy(teams.name);
    }

    /** A team an earlier release mirrored, before the gate existed. */
    async function seedMirroredTeam(orgId: string, name: string, path: string): Promise<string> {
      const id = `team_${name}`;
      await db.insert(teams).values({
        id,
        orgId,
        name,
        origin: "idp",
        externalId: path,
        createdAt: Date.now(),
      });
      await db.insert(teamMembers).values({ teamId: id, userId: "existing", role: "admin" });
      return id;
    }

    it("an operator who sets nothing mirrors no group and loses no team", async () => {
      // THE property. An upgrade must not create teams nobody asked for, and
      // it must not take away the teams and memberships that already exist —
      // a mirrored team can own skills, sources and workflows, so deleting
      // one takes that work from people who changed no setting.
      const org = await ensureOrg(db);
      const kept = await seedMirroredTeam(org.id, "platform", "/platform");

      const { provisionUser } = buildAuthHooks({ db, cfg: ssoConfig(), credentialStore });
      await provisionUser({
        user: ssoUser,
        userInfo: { groups: ["/platform", "/research"], groups_asserted: "true" },
      });

      // No new team, and the old one is untouched — same row, same members.
      expect(await teamRows()).toEqual([{ id: kept, name: "platform", origin: "idp" }]);
      expect(await teamsOf("existing")).toEqual([{ team: "platform", role: "admin" }]);
    });

    it("creates no org when there is none, so a login writes nothing at all", async () => {
      // The gate lives on the org row. Reading it must not be the thing that
      // creates the org it reads.
      const { provisionUser } = buildAuthHooks({ db, cfg: ssoConfig(), credentialStore });
      await provisionUser({
        user: ssoUser,
        userInfo: { groups: ["/platform"], groups_asserted: "true" },
      });

      expect(await db.select({ id: orgs.id }).from(orgs)).toEqual([]);
      expect(await teamRows()).toEqual([]);
    });

    it("mirrors a listed group once the gate is on", async () => {
      const org = await ensureOrg(db);
      await setOrgFeatures(db, org.id, { ssoTeamSync: true });

      const { provisionUser } = buildAuthHooks({ db, cfg: ssoConfig(), credentialStore });
      await provisionUser({
        user: ssoUser,
        userInfo: { groups: ["/platform/admins"], groups_asserted: "true" },
      });

      expect(await teamsOf("existing")).toEqual([{ team: "platform", role: "admin" }]);
    });

    it("ignores a group the allowlist leaves out", async () => {
      // The operator's stated fear: an identity provider full of groups that
      // have nothing to do with Valet.
      const org = await ensureOrg(db);
      await setOrgFeatures(db, org.id, { ssoTeamSync: true });

      const { provisionUser } = buildAuthHooks({ db, cfg: ssoConfig(["/platform"]), credentialStore });
      await provisionUser({
        user: ssoUser,
        userInfo: {
          groups: ["/platform", "/everyone", "/vpn-users", "/contractors-2021"],
          groups_asserted: "true",
        },
      });

      expect(await teamRows()).toEqual([
        expect.objectContaining({ name: "platform", origin: "idp" }),
      ]);
    });

    it("mirrors nothing when the gate is on and no group is listed", async () => {
      const org = await ensureOrg(db);
      await setOrgFeatures(db, org.id, { ssoTeamSync: true });

      const { provisionUser } = buildAuthHooks({ db, cfg: ssoConfig([]), credentialStore });
      await provisionUser({
        user: ssoUser,
        userInfo: { groups: ["/platform", "/research"], groups_asserted: "true" },
      });

      expect(await teamRows()).toEqual([]);
    });

    it("keeps syncing identity while team mirroring is off", async () => {
      // Turning team mirroring off must not turn identity sync off. The
      // role and the org membership come from the user-create hooks, which
      // never read the gate.
      const cfg = ssoConfig();
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });

      const newUser = makeUser({ id: "u-sso", email: "new@idp.test" });
      const ctx = dbHookCtx({ path: "/sso/callback/valet" });
      const before = await databaseHooks!.user!.create!.before!(newUser, ctx);
      expect(before).not.toBe(false);
      const stampedRole = (before as { data: { role: string } }).data.role;

      await db
        .insert(users)
        .values({
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          role: stampedRole as "admin" | "member",
        });
      await databaseHooks!.user!.create!.after!({ ...newUser, role: stampedRole }, ctx);

      // The org membership row exists, which is what gates every read path.
      const membership = await db
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(eq(orgMembers.userId, "u-sso"));
      expect(membership).toEqual([{ role: "member" }]);

      // And no team was mirrored, which is the half the gate turned off.
      const { provisionUser } = buildAuthHooks({ db, cfg, credentialStore });
      await provisionUser({
        user: { id: "u-sso", email: "new@idp.test" },
        userInfo: { groups: ["/platform"], groups_asserted: "true" },
      });
      expect(await teamRows()).toEqual([]);
    });

    it("converges on the same rows when the gate is turned on later", async () => {
      // No wipe and no re-import. The mirror is found by group path, so the
      // row it created before the gate went off is the row it adopts again.
      const org = await ensureOrg(db);
      await setOrgFeatures(db, org.id, { ssoTeamSync: true });
      const { provisionUser } = buildAuthHooks({ db, cfg: ssoConfig(), credentialStore });

      await provisionUser({
        user: ssoUser,
        userInfo: { groups: ["/platform"], groups_asserted: "true" },
      });
      const [created] = await teamRows();
      expect(created).toMatchObject({ name: "platform", origin: "idp" });

      // Off: the login writes nothing, and the team keeps its member.
      await setOrgFeatures(db, org.id, { ssoTeamSync: false });
      await provisionUser({ user: ssoUser, userInfo: { groups: [], groups_asserted: "true" } });
      expect(await teamsOf("existing")).toEqual([{ team: "platform", role: "member" }]);

      // On again: same row id, and the claim is authoritative once more.
      await setOrgFeatures(db, org.id, { ssoTeamSync: true });
      await provisionUser({
        user: ssoUser,
        userInfo: { groups: ["/platform/admins"], groups_asserted: "true" },
      });
      expect(await teamRows()).toEqual([{ id: created?.id, name: "platform", origin: "idp" }]);
      expect(await teamsOf("existing")).toEqual([{ team: "platform", role: "admin" }]);
    });
  });
});
