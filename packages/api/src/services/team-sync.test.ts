/**
 * Tests for the identity-provider team sync. Every case runs against a real
 * Postgres schema through `freshTestPgDb`, because the rules this file pins
 * are rules about rows: which ones the sync may write, and which ones it
 * must never touch.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, teamMembers, teams, users, type TeamRow } from "../schema/index.js";
import { addMember, createTeam, deleteTeam } from "./teams.js";
import {
  desiredTeamsFromPaths,
  readTeamClaim,
  reconcileIdpTeams,
  reportTeamSyncState,
} from "./team-sync.js";

const ORG = "org1";
const ADMIN_GROUP = "admins";
/**
 * The allowlist these tests run with. Every reconcile needs one now: there is
 * no "mirror everything" value, so a test that named no group would mirror
 * nothing and pass for the wrong reason.
 */
const MIRRORED = ["/platform", "/research"];

async function seedUser(db: AppDb, id: string) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId: ORG, userId: id, role: "member" });
}

interface Membership {
  team: string;
  origin: TeamRow["origin"];
  externalId: string | null;
  role: "admin" | "member";
}

/** Every team the user belongs to, whatever its origin, sorted by name. */
async function membershipsOf(db: AppDb, userId: string): Promise<Membership[]> {
  const rows = await db
    .select({
      team: teams.name,
      origin: teams.origin,
      externalId: teams.externalId,
      role: teamMembers.role,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(teams.name);
  return rows;
}

async function teamNamed(db: AppDb, name: string) {
  const rows = await db
    .select()
    .from(teams)
    .where(and(eq(teams.orgId, ORG), eq(teams.name, name)))
    .limit(1);
  return rows[0];
}

/** Runs one sign-in's worth of sync for `userId` with the given group paths. */
async function signInWith(db: AppDb, userId: string, paths: string[], mirroredGroups = MIRRORED) {
  return reconcileIdpTeams(db, {
    orgId: ORG,
    userId,
    claim: { present: true, paths },
    adminGroupName: ADMIN_GROUP,
    mirroredGroups,
  });
}

describe("readTeamClaim", () => {
  it("reads an array of paths as present", () => {
    expect(readTeamClaim({ groups: ["/platform", "/research"] }, "groups", "groups_asserted")).toEqual({
      present: true,
      paths: ["/platform", "/research"],
    });
  });

  it("reads an empty array as present and authoritative", () => {
    expect(readTeamClaim({ groups: [] }, "groups", "groups_asserted")).toEqual({
      present: true,
      paths: [],
    });
  });

  it("drops a blank entry, which names no group", () => {
    const claim = readTeamClaim({ groups: ["/platform", "", "  "] }, "groups", "groups_asserted");
    expect(claim).toEqual({ present: true, paths: ["/platform"] });
  });

  it("reports NO information when any entry is not a string", () => {
    // A shortened list still looks authoritative, so the reconcile would
    // remove every team the unreadable entries named. One bad entry
    // therefore disqualifies the whole claim.
    expect(readTeamClaim({ groups: [{ name: "/platform" }] }, "groups", "groups_asserted")).toEqual({
      present: false,
    });
    expect(readTeamClaim({ groups: ["/platform", 7] }, "groups", "groups_asserted")).toEqual({
      present: false,
    });
    expect(readTeamClaim({ groups: ["/platform", null] }, "groups", "groups_asserted")).toEqual({
      present: false,
    });
  });

  it("reports NO information when the list names no group at all", () => {
    // Blank entries drop out one at a time, so a list of nothing but blanks
    // filters down to `[]` — which reads as "in no groups" and removes every
    // mirrored team. A list that arrived with entries never means that.
    expect(readTeamClaim({ groups: ["", "  "] }, "groups", "groups_asserted")).toEqual({
      present: false,
    });
    expect(
      readTeamClaim({ groups: [""], groups_asserted: "true" }, "groups", "groups_asserted"),
    ).toEqual({ present: false });
  });

  it("reports NO information for an unreadable list even when the marker is present", () => {
    expect(
      readTeamClaim({ groups: [{ name: "/platform" }], groups_asserted: "true" }, "groups", "groups_asserted"),
    ).toEqual({ present: false });
  });

  it("reports NO information when both the claim and the marker are missing", () => {
    expect(readTeamClaim({ email: "a@x.test" }, "groups", "groups_asserted")).toEqual({ present: false });
  });

  it("reports NO information when the claim is null and the marker is missing", () => {
    expect(readTeamClaim({ groups: null }, "groups", "groups_asserted")).toEqual({ present: false });
  });

  it("reads a missing claim as 'no groups' only when the marker is present", () => {
    // The marker is what makes offboarding from the last group possible:
    // Keycloak sends no group claim at all for a user in no groups.
    expect(readTeamClaim({ groups_asserted: "true" }, "groups", "groups_asserted")).toEqual({
      present: true,
      paths: [],
    });
  });

  it("reads the marker as an own property, never an inherited one", () => {
    // Every object answers to `constructor` and `toString`. A marker claim
    // named after one of them would read as present for every user, and the
    // absent group claim would then empty everybody's teams.
    expect(readTeamClaim({ email: "a@x.test" }, "groups", "constructor")).toEqual({ present: false });
    expect(readTeamClaim({ email: "a@x.test" }, "groups", "toString")).toEqual({ present: false });
    // The provider's own value still counts, whatever the name.
    expect(readTeamClaim({ constructor: "true" }, "groups", "constructor")).toEqual({
      present: true,
      paths: [],
    });
  });

  it("reports NO information for a single-valued claim, marker or not", () => {
    // A scalar means a misconfigured mapper. Guessing what it meant is the
    // failure this design exists to prevent.
    expect(readTeamClaim({ groups: "/platform" }, "groups", "groups_asserted")).toEqual({ present: false });
    expect(
      readTeamClaim({ groups: "/platform", groups_asserted: "true" }, "groups", "groups_asserted"),
    ).toEqual({ present: false });
    expect(readTeamClaim({ groups: { platform: true } }, "groups", "groups_asserted")).toEqual({
      present: false,
    });
  });

  it("honours configured claim names", () => {
    expect(readTeamClaim({ valet_teams: ["/platform"] }, "valet_teams", "valet_teams_sent")).toEqual({
      present: true,
      paths: ["/platform"],
    });
  });
});

describe("desiredTeamsFromPaths", () => {
  it("derives parent membership from a sub-group path", () => {
    const { teams: wanted } = desiredTeamsFromPaths(["/platform/admins"], ADMIN_GROUP, MIRRORED);
    expect([...wanted.values()]).toEqual([{ path: "/platform", name: "platform", role: "admin" }]);
  });

  it("gives admin whatever the order of the claim", () => {
    const forwards = desiredTeamsFromPaths(["/platform", "/platform/admins"], ADMIN_GROUP, MIRRORED);
    const backwards = desiredTeamsFromPaths(["/platform/admins", "/platform"], ADMIN_GROUP, MIRRORED);
    expect(forwards.teams.get("/platform")?.role).toBe("admin");
    expect(backwards.teams.get("/platform")?.role).toBe("admin");
  });

  it("tolerates surrounding space and repeated slashes", () => {
    const { teams: wanted } = desiredTeamsFromPaths(["  //platform//admins  "], ADMIN_GROUP, MIRRORED);
    expect(wanted.get("/platform")?.role).toBe("admin");
  });

  it("ignores a deeper path and any other sub-group", () => {
    // Every path here names a LISTED group, so the allowlist lets it through
    // and the shape rule is what rejects it. "/" names no group at all, so
    // no list can answer for it and it is reported too.
    const { teams: wanted, ignored } = desiredTeamsFromPaths(
      ["/platform/leads", "/eng/platform/admins", "/"],
      ADMIN_GROUP,
      ["/platform", "/eng"],
    );
    expect(wanted.size).toBe(0);
    expect(ignored).toEqual(["/platform/leads", "/eng/platform/admins", "/"]);
  });

  it("honours a configured admin sub-group name", () => {
    const { teams: wanted } = desiredTeamsFromPaths(["/platform/owners"], "owners", MIRRORED);
    expect(wanted.get("/platform")?.role).toBe("admin");
  });

  it("matches the admin sub-group by whole segment, never by prefix", () => {
    // Each of these reads as an admin grant under prefix matching. The rule
    // compares the whole segment, so none of them grants admin anywhere.
    const dashed = desiredTeamsFromPaths(["/platform-admins"], ADMIN_GROUP, ["/platform-admins"]);
    expect([...dashed.teams.values()]).toEqual([
      { path: "/platform-admins", name: "platform-admins", role: "member" },
    ]);
    expect(dashed.teams.has("/platform")).toBe(false);

    for (const path of ["/platform/admins-readonly", "/platform/readonly-admins", "/platform/Admins"]) {
      const { teams: wanted, ignored } = desiredTeamsFromPaths([path], ADMIN_GROUP, MIRRORED);
      expect(wanted.size).toBe(0);
      expect(ignored).toEqual([path]);
    }
  });

  it("mirrors nothing when no group is listed", () => {
    // The fail-closed default. A deployment that names no group has not
    // decided which of its provider's groups are Valet teams, and the
    // provider carries plenty that are not — so none of them is mirrored.
    const { teams: wanted, ignored } = desiredTeamsFromPaths(
      ["/platform", "/research", "/everyone", "/vpn-users"],
      ADMIN_GROUP,
      [],
    );
    expect(wanted.size).toBe(0);
    expect(ignored).toEqual([]);
  });

  it("mirrors only the listed groups when an allowlist is given", () => {
    const { teams: wanted } = desiredTeamsFromPaths(
      ["/platform", "/research", "/finance"],
      ADMIN_GROUP,
      ["/platform", "/finance"],
    );
    expect([...wanted.keys()]).toEqual(["/platform", "/finance"]);
  });

  it("keeps the admin sub-group of a listed group", () => {
    // The allowlist names parents, and admin arrives on a child path. A
    // filter on the whole path would silently drop every admin grant.
    const { teams: wanted } = desiredTeamsFromPaths(["/platform/admins"], ADMIN_GROUP, ["/platform"]);
    expect(wanted.get("/platform")?.role).toBe("admin");
  });

  it("says nothing about a group the allowlist excludes", () => {
    // Exclusion is a choice the operator made. A warning would repeat on
    // every login of every user for as long as the group exists.
    const { teams: wanted, ignored } = desiredTeamsFromPaths(
      ["/finance", "/finance/leads"],
      ADMIN_GROUP,
      ["/platform"],
    );
    expect(wanted.size).toBe(0);
    expect(ignored).toEqual([]);
  });

  it("mirrors nothing when the allowlist is empty", () => {
    const { teams: wanted } = desiredTeamsFromPaths(["/platform"], ADMIN_GROUP, []);
    expect(wanted.size).toBe(0);
  });

  it("refuses a bare group name, which loses the nesting", () => {
    // A provider whose mapper sends leaf names reports a member of
    // '/contractors/platform' as 'platform' — byte for byte what a member of
    // '/platform' sends. Accepting it would grant a listed team's membership
    // from a group the operator never named.
    const { teams: wanted, notRooted, ignored } = desiredTeamsFromPaths(
      ["platform"],
      ADMIN_GROUP,
      MIRRORED,
    );
    expect(wanted.size).toBe(0);
    expect(notRooted).toEqual(["platform"]);
    expect(ignored).toEqual([]);
  });

  it("says nothing about a bare name the allowlist excludes", () => {
    // A mapper that sends bare names sends one per group, and most are
    // excluded. Reporting those would print a line per excluded group per
    // login, which buries the one line that matters.
    const { notRooted, ignored } = desiredTeamsFromPaths(
      ["everyone", "vpn-users"],
      ADMIN_GROUP,
      MIRRORED,
    );
    expect(notRooted).toEqual([]);
    expect(ignored).toEqual([]);
  });

  it("still accepts a rooted admin sub-group path", () => {
    const { teams: wanted, notRooted } = desiredTeamsFromPaths(
      ["/platform/admins"],
      ADMIN_GROUP,
      MIRRORED,
    );
    expect(wanted.get("/platform")?.role).toBe("admin");
    expect(notRooted).toEqual([]);
  });
});

describe("reconcileIdpTeams", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1");
    await seedUser(db, "u2");
  });

  it("creates a team for a group it has not seen, and marks it as mirrored", async () => {
    const result = await signInWith(db, "u1", ["/platform"]);

    expect(result).toMatchObject({ applied: true, createdTeams: 1, added: 1, removed: 0, skipped: [] });
    expect(await membershipsOf(db, "u1")).toEqual([
      { team: "platform", origin: "idp", externalId: "/platform", role: "member" },
    ]);
  });

  it("reuses the mirror on the next sign-in and writes nothing", async () => {
    await signInWith(db, "u1", ["/platform"]);
    const second = await signInWith(db, "u1", ["/platform"]);

    expect(second).toMatchObject({ createdTeams: 0, added: 0, roleChanged: 0, removed: 0 });
    const rows = await db.select().from(teams).where(eq(teams.orgId, ORG));
    expect(rows).toHaveLength(1);
  });

  it("adds membership on joining a group and removes it on leaving", async () => {
    await signInWith(db, "u1", ["/platform", "/research"]);
    expect((await membershipsOf(db, "u1")).map((m) => m.team)).toEqual(["platform", "research"]);

    const afterLeaving = await signInWith(db, "u1", ["/research"]);
    expect(afterLeaving).toMatchObject({ removed: 1, added: 0 });
    expect((await membershipsOf(db, "u1")).map((m) => m.team)).toEqual(["research"]);
  });

  it("keeps membership of a mirror whose group left the allowlist", async () => {
    // Narrowing the list must STOP mirroring, never deprovision. The claim
    // still puts the user in '/research', so a removal here would say the
    // list decides who is in a team — and one edit would empty a team with
    // its skills, sources and workflows, one login at a time.
    await signInWith(db, "u1", ["/platform", "/research"]);
    expect((await membershipsOf(db, "u1")).map((m) => m.team)).toEqual(["platform", "research"]);

    const narrowed = await signInWith(db, "u1", ["/platform", "/research"], ["/platform"]);
    expect(narrowed).toMatchObject({ removed: 0, added: 0, roleChanged: 0, createdTeams: 0 });
    expect((await membershipsOf(db, "u1")).map((m) => m.team)).toEqual(["platform", "research"]);
  });

  it("keeps every membership when the allowlist becomes empty", async () => {
    // The upgrade path for a deployment configured through environment
    // variables: `auth.sso.teams.groups` has no variable, so such a
    // deployment reaches the sync with an empty list. It must mirror nothing
    // and take nothing away.
    await signInWith(db, "u1", ["/platform", "/research"]);

    const none = await signInWith(db, "u1", ["/platform", "/research"], []);
    expect(none).toMatchObject({ removed: 0, added: 0, createdTeams: 0 });
    expect((await membershipsOf(db, "u1")).map((m) => m.team)).toEqual(["platform", "research"]);
  });

  it("keeps a de-listed mirror even when the claim drops the group too", async () => {
    // Both reasons to remove arrive together. The list is checked first, so
    // the sync cannot act on a group it no longer mirrors — it holds no
    // current information about that team.
    await signInWith(db, "u1", ["/platform", "/research"]);

    const dropped = await signInWith(db, "u1", ["/platform"], ["/platform"]);
    expect(dropped).toMatchObject({ removed: 0 });
    expect((await membershipsOf(db, "u1")).map((m) => m.team)).toEqual(["platform", "research"]);
  });

  it("resumes updating a mirror when its group returns to the allowlist", async () => {
    await signInWith(db, "u1", ["/platform", "/research"]);
    await signInWith(db, "u1", ["/platform"], ["/platform"]);

    // Back on the list, and the claim no longer carries the group. The sync
    // owns the row again, so now it removes.
    const resumed = await signInWith(db, "u1", ["/platform"], MIRRORED);
    expect(resumed).toMatchObject({ removed: 1 });
    expect((await membershipsOf(db, "u1")).map((m) => m.team)).toEqual(["platform"]);
  });

  it("grants admin through the sub-group and demotes on leaving it", async () => {
    await signInWith(db, "u1", ["/platform/admins"]);
    expect(await membershipsOf(db, "u1")).toEqual([
      { team: "platform", origin: "idp", externalId: "/platform", role: "admin" },
    ]);

    const afterDemotion = await signInWith(db, "u1", ["/platform"]);
    expect(afterDemotion).toMatchObject({ roleChanged: 1, removed: 0 });
    expect(await membershipsOf(db, "u1")).toEqual([
      { team: "platform", origin: "idp", externalId: "/platform", role: "member" },
    ]);
  });

  it("demotes and removes the last admin of a mirrored team", async () => {
    // `setRole` and `removeMember` both refuse this write. Offboarding is
    // exactly this write, so the sync must not go through them.
    await signInWith(db, "u1", ["/platform/admins"]);

    await signInWith(db, "u1", ["/platform"]);
    expect((await membershipsOf(db, "u1"))[0]?.role).toBe("member");

    await signInWith(db, "u1", ["/platform/admins"]);
    const offboarded = await reconcileIdpTeams(db, {
      orgId: ORG,
      userId: "u1",
      claim: { present: true, paths: [] },
      adminGroupName: ADMIN_GROUP,
      mirroredGroups: MIRRORED,
    });

    expect(offboarded).toMatchObject({ applied: true, removed: 1 });
    expect(await membershipsOf(db, "u1")).toEqual([]);
    // The team row survives. One user's token never says a group was deleted.
    expect(await teamNamed(db, "platform")).toMatchObject({ origin: "idp", externalId: "/platform" });
  });

  it("changes nothing at all when the claim is missing", async () => {
    await signInWith(db, "u1", ["/platform/admins"]);
    const local = await createTeam(db, { orgId: ORG, name: "design", creatorUserId: "u1" });
    const before = await membershipsOf(db, "u1");

    const result = await reconcileIdpTeams(db, {
      orgId: ORG,
      userId: "u1",
      claim: { present: false },
      adminGroupName: ADMIN_GROUP,
      mirroredGroups: MIRRORED,
    });

    expect(result).toEqual({
      applied: false,
      createdTeams: 0,
      added: 0,
      roleChanged: 0,
      removed: 0,
      skipped: [],
    });
    expect(await membershipsOf(db, "u1")).toEqual(before);
    expect(await teamNamed(db, "design")).toMatchObject({ id: local.id, origin: "local" });
  });

  it("changes nothing when the claim holds entries it cannot read", async () => {
    // A mapper that sends group OBJECTS instead of paths. Every entry is
    // unreadable, so a filter-and-continue would leave an empty list that
    // reads as "in no groups" and would strip the user's every team.
    await signInWith(db, "u1", ["/platform", "/research"]);
    const before = await membershipsOf(db, "u1");

    const claim = readTeamClaim({ groups: [{ name: "/platform" }] }, "groups", "groups_asserted");
    const result = await reconcileIdpTeams(db, {
      orgId: ORG,
      userId: "u1",
      claim,
      adminGroupName: ADMIN_GROUP,
      mirroredGroups: MIRRORED,
    });

    expect(result).toMatchObject({ applied: false, removed: 0 });
    expect(await membershipsOf(db, "u1")).toEqual(before);
  });

  it("changes nothing when the claim holds blanks and nothing else", async () => {
    // The row-level half of the claim test above: a mapper that sends `[""]`
    // must not empty the user's teams.
    await signInWith(db, "u1", ["/platform", "/research"]);
    const before = await membershipsOf(db, "u1");

    const claim = readTeamClaim({ groups: ["", "  "], groups_asserted: "true" }, "groups", "groups_asserted");
    const result = await reconcileIdpTeams(db, {
      orgId: ORG,
      userId: "u1",
      claim,
      adminGroupName: ADMIN_GROUP,
      mirroredGroups: MIRRORED,
    });

    expect(result).toMatchObject({ applied: false, removed: 0 });
    expect(await membershipsOf(db, "u1")).toEqual(before);
  });

  it("empties the mirrored teams on an explicitly empty claim, and only those", async () => {
    await signInWith(db, "u1", ["/platform/admins", "/research"]);
    await createTeam(db, { orgId: ORG, name: "design", creatorUserId: "u1" });

    const result = await reconcileIdpTeams(db, {
      orgId: ORG,
      userId: "u1",
      claim: { present: true, paths: [] },
      adminGroupName: ADMIN_GROUP,
      mirroredGroups: MIRRORED,
    });

    expect(result).toMatchObject({ applied: true, removed: 2, added: 0 });
    expect(await membershipsOf(db, "u1")).toEqual([
      { team: "design", origin: "local", externalId: null, role: "admin" },
    ]);
  });

  it("leaves a local team's membership alone when the claim never mentions it", async () => {
    const local = await createTeam(db, { orgId: ORG, name: "design", creatorUserId: "u1" });
    await addMember(db, { teamId: local.id, userId: "u2", role: "member" });

    await signInWith(db, "u2", ["/research"]);

    expect(await membershipsOf(db, "u2")).toEqual([
      { team: "design", origin: "local", externalId: null, role: "member" },
      { team: "research", origin: "idp", externalId: "/research", role: "member" },
    ]);
  });

  it("skips a group whose name a local team already holds, and touches neither", async () => {
    const local = await createTeam(db, { orgId: ORG, name: "platform", creatorUserId: "u1" });

    const result = await signInWith(db, "u2", ["/platform", "/research"]);

    expect(result.skipped).toEqual([{ groupPath: "/platform", reason: "name_taken_by_local_team" }]);
    // The local team keeps its name, its origin, and its one member.
    expect(await teamNamed(db, "platform")).toEqual({
      id: local.id,
      orgId: ORG,
      name: "platform",
      origin: "local",
      externalId: null,
      createdAt: local.createdAt,
    });
    expect(await membershipsOf(db, "u1")).toEqual([
      { team: "platform", origin: "local", externalId: null, role: "admin" },
    ]);
    // The rest of the claim still applied.
    expect(await membershipsOf(db, "u2")).toEqual([
      { team: "research", origin: "idp", externalId: "/research", role: "member" },
    ]);
  });

  it("mirrors the group once the colliding local team is gone", async () => {
    const local = await createTeam(db, { orgId: ORG, name: "platform", creatorUserId: "u1" });
    await signInWith(db, "u2", ["/platform"]);

    await deleteTeam(db, { teamId: local.id });
    const result = await signInWith(db, "u2", ["/platform"]);

    expect(result).toMatchObject({ createdTeams: 1, added: 1, skipped: [] });
    expect(await teamNamed(db, "platform")).toMatchObject({ origin: "idp", externalId: "/platform" });
  });

  it("skips a group whose name another mirrored group already holds", async () => {
    await db.insert(teams).values({
      id: "team_legacy",
      orgId: ORG,
      name: "platform",
      origin: "idp",
      externalId: "/legacy/platform",
      createdAt: Date.now(),
    });

    const result = await signInWith(db, "u1", ["/platform"]);

    expect(result.skipped).toEqual([{ groupPath: "/platform", reason: "name_taken_by_other_group" }]);
    expect(await membershipsOf(db, "u1")).toEqual([]);
  });

  it("never adopts a local team, even one that carries the group path", async () => {
    // Nothing writes `external_id` on a local team today. The day something
    // does, adoption would hand that team's membership to the identity
    // provider, and the first claim without the group would empty it. The
    // sync must read the path on mirrored rows only, and treat this row as
    // the name collision it is.
    const local = await createTeam(db, { orgId: ORG, name: "platform", creatorUserId: "u1" });
    await db.update(teams).set({ externalId: "/platform" }).where(eq(teams.id, local.id));

    const result = await signInWith(db, "u2", ["/platform"]);

    expect(result.skipped).toEqual([{ groupPath: "/platform", reason: "name_taken_by_local_team" }]);
    expect(await membershipsOf(db, "u2")).toEqual([]);
    // The team keeps its origin and its one member.
    expect(await teamNamed(db, "platform")).toMatchObject({ id: local.id, origin: "local" });
    expect(await membershipsOf(db, "u1")).toEqual([
      { team: "platform", origin: "local", externalId: "/platform", role: "admin" },
    ]);
  });

  it("reports a path it does not mirror and invents no membership from it", async () => {
    const result = await signInWith(db, "u1", ["/platform/leads", "/platform"]);

    expect(result.skipped).toEqual([{ groupPath: "/platform/leads", reason: "path_not_mirrored" }]);
    expect(await membershipsOf(db, "u1")).toEqual([
      { team: "platform", origin: "idp", externalId: "/platform", role: "member" },
    ]);
  });

  it("keeps each user's mirrored membership separate", async () => {
    await signInWith(db, "u1", ["/platform/admins"]);
    await signInWith(db, "u2", ["/platform"]);

    const removed = await reconcileIdpTeams(db, {
      orgId: ORG,
      userId: "u2",
      claim: { present: true, paths: [] },
      adminGroupName: ADMIN_GROUP,
      mirroredGroups: MIRRORED,
    });

    expect(removed).toMatchObject({ removed: 1 });
    expect(await membershipsOf(db, "u1")).toEqual([
      { team: "platform", origin: "idp", externalId: "/platform", role: "admin" },
    ]);
    expect(await membershipsOf(db, "u2")).toEqual([]);
  });

  it("never touches a team in another org", async () => {
    await db.insert(orgs).values({ id: "org2", name: "Other", createdAt: Date.now() });
    await db.insert(teams).values({
      id: "team_other_org",
      orgId: "org2",
      name: "platform",
      origin: "idp",
      externalId: "/platform",
      createdAt: Date.now(),
    });
    await db.insert(teamMembers).values({ teamId: "team_other_org", userId: "u1", role: "admin" });

    const result = await reconcileIdpTeams(db, {
      orgId: ORG,
      userId: "u1",
      claim: { present: true, paths: [] },
      adminGroupName: ADMIN_GROUP,
      mirroredGroups: MIRRORED,
    });

    expect(result).toMatchObject({ removed: 0 });
    expect(await membershipsOf(db, "u1")).toEqual([
      { team: "platform", origin: "idp", externalId: "/platform", role: "admin" },
    ]);
  });
});

describe("reportTeamSyncState", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1");
  });

  it("counts a mirror whose group is no longer listed", async () => {
    // The one state nothing on screen shows: mirroring is on, so the row
    // still reads "Identity provider" and still refuses every edit, but the
    // sync no longer updates it.
    await signInWith(db, "u1", ["/platform", "/research"]);

    const report = await reportTeamSyncState(db, {
      orgId: ORG,
      enabled: true,
      ssoConfigured: true,
      mirroredGroups: ["/platform"],
    });

    expect(report).toEqual({
      enabled: true,
      mirroredGroups: 1,
      mirroredTeams: 2,
      unlistedTeams: 1,
    });
  });

  it("counts no unlisted mirror when every group is listed", async () => {
    await signInWith(db, "u1", ["/platform", "/research"]);

    const report = await reportTeamSyncState(db, {
      orgId: ORG,
      enabled: true,
      ssoConfigured: true,
      mirroredGroups: MIRRORED,
    });

    expect(report).toMatchObject({ mirroredTeams: 2, unlistedTeams: 0 });
  });
});
