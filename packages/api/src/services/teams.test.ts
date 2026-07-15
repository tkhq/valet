import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { orgMembers, orgs, teams, users } from "../schema/index.js";
import {
  addMember,
  createTeam,
  deleteTeam,
  LastAdminError,
  listTeamMembers,
  listTeamsForOrg,
  listTeamsForUser,
  NotOrgMemberError,
  NotTeamMemberError,
  removeMember,
  setRole,
  TeamNameConflictError,
} from "./teams.js";

function seedUser(db: AppDb, id: string, orgId: string) {
  db.insert(users)
    .values({ id, email: `${id}@x.test`, name: id, role: "member", createdAt: Date.now() })
    .run();
  db.insert(orgMembers).values({ orgId, userId: id, role: "member" }).run();
}

describe("teams service", () => {
  let sqlite: Database.Database;
  let db: AppDb;
  const orgId = "org1";

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    applyAppMigrations(sqlite);
    db = buildAppDb(sqlite);
    db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() }).run();
    seedUser(db, "u1", orgId);
    seedUser(db, "u2", orgId);
    seedUser(db, "u3", orgId);
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
    db.insert(orgs).values({ id: "org2", name: "Org2", createdAt: Date.now() }).run();
    seedUser(db, "u9", "org2");
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

  it("deleteTeam removes the team and its memberships (no-op workflow guard)", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await deleteTeam(db, { teamId: team.id });

    const teams = await listTeamsForUser(db, "u1");
    expect(teams).toHaveLength(0);
  });

  it("addMember rejects a userId with no org_members row in the team's org", async () => {
    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(addMember(db, { teamId: team.id, userId: "no-such-user", role: "member" })).rejects.toThrow(
      NotOrgMemberError,
    );
  });

  it("addMember rejects a userId that belongs to a different org", async () => {
    db.insert(orgs).values({ id: "org2", name: "Org2", createdAt: Date.now() }).run();
    seedUser(db, "u9", "org2");

    const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
    await expect(addMember(db, { teamId: team.id, userId: "u9", role: "member" })).rejects.toThrow(
      NotOrgMemberError,
    );
  });

  it("createTeam still reports a conflict when a row was inserted outside the service's own check", async () => {
    // Inserts directly (bypassing createTeam's pre-check) to simulate a
    // conflicting row appearing between an out-of-band check and the
    // transaction — the `teams_org_name` unique index is the real backstop,
    // and a violation must map to TeamNameConflictError, not a raw 500.
    db.insert(teams).values({ id: "team_preexisting", orgId, name: "Platform", createdAt: Date.now() }).run();

    await expect(createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" })).rejects.toThrow(
      TeamNameConflictError,
    );
  });
});
