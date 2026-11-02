import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { account, invites, orgMembers, users } from "../schema/index.js";
import { ensureOrg } from "../services/org.js";
import { createInvite } from "./invites.js";
import { evaluateAdmission } from "./provisioning.js";
import type { AuthConfig } from "./config.js";
import { AdminBootstrapError, BOOTSTRAP_INVITE_CREATOR, ensureAdminAccess, ensureBootstrapAdminInvite } from "./bootstrap-admin.js";

function codeOf(link: string): string {
  const code = new URL(link, "http://valet.test").searchParams.get("invite");
  if (!code) throw new Error("expected a sign-up link with an invite code");
  return code;
}

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    methods: ["password"], primaryMethod: "password",
    secret: "test-secret", baseUrl: "http://localhost:8788", trustedOrigins: [], allowedEmailDomains: [],
    social: {}, sandboxJwtMaster: "test-secret", ...overrides,
  };
}

const sso: AuthConfig["oidc"] = {
  issuer: "https://idp.corp.test/realms/corp", clientId: "valet", clientSecret: "secret", name: "Corp SSO", domain: "corp.test",
  teamClaim: "groups", teamAssertedClaim: "groups_asserted", teamAdminGroup: "admins",
};

async function addUser(db: AppDb, id: string, email: string, role: "admin" | "member", opts: { verified?: boolean; provider?: string } = {}) {
  const org = await ensureOrg(db);
  await db.insert(users).values({ id, email, name: id, role: "member", emailVerified: opts.verified ?? false });
  await db.insert(orgMembers).values({ orgId: org.id, userId: id, role, createdAt: Date.now() });
  const now = new Date();
  await db.insert(account).values({ id: `acct-${id}`, accountId: id, providerId: opts.provider ?? "credential", userId: id, createdAt: now, updatedAt: now });
}

async function bootstrapInvites(db: AppDb) {
  return db.select().from(invites).where(eq(invites.createdBy, BOOTSTRAP_INVITE_CREATOR));
}

describe("ensureAdminAccess", () => {
  let db: AppDb;
  let lines: string[];
  const log = (line: string) => { lines.push(line); };
  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    lines = [];
  });

  it("prints a one-time admin link when there is no admin and no SSO; only the newest link admits", async () => {
    await ensureAdminAccess(db, config(), { publicUrl: "https://valet.example.test/", log });
    const first = lines.join("\n").match(/https:\/\/valet\.example\.test\/signup\?invite=[0-9a-f]{32}/)?.[0];
    expect(first).toBeDefined();
    const second = await ensureBootstrapAdminInvite(db, { log });
    expect(await evaluateAdmission(db, config(), "a@x.test", codeOf(first!))).toEqual({ allowed: false });
    expect(await evaluateAdmission(db, config(), "a@x.test", codeOf(second))).toMatchObject({ allowed: true, role: "admin" });
  });

  it("stops boot when SSO is on, no admin exists, and nobody is declared", async () => {
    await expect(ensureAdminAccess(db, config({ oidc: sso }), { log })).rejects.toBeInstanceOf(AdminBootstrapError);
    await expect(ensureAdminAccess(db, config({ oidc: sso }), { log })).rejects.toThrow(/Set AUTH_ADMIN_EMAILS/);
    expect(await bootstrapInvites(db)).toHaveLength(0);
  });

  it("with SSO, accepts AUTH_ADMIN_EMAILS or a config admin as the way in, and prints no link", async () => {
    await ensureAdminAccess(db, config({ oidc: sso, adminEmails: ["boss@corp.test"] }), { log });
    expect(lines.join("\n")).toContain("boss@corp.test become admin on their first Corp SSO sign-in");
    lines = [];
    await createInvite(db, { email: "declared@corp.test", role: "admin", createdBy: "config" });
    await ensureAdminAccess(db, config({ oidc: sso }), { log });
    expect(lines.join("\n")).toContain("declared@corp.test");
    expect(await bootstrapInvites(db)).toHaveLength(0);
  });

  it("promotes a listed user with a verified identity, and skips a password-only unverified one", async () => {
    await addUser(db, "owner", "owner@corp.test", "admin");
    await addUser(db, "sso-boss", "Boss@corp.test", "member", { provider: "keycloak" });
    await addUser(db, "pw-ops", "ops@corp.test", "member");
    await ensureAdminAccess(db, config({ oidc: sso, adminEmails: ["boss@corp.test", "ops@corp.test"] }), { log });
    const roles = Object.fromEntries((await db.select().from(orgMembers)).map((m) => [m.userId, m.role]));
    expect(roles).toMatchObject({ owner: "admin", "sso-boss": "admin", "pw-ops": "member" });
    expect(lines.join("\n")).toMatch(/ops@corp\.test, but that account signed up with a password/);
  });

  it("does nothing once an admin exists, and removes an unused link", async () => {
    await ensureBootstrapAdminInvite(db, { log });
    await addUser(db, "owner", "owner@corp.test", "admin");
    await ensureAdminAccess(db, config(), { log });
    expect(await bootstrapInvites(db)).toHaveLength(0);
  });
});
