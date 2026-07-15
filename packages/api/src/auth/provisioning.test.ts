/**
 * Tests for auth provisioning: the admission rule and the better-auth hooks
 * that wire it into signup/social/SSO flows and post-create bookkeeping.
 */
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { APIError, type AuthMiddleware } from "better-auth/api";
import type { Account, BetterAuthOptions, User } from "better-auth";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { orgMembers, orgs, users, invites } from "../schema/index.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { SqliteCredentialStore } from "../plugins/credential-store.js";
import { createInvite } from "./invites.js";
import type { AuthConfig } from "./config.js";
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

function seedUser(db: AppDb, id: string, email: string) {
  db.insert(users).values({ id, email, name: id, role: "member" }).run();
}

describe("evaluateAdmission", () => {
  let sqlite: Database.Database;
  let db: AppDb;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    applyAppMigrations(sqlite);
    db = buildAppDb(sqlite);
  });

  it("admits the first user in the db as admin, regardless of domain/invite", () => {
    const cfg = baseConfig();
    const result = evaluateAdmission(db, cfg, "anyone@nowhere.test");
    expect(result).toEqual({ allowed: true, role: "admin" });
  });

  it("admits a matching email domain as member (case-insensitive, exact domain)", () => {
    seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
    expect(evaluateAdmission(db, cfg, "New@Example.COM")).toEqual({ allowed: true, role: "member" });
  });

  it("does NOT match a subdomain of an allowed domain", () => {
    seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
    expect(evaluateAdmission(db, cfg, "user@sub.example.com")).toEqual({ allowed: false });
  });

  it("admits a valid invite by code with the invite's role", () => {
    seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig();
    const { invite, code } = createInvite(db, { role: "admin", createdBy: "admin1" });
    expect(evaluateAdmission(db, cfg, "whoever@nowhere.test", code)).toEqual({
      allowed: true,
      role: "admin",
      inviteId: invite.id,
    });
  });

  it("admits a valid invite by email with the invite's role, when no code is given", () => {
    seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig();
    const { invite } = createInvite(db, { email: "invitee@nowhere.test", role: "member", createdBy: "admin1" });
    expect(evaluateAdmission(db, cfg, "invitee@nowhere.test")).toEqual({
      allowed: true,
      role: "member",
      inviteId: invite.id,
    });
  });

  it("denies when nothing matches", () => {
    seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig();
    expect(evaluateAdmission(db, cfg, "nobody@nowhere.test")).toEqual({ allowed: false });
  });

  it("precedence: first-user beats domain and invite", () => {
    const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
    createInvite(db, { email: "first@nowhere.test", role: "member", createdBy: "admin1" });
    // db has zero users still — first-user wins over domain match and invite.
    expect(evaluateAdmission(db, cfg, "first@nowhere.test")).toEqual({ allowed: true, role: "admin" });
  });

  it("precedence: domain match beats invite", () => {
    seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig({ allowedEmailDomains: ["example.com"] });
    const { invite } = createInvite(db, { email: "person@example.com", role: "admin", createdBy: "admin1" });
    // Domain match resolves to "member" even though an admin invite also matches this email.
    const result = evaluateAdmission(db, cfg, "person@example.com");
    expect(result).toEqual({ allowed: true, role: "member" });
    // The invite itself is untouched (evaluateAdmission never mutates).
    const row = db.select().from(invites).where(eq(invites.id, invite.id)).get();
    expect(row?.acceptedBy).toBeNull();
  });

  it("an invalid/expired code falls back to an email-matched invite", () => {
    seedUser(db, "u1", "existing@x.test");
    const cfg = baseConfig();
    const { invite } = createInvite(db, { email: "person@nowhere.test", role: "member", createdBy: "admin1" });
    expect(evaluateAdmission(db, cfg, "person@nowhere.test", "not-a-real-code")).toEqual({
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
  let sqlite: Database.Database;
  let db: AppDb;
  let credentialStore: SqliteCredentialStore;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    applyAppMigrations(sqlite);
    db = buildAppDb(sqlite);
    credentialStore = new SqliteCredentialStore(db as AppDb & { $client: Database.Database }, deriveSecretKey("test-key"));
    // Seed one existing user so "first user → admin" doesn't dominate every test.
    seedUser(db, "existing", "existing@x.test");
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
      const { invite } = createInvite(db, { email: "invitee@nowhere.test", role: "admin", createdBy: "admin1" });
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });
      const result = await databaseHooks!.user!.create!.before!(
        makeUser({ email: "invitee@nowhere.test" }),
        dbHookCtx({ path: "/callback/google" }),
      );
      expect(result).not.toBe(false);
      expect(result).toMatchObject({ data: { role: "admin" } });
      // The invite is not yet consumed — that happens in `.after`.
      const row = db.select().from(invites).where(eq(invites.id, invite.id)).get();
      expect(row?.acceptedBy).toBeNull();
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
      sqlite = new Database(":memory:");
      sqlite.pragma("journal_mode = WAL");
      applyAppMigrations(sqlite);
      db = buildAppDb(sqlite);
      credentialStore = new SqliteCredentialStore(db as AppDb & { $client: Database.Database }, deriveSecretKey("test-key"));
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
      const { invite } = createInvite(db, { email: "invitee@nowhere.test", role: "admin", createdBy: "admin1" });
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });

      const user = makeUser({ id: "u-invitee", email: "invitee@nowhere.test" });
      const before = await databaseHooks!.user!.create!.before!(user, dbHookCtx({ path: "/callback/google" }));
      expect(before).not.toBe(false);
      const stampedRole = (before as { data: { role: string } }).data.role;

      // Simulate the persisted row `.after` receives: same email, stamped role.
      db.insert(users).values({ id: user.id, email: user.email, name: user.name, role: stampedRole as "admin" | "member" }).run();
      await databaseHooks!.user!.create!.after!({ ...user, role: stampedRole }, dbHookCtx({ path: "/callback/google" }));

      const org = db.select().from(orgs).get();
      expect(org).toBeDefined();
      const membership = db
        .select()
        .from(orgMembers)
        .where(eq(orgMembers.userId, "u-invitee"))
        .get();
      expect(membership).toMatchObject({ orgId: org!.id, userId: "u-invitee", role: "admin" });

      const inviteRow = db.select().from(invites).where(eq(invites.id, invite.id)).get();
      expect(inviteRow?.acceptedBy).toBe("u-invitee");
    });

    it("reuses the existing org row rather than creating a second one", async () => {
      const cfg = baseConfig();
      db.insert(orgs).values({ id: "org-preexisting", name: "Pre-existing", createdAt: Date.now() }).run();
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });

      const user = makeUser({ id: "u-plain", email: "plain@nowhere.test", role: "member" });
      db.insert(users).values({ id: user.id, email: user.email, name: user.name, role: "member" }).run();
      await databaseHooks!.user!.create!.after!(user, dbHookCtx({ path: "/callback/google" }));

      const allOrgs = db.select().from(orgs).all();
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

    it("writes github tokens to the credential store under the github service", async () => {
      const cfg = baseConfig();
      const { databaseHooks } = buildAuthHooks({ db, cfg, credentialStore });

      await databaseHooks!.account!.create!.after!(
        makeAccount({ providerId: "github", userId: "u-new", accessToken: "htok" }),
        dbHookCtx({ path: "/callback/github" }),
      );

      const cred = await credentialStore.get({ type: "user", id: "u-new" }, "github");
      expect(cred).toEqual({ type: "oauth2", accessToken: "htok", refreshToken: undefined });
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
});
