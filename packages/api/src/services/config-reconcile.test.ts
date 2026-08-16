/**
 * Boot-time instance config reconciler — org pass tests.
 *
 * Harness: shared PGlite AppDb + migrations, mirroring skill-sources.test.ts.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { isNull, eq, and, like } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { actionPolicies, invites, llmProviders, orgMembers, orgs, skillSources, skills, teams, teamMembers, users } from "../schema/index.js";
import { ensureOrg } from "./org.js";
import {
  reconcileInstanceConfig,
  configInviteId,
  configSkillSourceId,
  configTeamId,
  configProviderId,
  configPolicyId,
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
      "org.members would leave the organization with no admin",
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

// ---------------------------------------------------------------------------
// Teams pass tests
// ---------------------------------------------------------------------------

describe("reconcileInstanceConfig — teams pass", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("creates a team with the deterministic id when absent", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const expectedId = configTeamId("Engineering");
    const rows = await db.select().from(teams).where(eq(teams.id, expectedId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Engineering");
  });

  it("adopts an existing UI team without changing its id", async () => {
    const org = await ensureOrg(db);
    // Insert a UI team with a different id but the same name.
    const uiTeamId = "team_ui_deadbeef";
    await db.insert(teams).values({ id: uiTeamId, orgId: org.id, name: "Engineering", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    // The UI team id must be unchanged.
    const allRows = await db.select().from(teams).where(eq(teams.name, "Engineering"));
    expect(allRows).toHaveLength(1);
    expect(allRows[0]!.id).toBe(uiTeamId);
  });

  it("adds a declared member to an existing team", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "member", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const teamId = configTeamId("Engineering");
    const memberRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]!.userId).toBe("u1");
  });

  it("skips member whose email has no user (run succeeds)", async () => {
    await ensureOrg(db);

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "ghost@example.com", role: "member" }] }],
    };
    // Must not throw.
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    const teamId = configTeamId("Engineering");
    const memberRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(memberRows).toHaveLength(0);
  });

  it("skips member who is not an org member", async () => {
    await ensureOrg(db);
    // User exists but has no org_members row.
    await seedUser(db, "u1", "alice@example.com");

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    const teamId = configTeamId("Engineering");
    const memberRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(memberRows).toHaveLength(0);
  });

  it("updates an existing team_members role", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "admin", createdAt: Date.now() });

    // First run: add as member.
    const cfg1: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    // Second run: promote to admin.
    const cfg2: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "admin" }] }],
    };
    await reconcileInstanceConfig(deps(db), cfg2);

    const teamId = configTeamId("Engineering");
    const memberRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(memberRows[0]!.role).toBe("admin");
  });

  it("second run is idempotent — no duplicate team or member rows", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "member", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const teamRows = await db.select().from(teams).where(eq(teams.name, "Engineering"));
    expect(teamRows).toHaveLength(1);

    const teamId = configTeamId("Engineering");
    const memberRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(memberRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// LLM providers pass tests
// ---------------------------------------------------------------------------

describe("reconcileInstanceConfig — llmProviders pass", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("creates a known-kind provider row on first run", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "anthropic" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(llmProviders).where(eq(llmProviders.kind, "anthropic"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(true);
    expect(rows[0]!.name).toBe("anthropic");
  });

  it("updates an existing known-kind provider on second run with changed fields", async () => {
    const cfg1: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "openai", name: "OpenAI", enabled: true }],
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    const cfg2: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "openai", name: "OpenAI Disabled", enabled: false }],
    };
    await reconcileInstanceConfig(deps(db), cfg2);

    const rows = await db.select().from(llmProviders).where(eq(llmProviders.kind, "openai"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(false);
    expect(rows[0]!.name).toBe("OpenAI Disabled");
  });

  it("known-kind provider second run is a no-op (same row)", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "google" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(llmProviders).where(eq(llmProviders.kind, "google"));
    expect(rows).toHaveLength(1);
  });

  it("creates openai_compatible provider with deterministic id keyed by name", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      llmProviders: [
        {
          kind: "openai_compatible",
          name: "my-llm",
          baseUrl: "https://api.example.com/v1",
          models: [{ id: "model-1", name: "Model One" }],
        },
      ],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const expectedId = configProviderId("my-llm");
    const rows = await db.select().from(llmProviders).where(eq(llmProviders.id, expectedId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("my-llm");
    expect(rows[0]!.baseUrl).toBe("https://api.example.com/v1");
  });

  it("second run on openai_compatible provider with same name is a no-op", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "openai_compatible", name: "my-llm", baseUrl: "https://api.example.com/v1" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const expectedId = configProviderId("my-llm");
    const rows = await db.select().from(llmProviders).where(eq(llmProviders.id, expectedId));
    expect(rows).toHaveLength(1);
  });

  it("never deletes a provider row even when removed from config", async () => {
    const cfg1: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "anthropic" }],
    };
    await reconcileInstanceConfig(deps(db), cfg1);

    const cfg2: InstanceConfig = { version: 1 };
    await reconcileInstanceConfig(deps(db), cfg2);

    const rows = await db.select().from(llmProviders).where(eq(llmProviders.kind, "anthropic"));
    expect(rows).toHaveLength(1);
  });

  it("creates a known-kind provider with enabled: false on first run (disabled immediately)", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      llmProviders: [{ kind: "openrouter", enabled: false }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(llmProviders).where(eq(llmProviders.kind, "openrouter"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Skill sources pass tests
// ---------------------------------------------------------------------------

describe("reconcileInstanceConfig — skillSources pass", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("inserts a declared source with org ownership and pending status", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [{ repo: "owner/repo", ref: "main", subpath: "skills" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const expectedId = configSkillSourceId("owner/repo", "main", "skills");
    const rows = await db.select().from(skillSources).where(eq(skillSources.id, expectedId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.ownerType).toBe("org");
    expect(row.status).toBe("pending");
    expect(row.enabled).toBe(true);
  });

  it("second run on same source is a no-op", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [{ repo: "owner/repo" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(skillSources);
    expect(rows).toHaveLength(1);
  });

  it("skips and warns when an unmanaged row already tracks the same repo+subpath", async () => {
    const org = await ensureOrg(db);
    // Insert an unmanaged (non-cfg_) row for the same repo.
    await db.insert(skillSources).values({
      id: "skillsrc_unmanaged_abc",
      orgId: org.id,
      ownerType: "org",
      ownerId: org.id,
      repoFullName: "owner/repo",
      ref: "",
      subpath: "",
      enabled: true,
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastSha: null,
      lastManifestHash: null,
      lastSyncedAt: null,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [{ repo: "owner/repo" }],
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    // Should not have inserted a managed row.
    const managedRows = await db
      .select()
      .from(skillSources)
      .where(like(skillSources.id, "skillsrc_cfg_%"));
    expect(managedRows).toHaveLength(0);
  });

  it("removes a managed source and its repo-origin skills when removed from config", async () => {
    const org = await ensureOrg(db);
    const srcId = configSkillSourceId("owner/repo", "", "");

    // Insert the managed source directly.
    await db.insert(skillSources).values({
      id: srcId,
      orgId: org.id,
      ownerType: "org",
      ownerId: org.id,
      repoFullName: "owner/repo",
      ref: "",
      subpath: "",
      enabled: true,
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastSha: null,
      lastManifestHash: null,
      lastSyncedAt: null,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Insert a mirrored repo skill.
    await db.insert(skills).values({
      id: "skill_test_1",
      orgId: org.id,
      ownerType: "org",
      ownerId: org.id,
      origin: "repo",
      sourceId: srcId,
      name: "test-skill",
      description: "A test skill",
      content: "content",
      frontmatter: {},
      contentSha: "abc123",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Config now declares no skill sources.
    const cfg: InstanceConfig = { version: 1, skillSources: [] };
    await reconcileInstanceConfig(deps(db), cfg);

    // Source and its skills should be gone.
    const srcRows = await db.select().from(skillSources).where(eq(skillSources.id, srcId));
    expect(srcRows).toHaveLength(0);

    const skillRows = await db.select().from(skills).where(eq(skills.sourceId, srcId));
    expect(skillRows).toHaveLength(0);
  });

  it("does not remove an unmanaged source even when skillSources is empty", async () => {
    const org = await ensureOrg(db);
    // Insert an unmanaged source.
    await db.insert(skillSources).values({
      id: "skillsrc_ui_abc123",
      orgId: org.id,
      ownerType: "org",
      ownerId: org.id,
      repoFullName: "owner/repo2",
      ref: "",
      subpath: "",
      enabled: true,
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastSha: null,
      lastManifestHash: null,
      lastSyncedAt: null,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const cfg: InstanceConfig = { version: 1, skillSources: [] };
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db.select().from(skillSources).where(eq(skillSources.id, "skillsrc_ui_abc123"));
    expect(rows).toHaveLength(1);
  });

  it("full second run with all three passes is a no-op", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "member", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
      llmProviders: [{ kind: "anthropic" }],
      skillSources: [{ repo: "owner/repo", ref: "main", subpath: "" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const teamRows = await db.select().from(teams);
    expect(teamRows).toHaveLength(1);

    const providerRows = await db.select().from(llmProviders);
    expect(providerRows).toHaveLength(1);

    const sourceRows = await db.select().from(skillSources);
    expect(sourceRows).toHaveLength(1);
  });

  it("URL-variant duplicate (raw strings differ, same repo+subpath) throws a clean error with no partial insert", async () => {
    await ensureOrg(db);
    // `obra/superpowers` and its full https .git URL normalize to the same
    // (repoFullName, subpath) but differ as raw strings, so the validator's
    // raw-string dedupe misses them. The reconciler must reject before insert.
    const cfg: InstanceConfig = {
      version: 1,
      skillSources: [
        { repo: "obra/superpowers", subpath: "skills" },
        { repo: "https://github.com/obra/superpowers.git", subpath: "skills" },
      ],
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).rejects.toThrow(
      "a source can track only one ref",
    );

    // No partial write — neither entry landed a row.
    const rows = await db.select().from(skillSources).where(like(skillSources.id, "skillsrc_cfg_%"));
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conflict guards — partial prior run / concurrent boot
// ---------------------------------------------------------------------------

describe("reconcileInstanceConfig — conflict guards", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  it("succeeds when an org_members row for a declared member already exists (partial prior run)", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    // Simulate a prior partial reconcile: the org_members row is already
    // present at the same declared role.
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "admin", createdAt: Date.now() });

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "alice@example.com", role: "admin" }] },
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    const rows = await db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, "u1")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("admin");
  });

  it("succeeds when a team_members row for a declared member already exists (partial prior run)", async () => {
    const org = await ensureOrg(db);
    await seedUser(db, "u1", "alice@example.com");
    await db.insert(orgMembers).values({ orgId: org.id, userId: "u1", role: "member", createdAt: Date.now() });

    // Pre-create the team and the team_members row at the declared role.
    const teamId = configTeamId("Engineering");
    await db.insert(teams).values({ id: teamId, orgId: org.id, name: "Engineering", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId, userId: "u1", role: "member" });

    const cfg: InstanceConfig = {
      version: 1,
      teams: [{ name: "Engineering", members: [{ email: "alice@example.com", role: "member" }] }],
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    const rows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId));
    expect(rows).toHaveLength(1);
  });

  it("succeeds when a config invite row already exists at the declared id (partial prior run)", async () => {
    await ensureOrg(db);
    const inviteId = configInviteId("newcomer@example.com");
    // Pre-insert a config invite row with a stale role.
    await db.insert(invites).values({
      id: inviteId,
      codeHash: "deadbeef",
      email: "newcomer@example.com",
      role: "member",
      createdBy: "config",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const cfg: InstanceConfig = {
      version: 1,
      org: { members: [{ email: "newcomer@example.com", role: "admin" }] },
    };
    await expect(reconcileInstanceConfig(deps(db), cfg)).resolves.toBeUndefined();

    const rows = await db.select().from(invites).where(eq(invites.id, inviteId));
    expect(rows).toHaveLength(1);
    // The onConflictDoUpdate path (or the select/update path) reconciles the role.
    expect(rows[0]!.role).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// Tool policies pass tests
// ---------------------------------------------------------------------------

describe("configPolicyId", () => {
  it("produces the pol:config: prefix and 12-char hex suffix, keyed by target", () => {
    const id = configPolicyId("service", "github");
    expect(id).toMatch(/^pol:config:[0-9a-f]{12}$/);
    expect(id).toBe(configPolicyId("service", "github"));
  });

  it("distinguishes dimensions for the same value", () => {
    expect(configPolicyId("service", "github")).not.toBe(configPolicyId("action", "github"));
  });
});

describe("reconcileInstanceConfig — toolPolicies pass", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
  });

  async function orgId(): Promise<string> {
    return (await ensureOrg(db)).id;
  }

  it("creates a service-targeted org row with origin/managed_by set", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const id = configPolicyId("service", "github");
    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.orgId).toBe(await orgId());
    expect(row.principalType).toBe("org");
    expect(row.principalId).toBe(await orgId());
    expect(row.service).toBe("github");
    expect(row.actionId).toBeNull();
    expect(row.riskLevel).toBeNull();
    expect(row.mode).toBe("deny");
    expect(row.appliesIn).toBe("any");
    expect(row.origin).toBe("admin");
    expect(row.managedBy).toBe("config");
    expect(row.paramMatchers).toEqual([]);
    expect(row.expiresAt).toBeNull();
    expect(row.revokedAt).toBeNull();
  });

  it("creates an action-targeted row on the action_id column", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      toolPolicies: [{ action: "github.merge_pull_request", mode: "require_approval", appliesIn: "session" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const id = configPolicyId("action", "github.merge_pull_request");
    const row = (await db.select().from(actionPolicies).where(eq(actionPolicies.id, id)))[0]!;
    expect(row.actionId).toBe("github.merge_pull_request");
    expect(row.service).toBeNull();
    expect(row.riskLevel).toBeNull();
    expect(row.appliesIn).toBe("session");
  });

  it("creates a riskLevel-targeted row on the risk_level column", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      toolPolicies: [{ riskLevel: "critical", mode: "deny" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);

    const id = configPolicyId("risk", "critical");
    const row = (await db.select().from(actionPolicies).where(eq(actionPolicies.id, id)))[0]!;
    expect(row.riskLevel).toBe("critical");
    expect(row.service).toBeNull();
    expect(row.actionId).toBeNull();
  });

  it("is a no-op on a second run — stable ids, no duplicate rows", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), cfg);

    const rows = await db
      .select()
      .from(actionPolicies)
      .where(like(actionPolicies.id, "pol:config:%"));
    expect(rows).toHaveLength(1);
  });

  it("updates the mode in place when a rule's mode changes", async () => {
    await reconcileInstanceConfig(deps(db), {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    });
    await reconcileInstanceConfig(deps(db), {
      version: 1,
      toolPolicies: [{ service: "github", mode: "require_approval" }],
    });

    const id = configPolicyId("service", "github");
    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mode).toBe("require_approval");
    expect(rows[0]!.revokedAt).toBeNull();
  });

  it("soft-revokes a removed rule (keeps the row, stamps revoked_at)", async () => {
    await reconcileInstanceConfig(deps(db), {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    });
    await reconcileInstanceConfig(deps(db), { version: 1, toolPolicies: [] });

    const id = configPolicyId("service", "github");
    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).not.toBeNull();
  });

  it("resurrects a previously removed rule by clearing revoked_at", async () => {
    const cfg: InstanceConfig = {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    };
    await reconcileInstanceConfig(deps(db), cfg);
    await reconcileInstanceConfig(deps(db), { version: 1, toolPolicies: [] });
    await reconcileInstanceConfig(deps(db), cfg);

    const id = configPolicyId("service", "github");
    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
    expect(rows[0]!.mode).toBe("deny");
  });

  it("never touches a UI-created policy row (random id) during the sweep", async () => {
    const org = await orgId();
    const now = Date.now();
    const uiId = randomUUID();
    await db.insert(actionPolicies).values({
      id: uiId,
      orgId: org,
      principalType: "org",
      principalId: org,
      service: "linear",
      actionId: null,
      riskLevel: null,
      mode: "allow",
      paramMatchers: [],
      appliesIn: "any",
      origin: "settings",
      managedBy: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // A config run declaring a different target must not revoke the UI row.
    await reconcileInstanceConfig(deps(db), {
      version: 1,
      toolPolicies: [{ service: "github", mode: "deny" }],
    });

    const uiRows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, uiId));
    expect(uiRows).toHaveLength(1);
    expect(uiRows[0]!.revokedAt).toBeNull();
  });

  it("leaves action_policies untouched when toolPolicies is absent (unmanaged)", async () => {
    const org = await orgId();
    const now = Date.now();
    const uiId = randomUUID();
    await db.insert(actionPolicies).values({
      id: uiId,
      orgId: org,
      principalType: "org",
      principalId: org,
      service: "github",
      actionId: null,
      riskLevel: null,
      mode: "deny",
      paramMatchers: [],
      appliesIn: "any",
      origin: "settings",
      managedBy: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await reconcileInstanceConfig(deps(db), { version: 1 });

    const rows = await db.select().from(actionPolicies).where(eq(actionPolicies.id, uiId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
  });
});
