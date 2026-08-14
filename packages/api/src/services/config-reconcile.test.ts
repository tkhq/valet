/**
 * Boot-time instance config reconciler — org pass tests.
 *
 * Harness: shared PGlite AppDb + migrations, mirroring skill-sources.test.ts.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { isNull, eq, and } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { invites, orgMembers, orgs, users } from "../schema/index.js";
import { ensureOrg } from "./org.js";
import {
  reconcileInstanceConfig,
  configInviteId,
  configSkillSourceId,
  configTeamId,
  configProviderId,
  type ReconcileDeps,
} from "./config-reconcile.js";
import type { InstanceConfig } from "../config/instance-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(db: AppDb, id: string, email: string) {
  await db.insert(users).values({ id, email, name: id, role: "member" });
}

function deps(db: AppDb): ReconcileDeps {
  return { db };
}

// ---------------------------------------------------------------------------
// Id helper tests
// ---------------------------------------------------------------------------

describe("id helpers", () => {
  it("configInviteId produces the expected prefix and 12-char hex suffix", () => {
    const id = configInviteId("alice@example.com");
    expect(id).toMatch(/^invite_cfg_[0-9a-f]{12}$/);
  });

  it("configInviteId is deterministic", () => {
    expect(configInviteId("bob@example.com")).toBe(configInviteId("bob@example.com"));
  });

  it("configSkillSourceId produces the expected prefix", () => {
    const id = configSkillSourceId("owner/repo", "main", "skills");
    expect(id).toMatch(/^skillsrc_cfg_[0-9a-f]{12}$/);
    expect(id).toBe(configSkillSourceId("owner/repo", "main", "skills"));
  });

  it("configTeamId produces the expected prefix", () => {
    const id = configTeamId("Engineering");
    expect(id).toMatch(/^team_cfg_[0-9a-f]{12}$/);
    expect(id).toBe(configTeamId("Engineering"));
  });

  it("configProviderId produces the expected prefix", () => {
    const id = configProviderId("my-provider");
    expect(id).toMatch(/^prov_cfg_[0-9a-f]{12}$/);
    expect(id).toBe(configProviderId("my-provider"));
  });
});

// ---------------------------------------------------------------------------
// Org pass tests
// ---------------------------------------------------------------------------

describe("reconcileInstanceConfig — org pass", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("empty org section (no org key) is a no-op — ensureOrg creates the org", async () => {
    const cfg: InstanceConfig = { version: 1 };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(orgs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("My organization");
  });

  it("org.name renames the org", async () => {
    const cfg: InstanceConfig = { version: 1, org: { name: "Acme Corp" } };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select({ name: orgs.name }).from(orgs);
    expect(rows[0]!.name).toBe("Acme Corp");
  });

  it("org.features merges keys, preserving undeclared existing flags", async () => {
    // Seed an org with an existing feature flag.
    const org = await ensureOrg(db);
    await db.update(orgs).set({ features: { organizations: true, legacy: true } }).where(eq(orgs.id, org.id));

    // Config only declares `organizations: false` — legacy must survive.
    const cfg: InstanceConfig = { version: 1, org: { features: { organizations: false } } };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select({ features: orgs.features }).from(orgs);
    const features = rows[0]!.features as Record<string, boolean>;
    expect(features["organizations"]).toBe(false);
    expect(features["legacy"]).toBe(true);
  });

  it("org.modelPreferences overwrites the array", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      org: { modelPreferences: ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4"] },
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select({ mp: orgs.modelPreferences }).from(orgs);
    expect(rows[0]!.mp).toEqual(["anthropic/claude-opus-4", "anthropic/claude-sonnet-4"]);
  });

  it("org.bareSkillCommands sets the column", async () => {
    const cfg: InstanceConfig = { version: 1, org: { bareSkillCommands: true } };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select({ bsc: orgs.bareSkillCommands }).from(orgs);
    expect(rows[0]!.bsc).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Members — existing user path
  // ---------------------------------------------------------------------------

  it("declared member with existing user inserts org_members row", async () => {
    await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "alice@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(orgMembers).where(eq(orgMembers.userId, "u1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("member");
  });

  it("role change applies when user already has an org_members row", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    // Seed as admin first.
    await db.insert(users).values({ id: "u2", email: "bob@example.com", name: "bob", role: "member" });
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u2", role: "admin", createdAt: Date.now() });
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "admin", createdAt: Date.now() });

    // Demote u1 from admin → member (u2 remains admin so not last-admin).
    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "alice@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(orgMembers).where(eq(orgMembers.userId, "u1"));
    expect(rows[0]!.role).toBe("member");
  });

  it("demoting the sole admin throws LAST_ADMIN_ERROR", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    // Only admin.
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "admin", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "alice@example.com", role: "member" }] },
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).rejects.toThrow(
      "an organization needs at least one admin",
    );
  });

  // ---------------------------------------------------------------------------
  // Members — unknown email / invite path
  // ---------------------------------------------------------------------------

  it("unknown email creates invite_cfg_* invite row with 10-year expiry", async () => {
    await ensureOrg(db);

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "unknown@example.com", role: "admin" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const expectedId = configInviteId("unknown@example.com");
    const rows = await db.select().from(invites).where(eq(invites.id, expectedId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.email).toBe("unknown@example.com");
    expect(row.role).toBe("admin");
    expect(row.createdBy).toBe("config");
    expect(row.acceptedBy).toBeNull();

    // 10-year expiry: within ±60 seconds of 10*365*24*3600*1000ms from now.
    const tenYearsMs = 10 * 365 * 24 * 3600_000;
    const expiresAtMs = row.expiresAt.getTime();
    expect(expiresAtMs).toBeGreaterThan(Date.now() + tenYearsMs - 60_000);
    expect(expiresAtMs).toBeLessThan(Date.now() + tenYearsMs + 60_000);
  });

  it("second reconcile run on same unknown email is a no-op (same row id, role unchanged)", async () => {
    await ensureOrg(db);

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "unknown@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const expectedId = configInviteId("unknown@example.com");
    const rows = await db.select().from(invites).where(eq(invites.id, expectedId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("member");
  });

  it("second run updates role on unaccepted config invite when role changes", async () => {
    await ensureOrg(db);

    const cfg1: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "unknown@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    const cfg2: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "unknown@example.com", role: "admin" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg2);

    const expectedId = configInviteId("unknown@example.com");
    const rows = await db.select().from(invites).where(eq(invites.id, expectedId));
    expect(rows[0]!.role).toBe("admin");
  });

  it("removing an email deletes the unaccepted config invite", async () => {
    await ensureOrg(db);

    const cfg1: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "unknown@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    // Remove the member from config.
    const cfg2: InstanceConfig = { version: 1, org: { members: [] } };
    await reconcileInstanceConfig(deps(db), cfg2);

    const expectedId = configInviteId("unknown@example.com");
    const rows = await db.select().from(invites).where(eq(invites.id, expectedId));
    expect(rows).toHaveLength(0);
  });

  it("does not delete an accepted config invite when the email is removed", async () => {
    await ensureOrg(db);

    const cfg1: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "accepted@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    // Mark the config invite as accepted.
    const expectedId = configInviteId("accepted@example.com");
    await db
      .update(invites)
      .set({ acceptedBy: "some-user-id", acceptedAt: new Date() })
      .where(eq(invites.id, expectedId));

    // Remove from config.
    const cfg2: InstanceConfig = { version: 1, org: { members: [] } };
    await reconcileInstanceConfig(deps(db), cfg2);

    const rows = await db.select().from(invites).where(eq(invites.id, expectedId));
    expect(rows).toHaveLength(1);
  });

  it("does not delete a UI invite (invite_<uuid> prefix) when managing config invites", async () => {
    await ensureOrg(db);

    // Insert a UI invite manually.
    const uiInviteId = `invite_deadbeef-1234-5678-abcd-000000000001`;
    await db.insert(invites).values({
      id: uiInviteId,
      codeHash: "ui_code_hash_unique_value_xyz",
      email: "ui-user@example.com",
      role: "member",
      createdBy: "some-admin",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    });

    // Config declares no members — should only sweep invite_cfg_* rows.
    const cfg: InstanceConfig = { version: 1, org: { members: [] } };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(invites).where(eq(invites.id, uiInviteId));
    expect(rows).toHaveLength(1);
  });

  it("full reconcile is idempotent for existing user members", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "alice@example.com", role: "member" }] },
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, "u1")));
    expect(rows).toHaveLength(1);
  });
});
