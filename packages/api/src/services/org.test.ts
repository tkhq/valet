import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { ValidationError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import {
  getOrgFeatures,
  getOrgModelPreferences,
  isOrgAdmin,
  listOrgMembers,
  MEMBER_NOT_FOUND_ERROR,
  renameOrg,
  setOrgFeatures,
  setOrgModelPreferences,
  setOrgMemberRole,
} from "./org.js";

async function seedUser(db: AppDb, id: string, orgId: string, role: "admin" | "member", createdAt: number) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member", createdAt: new Date(createdAt) });
  await db.insert(orgMembers).values({ orgId, userId: id, role, createdAt });
}

describe("org service", () => {
  let db: AppDb;
  const orgId = "org1";

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
    await seedUser(db, "admin1", orgId, "admin", 1_000);
    await seedUser(db, "member1", orgId, "member", 2_000);
  });

  describe("isOrgAdmin", () => {
    it("is true for a seeded admin", async () => {
      expect(await isOrgAdmin(db, orgId, "admin1")).toBe(true);
    });

    it("is false for a member row", async () => {
      expect(await isOrgAdmin(db, orgId, "member1")).toBe(false);
    });

    it("is false for a user with no org_members row at all", async () => {
      expect(await isOrgAdmin(db, orgId, "no-such-user")).toBe(false);
    });
  });

  describe("getOrgFeatures / setOrgFeatures", () => {
    it("defaults every feature to false", async () => {
      // An absent key reads as false, which is what makes a gate off for an
      // operator who declares nothing.
      expect(await getOrgFeatures(db, orgId)).toEqual({ organizations: false, ssoTeamSync: false });
    });

    it("reflects setOrgFeatures", async () => {
      await setOrgFeatures(db, orgId, { organizations: true });
      expect(await getOrgFeatures(db, orgId)).toEqual({ organizations: true, ssoTeamSync: false });
    });

    it("changes only the keys it is given", async () => {
      await setOrgFeatures(db, orgId, { ssoTeamSync: true });
      await setOrgFeatures(db, orgId, { organizations: true });
      expect(await getOrgFeatures(db, orgId)).toEqual({ organizations: true, ssoTeamSync: true });
    });

    it("keeps a feature key this build does not name", async () => {
      // `valet.yaml` may declare a feature key the typed reader does not
      // know. One write from the settings page must not delete it, so the
      // merge runs against the raw jsonb rather than the projected shape.
      await db.update(orgs).set({ features: { fromTheFile: true } }).where(eq(orgs.id, orgId));

      await setOrgFeatures(db, orgId, { organizations: true });

      const rows = await db.select({ features: orgs.features }).from(orgs).where(eq(orgs.id, orgId));
      expect(rows[0]?.features).toEqual({ fromTheFile: true, organizations: true });
    });
  });

  describe("renameOrg", () => {
    it("updates the org name", async () => {
      await renameOrg(db, orgId, "New Name");
      const rows = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
      expect(rows[0]?.name).toBe("New Name");
    });
  });

  describe("setOrgMemberRole", () => {
    it("rejects demoting the sole admin with the exact error string", async () => {
      const result = await setOrgMemberRole(db, orgId, "admin1", "member");
      expect(result).toEqual({
        ok: false,
        reason: "last_admin",
        error: "an organization needs at least one admin",
      });
    });

    it("rejects a userId with no membership row in the org", async () => {
      const result = await setOrgMemberRole(db, orgId, "no-such-user", "admin");
      expect(result).toEqual({ ok: false, reason: "not_found", error: MEMBER_NOT_FOUND_ERROR });
    });

    it("allows demoting once a second admin exists", async () => {
      await seedUser(db, "admin2", orgId, "admin", 3_000);
      const result = await setOrgMemberRole(db, orgId, "admin1", "member");
      expect(result).toEqual({ ok: true });
      expect(await isOrgAdmin(db, orgId, "admin1")).toBe(false);
    });

    it("promoting a member to admin always succeeds", async () => {
      const result = await setOrgMemberRole(db, orgId, "member1", "admin");
      expect(result).toEqual({ ok: true });
      expect(await isOrgAdmin(db, orgId, "member1")).toBe(true);
    });
  });

  describe("getOrgModelPreferences / setOrgModelPreferences", () => {
    it("defaults to an empty array", async () => {
      expect(await getOrgModelPreferences(db, orgId)).toEqual([]);
    });

    it("round-trips a set list", async () => {
      await setOrgModelPreferences(db, orgId, ["anthropic:claude-opus-4", "openai:gpt-5"]);
      expect(await getOrgModelPreferences(db, orgId)).toEqual(["anthropic:claude-opus-4", "openai:gpt-5"]);
    });

    it("rejects a non-array value", async () => {
      // Parsed from JSON rather than cast, to exercise the runtime guard the
      // way a malformed request body would (no `any`/`as` needed — JSON.parse
      // returns `any` implicitly, which is how untrusted input arrives).
      const bogus = JSON.parse('"not-an-array"');
      await expect(setOrgModelPreferences(db, orgId, bogus)).rejects.toThrow(ValidationError);
    });
  });

  describe("listOrgMembers", () => {
    it("returns the joined shape sorted with both members", async () => {
      const rows = await listOrgMembers(db, orgId);
      expect(rows).toHaveLength(2);
      const admin = rows.find((r) => r.userId === "admin1");
      expect(admin).toEqual({
        userId: "admin1",
        email: "admin1@x.test",
        name: "admin1",
        avatarUrl: null,
        role: "admin",
        joinedAt: 1_000,
      });
    });
  });
});
