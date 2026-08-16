/**
 * `canViewSession`: direct ownership (the existing rule, unchanged) plus
 * exactly one addition — a live member of a team-owned session's team.
 *
 * `canAdministerSession`: its mirror for the lifecycle routes (set model,
 * pause, delete). A team-owned session needs team-admin authority there,
 * and the `user_id` on the row — the member who opened the assistant first
 * — buys nothing.
 *
 * Real PGlite db (membership is re-checked per call, never cached), not a
 * mock — these are security-relevant checks.
 */
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { orgMembers, teamMembers, teams } from "../schema/index.js";
import { canAdministerSession, canViewSession } from "./session-access.js";

let db: AppDb;
let pglite: PGlite;

beforeAll(async () => {
  pglite = new PGlite();
  await applyAppMigrations(buildAppQueryable(pglite));
  db = buildAppDb(pglite);
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await buildAppQueryable(pglite).query(`TRUNCATE teams, team_members, org_members RESTART IDENTITY CASCADE`);
});

/** Seeds a team in `org-1` plus the given roster. */
async function seedTeam(teamId: string, members: Array<{ userId: string; role: "admin" | "member" }>): Promise<void> {
  await db.insert(teams).values({ id: teamId, orgId: "org-1", name: `Team ${teamId}`, createdAt: 1 });
  for (const m of members) {
    await db.insert(teamMembers).values({ teamId, userId: m.userId, role: m.role });
  }
}

/** Seeds an `org-1` membership row — the source `isOrgAdmin` reads. */
async function seedOrgMember(userId: string, role: "admin" | "member"): Promise<void> {
  await db.insert(orgMembers).values({ orgId: "org-1", userId, role, createdAt: 1 });
}

describe("canViewSession", () => {
  it("allows the session's direct owner", async () => {
    const ok = await canViewSession(db, { userId: "u1", ownerType: "user", ownerId: "u1" }, "u1");
    expect(ok).toBe(true);
  });

  it("rejects a different user for a user-owned session", async () => {
    const ok = await canViewSession(db, { userId: "u1", ownerType: "user", ownerId: "u1" }, "u2");
    expect(ok).toBe(false);
  });

  it("allows a live member of a team-owned session's team", async () => {
    await db.insert(teams).values({ id: "team_1", orgId: "org-1", name: "Platform", createdAt: 1 });
    await db.insert(teamMembers).values({ teamId: "team_1", userId: "member-user", role: "member" });

    const ok = await canViewSession(
      db,
      { userId: "team:team_1", ownerType: "team", ownerId: "team_1" },
      "member-user",
    );
    expect(ok).toBe(true);
  });

  it("rejects a non-member for a team-owned session", async () => {
    await db.insert(teams).values({ id: "team_1", orgId: "org-1", name: "Platform", createdAt: 1 });

    const ok = await canViewSession(
      db,
      { userId: "team:team_1", ownerType: "team", ownerId: "team_1" },
      "outsider",
    );
    expect(ok).toBe(false);
  });

  it("drops access the moment membership is removed — no caching across calls", async () => {
    await db.insert(teams).values({ id: "team_1", orgId: "org-1", name: "Platform", createdAt: 1 });
    await db.insert(teamMembers).values({ teamId: "team_1", userId: "member-user", role: "member" });

    const before = await canViewSession(
      db,
      { userId: "team:team_1", ownerType: "team", ownerId: "team_1" },
      "member-user",
    );
    expect(before).toBe(true);

    await db.delete(teamMembers).where(eq(teamMembers.userId, "member-user"));

    const after = await canViewSession(
      db,
      { userId: "team:team_1", ownerType: "team", ownerId: "team_1" },
      "member-user",
    );
    expect(after).toBe(false);
  });

  it("rejects an org-owned session — org-level view access is a separate, not-yet-built decision", async () => {
    const ok = await canViewSession(db, { userId: "org:org-1", ownerType: "org", ownerId: "org-1" }, "any-user");
    expect(ok).toBe(false);
  });
});

describe("canAdministerSession", () => {
  /** A team-owned session, stamped with the member who opened it first. */
  const teamSession = { userId: "first-opener", ownerType: "team", ownerId: "team_1" };

  it("allows a team admin of the owning team", async () => {
    await seedTeam("team_1", [{ userId: "team-admin-user", role: "admin" }]);

    const ok = await canAdministerSession(db, teamSession, "team-admin-user");
    expect(ok).toBe(true);
  });

  it("allows an org admin who is not on the team — the same recovery path team mutations have", async () => {
    await seedTeam("team_1", []);
    await seedOrgMember("org-admin-user", "admin");

    const ok = await canAdministerSession(db, teamSession, "org-admin-user");
    expect(ok).toBe(true);
  });

  it("denies a plain team member — membership grants viewing, not administration", async () => {
    await seedTeam("team_1", [{ userId: "member-user", role: "member" }]);

    const ok = await canAdministerSession(db, teamSession, "member-user");
    expect(ok).toBe(false);
  });

  it("denies a plain org member who is not on the team", async () => {
    await seedTeam("team_1", []);
    await seedOrgMember("plain-org-user", "member");

    const ok = await canAdministerSession(db, teamSession, "plain-org-user");
    expect(ok).toBe(false);
  });

  it("denies a non-member", async () => {
    await seedTeam("team_1", [{ userId: "team-admin-user", role: "admin" }]);

    const ok = await canAdministerSession(db, teamSession, "outsider");
    expect(ok).toBe(false);
  });

  it("denies the member stamped on the row when that member is not a team admin", async () => {
    // The bug this check exists for: `ensureDefaultAssistantSession` writes
    // `agent_sessions.userId = meta.actorUserId`, so the first member to
    // open the team's assistant lands on the row. That stamp must not make
    // them the owner of an agent the whole team shares.
    await seedTeam("team_1", [
      { userId: "first-opener", role: "member" },
      { userId: "team-admin-user", role: "admin" },
    ]);

    const ok = await canAdministerSession(db, teamSession, "first-opener");
    expect(ok).toBe(false);
  });

  it("drops access the moment an admin is demoted — no caching across calls", async () => {
    await seedTeam("team_1", [{ userId: "team-admin-user", role: "admin" }]);

    const before = await canAdministerSession(db, teamSession, "team-admin-user");
    expect(before).toBe(true);

    await db
      .update(teamMembers)
      .set({ role: "member" })
      .where(eq(teamMembers.userId, "team-admin-user"));

    const after = await canAdministerSession(db, teamSession, "team-admin-user");
    expect(after).toBe(false);
  });

  it("denies everyone when the owning team row is gone — no team, no authority", async () => {
    await seedOrgMember("org-admin-user", "admin");

    const ok = await canAdministerSession(db, teamSession, "org-admin-user");
    expect(ok).toBe(false);
  });

  it("allows the owner of a user-owned session", async () => {
    const ok = await canAdministerSession(db, { userId: "u1", ownerType: "user", ownerId: "u1" }, "u1");
    expect(ok).toBe(true);
  });

  it("rejects a different user for a user-owned session", async () => {
    const ok = await canAdministerSession(db, { userId: "u1", ownerType: "user", ownerId: "u1" }, "u2");
    expect(ok).toBe(false);
  });

  it("rejects a team admin of an unrelated team for a user-owned session — the user case does not widen", async () => {
    await seedTeam("team_2", [{ userId: "other-team-admin", role: "admin" }]);

    const ok = await canAdministerSession(db, { userId: "u1", ownerType: "user", ownerId: "u1" }, "other-team-admin");
    expect(ok).toBe(false);
  });

  it("rejects an org admin for a user-owned session — org admin is a team recovery path, not a session master key", async () => {
    await seedOrgMember("org-admin-user", "admin");

    const ok = await canAdministerSession(db, { userId: "u1", ownerType: "user", ownerId: "u1" }, "org-admin-user");
    expect(ok).toBe(false);
  });

  it("rejects an org-owned session — org-level administration is a separate, not-yet-built decision", async () => {
    await seedOrgMember("org-admin-user", "admin");

    const ok = await canAdministerSession(
      db,
      { userId: "org:org-1", ownerType: "org", ownerId: "org-1" },
      "org-admin-user",
    );
    expect(ok).toBe(false);
  });
});

/**
 * The row a team assistant's session actually has.
 *
 * `agent_sessions.userId` does NOT hold the team on such a row:
 * `ensureAssistantSession` stamps `meta.actorUserId`, which is the member
 * who opened the assistant first. `canViewSession` used to compare that
 * value before consulting membership, which admitted that one member
 * forever — including after they left the team.
 */
describe("canViewSession — a team session is not owned by whoever opened it", () => {
  const openedByAlice = { userId: "alice", ownerType: "team", ownerId: "team-1" };

  it("admits the first opener while they are still on the team", async () => {
    await seedTeam("team-1", [{ userId: "alice", role: "member" }]);
    expect(await canViewSession(db, openedByAlice, "alice")).toBe(true);
  });

  it("refuses the first opener once they leave the team", async () => {
    // Seeded with a different member, so the team still exists and alice is
    // simply no longer on it — the state after removeMember.
    await seedTeam("team-1", [{ userId: "bob", role: "admin" }]);
    expect(await canViewSession(db, openedByAlice, "alice")).toBe(false);
  });

  it("admits any other current member, who never appears in the row", async () => {
    await seedTeam("team-1", [
      { userId: "alice", role: "member" },
      { userId: "bob", role: "member" },
    ]);
    expect(await canViewSession(db, openedByAlice, "bob")).toBe(true);
  });

  it("refuses a non-member who is not the stamped opener either", async () => {
    await seedTeam("team-1", [{ userId: "alice", role: "member" }]);
    expect(await canViewSession(db, openedByAlice, "carol")).toBe(false);
  });

  it("still admits the direct owner of a NON-team session", async () => {
    // The replaced comparison must survive for every other owner type.
    expect(
      await canViewSession(db, { userId: "u1", ownerType: "user", ownerId: "u1" }, "u1"),
    ).toBe(true);
  });
});
