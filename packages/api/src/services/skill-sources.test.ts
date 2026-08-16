/**
 * Tracked skill repositories — the `skill_sources` rows a person adds, and
 * the repo-spec parsing that turns what they paste into one row.
 *
 * Ownership mirrors `services/skills.ts` exactly (your own rows plus the rows
 * of every team you belong to, a cross-owner read reported as not found), so
 * this suite asserts the same properties that suite does, on sources.
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, skills, users } from "../schema/index.js";
import { addMember, createTeam, deleteTeam } from "./teams.js";
import { createSkill, type SkillOwner } from "./skills.js";
import {
  createSkillSource,
  deleteSkillSource,
  listSkillSources,
  ownedSkillSourceRow,
  parseRepoInput,
  SkillSourceConflictError,
  SkillSourceInputError,
} from "./skill-sources.js";

const ORG = "org1";

async function seedUser(db: AppDb, id: string) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId: ORG, userId: id, role: "member" });
}

function owner(userId: string): SkillOwner {
  return { userId, orgId: ORG };
}

describe("parseRepoInput", () => {
  it("accepts owner/repo", () => {
    expect(parseRepoInput("tkhq/skills")).toEqual({
      repoFullName: "tkhq/skills",
      ref: "",
      subpath: "",
    });
  });

  it("accepts a repository URL, with or without a scheme or a .git suffix", () => {
    const expected = { repoFullName: "tkhq/skills", ref: "", subpath: "" };
    expect(parseRepoInput("https://github.com/tkhq/skills")).toEqual(expected);
    expect(parseRepoInput("github.com/tkhq/skills/")).toEqual(expected);
    expect(parseRepoInput("https://github.com/tkhq/skills.git")).toEqual(expected);
  });

  it("reads the ref and the subdirectory out of a tree URL", () => {
    expect(parseRepoInput("https://github.com/tkhq/skills/tree/main/agent/skills")).toEqual({
      repoFullName: "tkhq/skills",
      ref: "main",
      subpath: "agent/skills",
    });
  });

  it("rejects a host that is not GitHub", () => {
    expect(() => parseRepoInput("https://gitlab.com/tkhq/skills")).toThrow(SkillSourceInputError);
  });

  it("rejects text that is not a repository", () => {
    expect(() => parseRepoInput("")).toThrow(SkillSourceInputError);
    expect(() => parseRepoInput("skills")).toThrow(SkillSourceInputError);
    expect(() => parseRepoInput("tkhq/skills/extra")).toThrow(SkillSourceInputError);
  });

  it("rejects a subdirectory that climbs out of the repository", () => {
    expect(() => parseRepoInput("tkhq/skills", { subpath: "../etc" })).toThrow(
      SkillSourceInputError,
    );
  });
});

describe("skill sources service", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1");
    await seedUser(db, "u2");
  });

  it("creates a source for the caller and schedules its first sync now", async () => {
    const created = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    expect(created.id).toMatch(/^skillsrc_/);
    expect(created.repoFullName).toBe("tkhq/skills");
    expect(created.ownerType).toBe("user");
    expect(created.ownerId).toBe("u1");
    expect(created.enabled).toBe(true);
    expect(created.status).toBe("pending");
    expect(created.lastSha).toBeNull();
    expect(created.nextAttemptAt).toBeLessThanOrEqual(Date.now());
  });

  it("hides another user's source behind the null a missing id returns", async () => {
    const mine = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    expect(await ownedSkillSourceRow(db, owner("u2"), mine.id)).toBeNull();
    expect(await ownedSkillSourceRow(db, owner("u2"), "skillsrc_missing")).toBeNull();
  });

  it("rejects the same repository and subdirectory twice in one owner scope", async () => {
    await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    await expect(createSkillSource(db, owner("u1"), { repo: "tkhq/skills" })).rejects.toThrow(
      SkillSourceConflictError,
    );
    // A different subdirectory of the same repository is a different source.
    await createSkillSource(db, owner("u1"), { repo: "tkhq/skills", subpath: "agent" });
  });

  it("lists the caller's own sources and every team source they can reach", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createSkillSource(db, owner("u1"), { repo: "tkhq/mine" });
    await createSkillSource(db, owner("u1"), { repo: "tkhq/ours", teamId: team.id });

    expect((await listSkillSources(db, owner("u1"))).map((r) => r.repoFullName)).toEqual([
      "tkhq/mine",
      "tkhq/ours",
    ]);
    expect(await listSkillSources(db, owner("u2"))).toEqual([]);

    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    expect((await listSkillSources(db, owner("u2"))).map((r) => r.repoFullName)).toEqual([
      "tkhq/ours",
    ]);
  });

  it("reports a team the caller does not belong to as not found", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });

    await expect(
      createSkillSource(db, owner("u2"), { repo: "tkhq/skills", teamId: team.id }),
    ).rejects.toThrow(/team/);
  });

  it("deletes a source together with the skills it mirrors, and nothing else", async () => {
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });
    await createSkill(db, owner("u1"), {
      name: "mirrored",
      description: "From the repository.",
      content: "# Mirrored\n",
      origin: "repo",
      sourceId: source.id,
    });
    await createSkill(db, owner("u1"), {
      name: "written-here",
      description: "Written in the product.",
      content: "# Local\n",
    });

    expect(await deleteSkillSource(db, owner("u1"), source.id)).toBe(true);

    const left = await db.select().from(skills);
    expect(left.map((r) => r.name)).toEqual(["written-here"]);
    expect(await ownedSkillSourceRow(db, owner("u1"), source.id)).toBeNull();
  });

  it("refuses to delete another owner's source", async () => {
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    expect(await deleteSkillSource(db, owner("u2"), source.id)).toBe(false);
    expect(await ownedSkillSourceRow(db, owner("u1"), source.id)).not.toBeNull();
  });

  it("removes a deleted team's sources with the team", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createSkillSource(db, owner("u1"), { repo: "tkhq/ours", teamId: team.id });

    await deleteTeam(db, { teamId: team.id });

    expect(await listSkillSources(db, owner("u1"))).toEqual([]);
  });
});
