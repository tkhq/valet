/**
 * Tests for SSO role sync: claim extraction, JWT payload decode, and the
 * `org_members.role` sync itself.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { extractMappedRole, decodeJwtClaims, syncSsoOrgRole } from "./sso-role-sync.js";

const roleMap = [
  { claimValue: "valet-admin", role: "admin" as const },
  { claimValue: "valet-operator", role: "operator" as const },
];

describe("extractMappedRole", () => {
  it("maps from userInfo dot-path (Keycloak realm_access.roles)", () => {
    const userInfo = { realm_access: { roles: ["offline_access", "valet-operator"] } };
    expect(extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo })).toBe("operator");
  });

  it("map order wins when multiple values match", () => {
    const userInfo = { realm_access: { roles: ["valet-operator", "valet-admin"] } };
    expect(extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo })).toBe("admin");
  });

  it("falls back to idTokenClaims when userInfo lacks the path", () => {
    const idTokenClaims = { realm_access: { roles: ["valet-admin"] } };
    expect(extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo: {}, idTokenClaims })).toBe("admin");
  });

  it("no match / absent claim → member", () => {
    expect(extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo: {} })).toBe("member");
    expect(
      extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo: { realm_access: { roles: ["other"] } } }),
    ).toBe("member");
  });

  it("accepts a bare string claim value (non-array)", () => {
    expect(extractMappedRole({ roleMap, roleClaim: "role", userInfo: { role: "valet-admin" } })).toBe("admin");
  });
});

describe("decodeJwtClaims", () => {
  it("decodes a base64url payload and rejects garbage", () => {
    const payload = Buffer.from(JSON.stringify({ realm_access: { roles: ["x"] } })).toString("base64url");
    expect(decodeJwtClaims(`h.${payload}.s`)).toEqual({ realm_access: { roles: ["x"] } });
    expect(decodeJwtClaims("nope")).toBeNull();
  });
});

describe("syncSsoOrgRole", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  async function seedOrgAndMember(userId: string, role: "admin" | "operator" | "member") {
    await db.insert(orgs).values({ id: "org1", name: "Org One", createdAt: Date.now() });
    await db.insert(users).values({ id: userId, email: `${userId}@x.test`, name: userId, role: "member" });
    await db.insert(orgMembers).values({ orgId: "org1", userId, role, createdAt: Date.now() });
  }

  it("updates org_members.role when it differs, and never touches users.role", async () => {
    await seedOrgAndMember("u1", "member");

    await syncSsoOrgRole(db, "u1", "operator");

    const [member] = await db.select().from(orgMembers).where(eq(orgMembers.userId, "u1"));
    expect(member?.role).toBe("operator");

    const [user] = await db.select().from(users).where(eq(users.id, "u1"));
    expect(user?.role).toBe("member");
  });

  it("is idempotent: syncing the same role again is a no-op that leaves the row correct", async () => {
    await seedOrgAndMember("u2", "member");

    await syncSsoOrgRole(db, "u2", "admin");
    await syncSsoOrgRole(db, "u2", "admin");

    const [member] = await db.select().from(orgMembers).where(eq(orgMembers.userId, "u2"));
    expect(member?.role).toBe("admin");
  });

  it("no-ops when there is no membership row for the user", async () => {
    await db.insert(users).values({ id: "u3", email: "u3@x.test", name: "u3", role: "member" });

    await expect(syncSsoOrgRole(db, "u3", "admin")).resolves.toBeUndefined();

    const rows = await db.select().from(orgMembers).where(eq(orgMembers.userId, "u3"));
    expect(rows).toHaveLength(0);
  });
});
