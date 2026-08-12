/**
 * `canViewSession`: direct ownership (the existing rule, unchanged) plus
 * exactly one addition — a live member of a team-owned session's team.
 * Real PGlite db (membership is re-checked per call, never cached), not a
 * mock — this is a security-relevant check.
 */
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { teamMembers, teams } from "../schema/index.js";
import { canViewSession } from "./session-access.js";

describe("canViewSession", () => {
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
    await buildAppQueryable(pglite).query(`TRUNCATE teams, team_members RESTART IDENTITY CASCADE`);
  });

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
