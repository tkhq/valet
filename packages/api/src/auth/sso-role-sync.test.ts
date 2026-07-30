/**
 * Tests for SSO role sync: claim extraction, JWT payload decode, and the
 * `org_members.role` sync itself.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
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
    expect(extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo })).toEqual({
      role: "operator",
      source: "matched",
      matchedClaim: "valet-operator",
      observedValues: ["offline_access", "valet-operator"],
    });
  });

  it("map order wins when multiple values match", () => {
    const userInfo = { realm_access: { roles: ["valet-operator", "valet-admin"] } };
    const result = extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo });
    expect(result.role).toBe("admin");
    expect(result.source).toBe("matched");
  });

  it("falls back to idTokenClaims when userInfo lacks the path", () => {
    const idTokenClaims = { realm_access: { roles: ["valet-admin"] } };
    const result = extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo: {}, idTokenClaims });
    expect(result.role).toBe("admin");
    expect(result.source).toBe("matched");
  });

  it("distinguishes absent claim (no-claim-values) from present-but-unmatched (no-map-match)", () => {
    // Absent: userInfo has no realm_access at all.
    expect(extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo: {} })).toEqual({
      role: "member",
      source: "no-claim-values",
      observedValues: [],
    });
    // Present-but-unmatched: values exist, none map.
    expect(
      extractMappedRole({ roleMap, roleClaim: "realm_access.roles", userInfo: { realm_access: { roles: ["other"] } } }),
    ).toEqual({
      role: "member",
      source: "no-map-match",
      observedValues: ["other"],
    });
  });

  it("accepts a bare string claim value (non-array)", () => {
    const result = extractMappedRole({ roleMap, roleClaim: "role", userInfo: { role: "valet-admin" } });
    expect(result.role).toBe("admin");
    expect(result.source).toBe("matched");
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

  it("refuses to demote the org's last admin", async () => {
    await seedOrgAndMember("u4", "admin");

    await syncSsoOrgRole(db, "u4", "member");

    const [member] = await db.select().from(orgMembers).where(eq(orgMembers.userId, "u4"));
    expect(member?.role).toBe("admin");
  });

  it("demotes an admin when another admin remains", async () => {
    await seedOrgAndMember("u5", "admin");
    await db.insert(users).values({ id: "u6", email: "u6@x.test", name: "u6", role: "member" });
    await db.insert(orgMembers).values({ orgId: "org1", userId: "u6", role: "admin", createdAt: Date.now() });

    await syncSsoOrgRole(db, "u5", "member");

    const [demoted] = await db.select().from(orgMembers).where(eq(orgMembers.userId, "u5"));
    expect(demoted?.role).toBe("member");

    const [other] = await db.select().from(orgMembers).where(eq(orgMembers.userId, "u6"));
    expect(other?.role).toBe("admin");
  });

  describe("logging (every applied change must be greppable)", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("promotion (member → operator) logs at warn level", async () => {
      await seedOrgAndMember("u7", "member");
      await syncSsoOrgRole(db, "u7", "operator");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("member → operator"));
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("demotion (admin → operator, with another admin present) logs at error level", async () => {
      await seedOrgAndMember("u8", "admin");
      await db.insert(users).values({ id: "u9", email: "u9@x.test", name: "u9", role: "member" });
      await db.insert(orgMembers).values({ orgId: "org1", userId: "u9", role: "admin", createdAt: Date.now() });

      await syncSsoOrgRole(db, "u8", "operator");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("admin → operator"));
    });

    it("idempotent same-role sync logs nothing", async () => {
      await seedOrgAndMember("u10", "operator");
      await syncSsoOrgRole(db, "u10", "operator");
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("guarded sole-admin demotion logs the refusal (existing behavior preserved)", async () => {
      await seedOrgAndMember("u11", "admin");
      await syncSsoOrgRole(db, "u11", "member");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("refused to demote"));
    });
  });
});
