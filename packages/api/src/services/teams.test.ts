import { describe, expect, it, beforeEach } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, teamMembers, teams, users, workflowDefinitions } from "../schema/index.js";
import {
  addMember,
  createTeam,
  deleteTeam,
  IdpManagedTeamError,
  LastAdminError,
  listTeamMembers,
  listTeamsForOrg,
  listTeamsForUser,
  NotOrgMemberError,
  NotTeamMemberError,
  removeMember,
  setRole,
  TeamNameConflictError,
  TeamOwnsWorkflowsError,
} from "./teams.js";

async function seedUser(db: AppDb, id: string, orgId: string) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId, userId: id, role: "member" });
}

describe("teams service", () => {
  let db: AppDb;
  const orgId = "org1";

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1", orgId);
    await seedUser(db, "u2", orgId);
    await seedUser(db, "u3", orgId);
  });

  it("createTeam auto-admits the creator as admin", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    expect(team.name).toBe("Platform");
    expect(team.orgId).toBe(orgId);

    const teams = await listTeamsForUser(db, "u1");
    expect(teams).toHaveLength(1);
    expect(teams[0].id).toBe(team.id);
  });

  it("rejects a duplicate team name within the same org", async () => {
    await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(createTeam(db, { orgId, name: "Platform", creatorUserId: "u2" })).rejects.toThrow(
      TeamNameConflictError,
    );
  });

  it("allows the same team name across different orgs", async () => {
    await db.insert(orgs).values({ id: "org2", name: "Org2", createdAt: Date.now() });
    await seedUser(db, "u9", "org2");
    await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(
      createTeam(db, { orgId: "org2", name: "Platform", creatorUserId: "u9" }),
    ).resolves.toBeDefined();
  });

  it("addMember adds a member with the given role", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });

    const teams = await listTeamsForUser(db, "u2");
    expect(teams.map((t) => t.id)).toContain(team.id);
  });

  it("setRole promotes/demotes a member", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    await setRole(db, { teamId: team.id, userId: "u2", role: "admin" });
    // now two admins; demoting u1 should succeed since u2 remains admin
    await expect(setRole(db, { teamId: team.id, userId: "u1", role: "member" })).resolves.toBeUndefined();
  });

  it("setRole rejects demoting the last admin", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    await expect(setRole(db, { teamId: team.id, userId: "u1", role: "member" })).rejects.toThrow(
      LastAdminError,
    );
  });

  it("removeMember rejects removing the last admin", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    await expect(removeMember(db, { teamId: team.id, userId: "u1" })).rejects.toThrow(LastAdminError);
  });

  it("removeMember allows removing a non-last admin", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "admin" });
    await expect(removeMember(db, { teamId: team.id, userId: "u1" })).resolves.toBeUndefined();

    const teams = await listTeamsForUser(db, "u1");
    expect(teams).toHaveLength(0);
  });

  it("removeMember rejects a user who isn't a member", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(removeMember(db, { teamId: team.id, userId: "u3" })).rejects.toThrow(NotTeamMemberError);
  });

  it("listTeamsForOrg returns every team in the org, not just the caller's own", async () => {
    const t1 = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    const t2 = await createTeam(db, { orgId, name: "Design", creatorUserId: "u2" });
    const orgTeams = await listTeamsForOrg(db, orgId);
    expect(orgTeams.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
  });

  it("listTeamMembers returns userId + role for a team", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    const members = await listTeamMembers(db, team.id);
    expect(members.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: "u1", role: "admin" },
      { userId: "u2", role: "member" },
    ]);
  });

  it("last-admin guard is atomic under a role-change + removal race on the only two admins", async () => {
    // Two admins; concurrently demote one and remove the other. Only one of
    // the two operations may succeed — the second must observe the
    // just-applied state and reject as a last-admin violation.
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "admin" });

    const results = await Promise.allSettled([
      setRole(db, { teamId: team.id, userId: "u1", role: "member" }),
      removeMember(db, { teamId: team.id, userId: "u2" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("listTeamsForUser returns only teams the user belongs to", async () => {
    const t1 = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await createTeam(db, { orgId, name: "Design", creatorUserId: "u2" });

    const teams = await listTeamsForUser(db, "u1");
    expect(teams.map((t) => t.id)).toEqual([t1.id]);
  });

  it("deleteTeam removes the team and its memberships when it owns no workflows", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await deleteTeam(db, { teamId: team.id });

    const teams = await listTeamsForUser(db, "u1");
    expect(teams).toHaveLength(0);
  });

  it("deleteTeam rejects deletion while the team owns a workflow", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await db.insert(workflowDefinitions).values({
      id: "wf_1",
      orgId,
      ownerType: "team",
      ownerId: team.id,
      name: "team workflow",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    await expect(deleteTeam(db, { teamId: team.id })).rejects.toThrow(TeamOwnsWorkflowsError);

    const teams = await listTeamsForUser(db, "u1");
    expect(teams).toHaveLength(1);
  });

  it("addMember rejects a userId with no org_members row in the team's org", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(addMember(db, { teamId: team.id, userId: "no-such-user", role: "member" })).rejects.toThrow(
      NotOrgMemberError,
    );
  });

  it("addMember rejects a userId that belongs to a different org", async () => {
    await db.insert(orgs).values({ id: "org2", name: "Org2", createdAt: Date.now() });
    await seedUser(db, "u9", "org2");

    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(addMember(db, { teamId: team.id, userId: "u9", role: "member" })).rejects.toThrow(
      NotOrgMemberError,
    );
  });

  describe("identity-provider-managed teams", () => {
    /**
     * Seeds a team the way the login-time sync does: `origin: "idp"`, the
     * full group path, and member rows written straight to the table.
     * `createTeam` always writes `local`, so it cannot produce one.
     */
    async function seedIdpTeam(): Promise<string> {
      const id = "team_idp";
      await db.insert(teams).values({
        id,
        orgId,
        name: "platform",
        origin: "idp",
        externalId: "/platform",
        createdAt: Date.now(),
      });
      await db.insert(teamMembers).values({ teamId: id, userId: "u1", role: "admin" });
      await db.insert(teamMembers).values({ teamId: id, userId: "u2", role: "member" });
      return id;
    }

    it("addMember refuses, and names the group in the message", async () => {
      const teamId = await seedIdpTeam();
      await expect(addMember(db, { teamId, userId: "u3", role: "member" })).rejects.toThrow(
        IdpManagedTeamError,
      );
      // The message must name the group to change, not just state a refusal.
      await expect(addMember(db, { teamId, userId: "u3", role: "member" })).rejects.toThrow(/\/platform/);
      expect(await listTeamMembers(db, teamId)).toHaveLength(2);
    });

    it("setRole refuses", async () => {
      const teamId = await seedIdpTeam();
      await expect(setRole(db, { teamId, userId: "u2", role: "admin" })).rejects.toThrow(
        IdpManagedTeamError,
      );
      const members = await listTeamMembers(db, teamId);
      expect(members.find((m) => m.userId === "u2")?.role).toBe("member");
    });

    it("removeMember refuses", async () => {
      const teamId = await seedIdpTeam();
      await expect(removeMember(db, { teamId, userId: "u2" })).rejects.toThrow(IdpManagedTeamError);
      expect(await listTeamMembers(db, teamId)).toHaveLength(2);
    });

    it("deleteTeam refuses and the team survives", async () => {
      const teamId = await seedIdpTeam();
      await expect(deleteTeam(db, { teamId })).rejects.toThrow(IdpManagedTeamError);
      expect(await listTeamsForUser(db, "u1")).toHaveLength(1);
    });

    it("the guard reads origin, not the name — a local team of the same name is untouched", async () => {
      // The refusal must key on provenance alone. A local team that happens
      // to share a mirrored team's name keeps every capability, or the sync
      // would silently freeze teams it does not own.
      await seedIdpTeam();
      // A second org, because `teams_org_name` blocks the same name twice in
      // one org.
      await db.insert(orgs).values({ id: "org2", name: "Org2", createdAt: Date.now() });
      await seedUser(db, "u8", "org2");
      await seedUser(db, "u9", "org2");
      const local = await createTeam(db, { orgId: "org2", name: "platform", creatorUserId: "u9" });

      await addMember(db, { teamId: local.id, userId: "u8", role: "member" });
      await setRole(db, { teamId: local.id, userId: "u8", role: "admin" });
      await removeMember(db, { teamId: local.id, userId: "u8" });
      expect(await listTeamMembers(db, local.id)).toHaveLength(1);

      await deleteTeam(db, { teamId: local.id });
      expect(await listTeamsForUser(db, "u9")).toHaveLength(0);
    });
  });

  it("createTeam still reports a conflict when a row was inserted outside the service's own check", async () => {
    // Inserts directly (bypassing createTeam's pre-check) to simulate a
    // conflicting row appearing between an out-of-band check and the
    // transaction — the `teams_org_name` unique index is the real backstop,
    // and a violation must map to TeamNameConflictError, not a raw 500.
    await db.insert(teams).values({ id: "team_preexisting", orgId, name: "Platform", createdAt: Date.now() });

    await expect(createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" })).rejects.toThrow(
      TeamNameConflictError,
    );
  });
});
