/**
 * Owner-scoped stored-skill operations. The ownership rules mirror
 * `workflows/service.ts` exactly — a cross-owner read returns null, and a
 * listing unions the caller's own rows with the rows of every team the
 * caller belongs to — so this suite asserts the same properties the
 * workflow suite does, on skills.
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, skills, users, type SkillRow } from "../schema/index.js";
import { addMember, createTeam, deleteTeam, removeMember } from "./teams.js";
import {
  createSkill,
  deleteSkill,
  listSkillSourcesFor,
  listSkills,
  ownedSkillRow,
  rowToSkillSource,
  SkillNameConflictError,
  SkillNotLocalError,
  SkillValidationError,
  updateSkill,
  writeScope,
  type SkillOwner,
} from "./skills.js";

const ORG = "org1";

async function seedUser(db: AppDb, id: string) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId: ORG, userId: id, role: "member" });
}

function owner(userId: string): SkillOwner {
  return { userId, orgId: ORG };
}

/** Insert an org-owned skill row directly. `createSkill` only writes user and
 * team rows, so the org-library case must seed the row itself. */
async function insertOrgSkill(db: AppDb, name: string, content: string): Promise<void> {
  const now = Date.now();
  await db.insert(skills).values({
    id: `skill_${name}`,
    orgId: ORG,
    ownerType: "org",
    ownerId: ORG,
    origin: "local",
    sourceId: null,
    name,
    description: `${name} description`,
    content,
    frontmatter: { name, description: `${name} description` },
    contentSha: "sha",
    upstreamPath: null,
    createdAt: now,
    updatedAt: now,
  });
}

const BODY = "# Deploy\n\nRun `make deploy`.\n";

describe("stored skills service", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1");
    await seedUser(db, "u2");
  });

  it("creates a personal skill and reads it back", async () => {
    const created = await createSkill(db, owner("u1"), {
      name: "deploy",
      description: "How to deploy the service.",
      content: BODY,
    });

    expect(created.origin).toBe("local");
    expect(created.ownerType).toBe("user");
    expect(created.ownerId).toBe("u1");
    expect(created.contentSha).toMatch(/^[0-9a-f]{64}$/);
    expect(created.frontmatter).toEqual({ name: "deploy", description: "How to deploy the service." });

    const row = await ownedSkillRow(db, owner("u1"), created.id);
    expect(row?.content).toBe(BODY);
  });

  it("hides another user's skill behind the same null a missing id returns", async () => {
    const mine = await createSkill(db, owner("u1"), {
      name: "deploy",
      description: "How to deploy the service.",
      content: BODY,
    });

    expect(await ownedSkillRow(db, owner("u2"), mine.id)).toBeNull();
    expect(await ownedSkillRow(db, owner("u2"), "skill_missing")).toBeNull();
  });

  it("lists the caller's own skills and every team skill they can reach", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createSkill(db, owner("u1"), { name: "mine", description: "Personal.", content: BODY });
    await createSkill(db, owner("u1"), {
      name: "ours",
      description: "Shared.",
      content: BODY,
      teamId: team.id,
    });

    const mine = await listSkills(db, owner("u1"));
    expect(mine.map((s) => s.name).sort()).toEqual(["mine", "ours"]);

    // u2 is not on the team yet, so neither row is reachable.
    expect(await listSkills(db, owner("u2"))).toEqual([]);

    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    const theirs = await listSkills(db, owner("u2"));
    expect(theirs.map((s) => s.name)).toEqual(["ours"]);
  });

  it("rejects a second skill with the same name in one owner scope", async () => {
    await createSkill(db, owner("u1"), { name: "deploy", description: "First.", content: BODY });

    await expect(
      createSkill(db, owner("u1"), { name: "deploy", description: "Second.", content: BODY }),
    ).rejects.toThrow(SkillNameConflictError);
  });

  it("allows the same name in two different owner scopes", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createSkill(db, owner("u1"), { name: "deploy", description: "Personal.", content: BODY });
    await createSkill(db, owner("u1"), {
      name: "deploy",
      description: "Shared.",
      content: BODY,
      teamId: team.id,
    });

    const rows = await listSkills(db, owner("u1"));
    expect(rows).toHaveLength(2);
    // Personal first — `listSkillSourcesFor` drops the later duplicate, so
    // the order decides which body a session gets.
    expect(rows[0]?.ownerType).toBe("user");
    expect(rows[1]?.ownerType).toBe("team");
  });

  it("rejects a name the skill spec does not allow", async () => {
    await expect(
      createSkill(db, owner("u1"), { name: "Deploy Now", description: "Bad name.", content: BODY }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("rejects an empty description", async () => {
    await expect(
      createSkill(db, owner("u1"), { name: "deploy", description: "", content: BODY }),
    ).rejects.toThrow(SkillValidationError);
  });

  it("updates the body and re-hashes it", async () => {
    const created = await createSkill(db, owner("u1"), {
      name: "deploy",
      description: "How to deploy the service.",
      content: BODY,
    });

    const updated = await updateSkill(db, owner("u1"), created.id, { content: "# New\n" });
    expect(updated?.content).toBe("# New\n");
    expect(updated?.contentSha).not.toBe(created.contentSha);
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it("returns null when updating a skill the caller does not own", async () => {
    const created = await createSkill(db, owner("u1"), {
      name: "deploy",
      description: "How to deploy the service.",
      content: BODY,
    });

    expect(await updateSkill(db, owner("u2"), created.id, { content: "# New\n" })).toBeNull();
    expect(await deleteSkill(db, owner("u2"), created.id)).toBe("not_found");
  });

  it("refuses to change a repo-origin skill", async () => {
    const created = await createSkill(db, owner("u1"), {
      name: "deploy",
      description: "How to deploy the service.",
      content: BODY,
      origin: "repo",
      upstreamPath: "skills/deploy/SKILL.md",
    });

    await expect(updateSkill(db, owner("u1"), created.id, { content: "# New\n" })).rejects.toThrow(
      SkillNotLocalError,
    );
    expect(await deleteSkill(db, owner("u1"), created.id)).toBe("not_local");
  });

  it("removes a team's skills when the team is deleted", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createSkill(db, owner("u1"), {
      name: "ours",
      description: "Shared.",
      content: BODY,
      teamId: team.id,
    });

    // Asserted against the table, not against `listSkills`: dropping the
    // memberships already makes the row unreachable, so a list-based check
    // would pass while the row sat there forever with no owner who can ever
    // reach it again.
    await deleteTeam(db, { teamId: team.id });
    expect(await db.select().from(skills)).toEqual([]);
  });

  it("deletes a local skill", async () => {
    const created = await createSkill(db, owner("u1"), {
      name: "deploy",
      description: "How to deploy the service.",
      content: BODY,
    });

    expect(await deleteSkill(db, owner("u1"), created.id)).toBe("deleted");
    expect(await listSkills(db, owner("u1"))).toEqual([]);
  });
});

/**
 * `writeScope` is the predicate `updateSkill` and `deleteSkill` carry on the
 * statement that changes the row. Its job is to re-ask the one authority
 * question that can change between the read and the write — team membership
 * — so it is exercised directly here: the read that precedes it in the
 * service would mask the difference.
 */
describe("writeScope", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1");
    await seedUser(db, "u2");
  });

  // u1 creates the team and stays its only admin, so u2 is the one who can
  // be removed — a team must keep an admin.
  async function teamSkill() {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    const row = await createSkill(db, owner("u2"), {
      name: "deploy",
      description: "How to deploy the service.",
      content: BODY,
      teamId: team.id,
    });
    return { team, row };
  }

  function rename(row: SkillRow, by: SkillOwner) {
    return db
      .update(skills)
      .set({ name: "renamed" })
      .where(writeScope(by, row))
      .returning({ id: skills.id });
  }

  it("writes a team skill for a member", async () => {
    const { row } = await teamSkill();
    expect(await rename(row, owner("u2"))).toHaveLength(1);
  });

  it("stops a write by a member removed after the row was read", async () => {
    const { team, row } = await teamSkill();
    await removeMember(db, { teamId: team.id, userId: "u2" });

    expect(await rename(row, owner("u2"))).toEqual([]);
  });

  it("writes a personal skill without consulting any team", async () => {
    const row = await createSkill(db, owner("u1"), {
      name: "mine",
      description: "Personal.",
      content: BODY,
    });
    expect(await rename(row, owner("u1"))).toHaveLength(1);
  });
});

describe("listSkillSourcesFor", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1");
    await seedUser(db, "u2");
  });

  it("returns a user principal's own skills plus their team skills", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createSkill(db, owner("u1"), { name: "mine", description: "Personal.", content: BODY });
    await createSkill(db, owner("u1"), {
      name: "ours",
      description: "Shared.",
      content: BODY,
      teamId: team.id,
    });

    const sources = await listSkillSourcesFor(db, { type: "user", id: "u1" }, ORG);
    expect(sources.map((s) => s.name)).toEqual(["mine", "ours"]);
    expect(sources[0]?.source).toBe("user");
    expect(sources[0]?.content).toBe(BODY);
  });

  it("returns only the team's own skills for a team principal", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createSkill(db, owner("u1"), { name: "mine", description: "Personal.", content: BODY });
    await createSkill(db, owner("u1"), {
      name: "ours",
      description: "Shared.",
      content: BODY,
      teamId: team.id,
    });

    const sources = await listSkillSourcesFor(db, { type: "team", id: team.id }, ORG);
    expect(sources.map((s) => s.name)).toEqual(["ours"]);
  });

  it("drops the team copy when a personal skill claims the same name", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createSkill(db, owner("u1"), {
      name: "deploy",
      description: "Personal.",
      content: "# Personal\n",
    });
    await createSkill(db, owner("u1"), {
      name: "deploy",
      description: "Shared.",
      content: "# Shared\n",
      teamId: team.id,
    });

    const sources = await listSkillSourcesFor(db, { type: "user", id: "u1" }, ORG);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.content).toBe("# Personal\n");
  });

  it("delivers an org-library skill to a user principal, ordered after team", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createSkill(db, owner("u1"), { name: "mine", description: "Personal.", content: BODY });
    await createSkill(db, owner("u1"), {
      name: "ours",
      description: "Shared.",
      content: BODY,
      teamId: team.id,
    });
    await insertOrgSkill(db, "org-skill", "# Org\n");

    const sources = await listSkillSourcesFor(db, { type: "user", id: "u1" }, ORG);
    // user rows → team rows → org rows, each still name-sorted within group.
    expect(sources.map((s) => s.name)).toEqual(["mine", "ours", "org-skill"]);
  });

  it("lets a user's own skill shadow an org skill of the same name", async () => {
    await createSkill(db, owner("u1"), { name: "deploy", description: "Personal.", content: "# Personal\n" });
    await insertOrgSkill(db, "deploy", "# Org\n");

    const sources = await listSkillSourcesFor(db, { type: "user", id: "u1" }, ORG);
    expect(sources).toHaveLength(1);
    // First-name-wins with user before org — the personal copy survives.
    expect(sources[0]?.content).toBe("# Personal\n");
  });

  it("returns only the org's own skills for an org principal", async () => {
    await createSkill(db, owner("u1"), { name: "mine", description: "Personal.", content: BODY });
    await insertOrgSkill(db, "org-skill", "# Org\n");

    const sources = await listSkillSourcesFor(db, { type: "org", id: ORG }, ORG);
    expect(sources.map((s) => s.name)).toEqual(["org-skill"]);
  });

  it("returns nothing for a principal with no skills", async () => {
    expect(await listSkillSourcesFor(db, { type: "user", id: "u2" }, ORG)).toEqual([]);
  });
});

describe("rowToSkillSource", () => {
  function skillRow(frontmatter: Record<string, unknown>): SkillRow {
    const now = Date.now();
    return {
      id: "skill_x",
      orgId: ORG,
      ownerType: "user",
      ownerId: "u1",
      origin: "local",
      sourceId: null,
      name: "standup",
      description: "Daily standup",
      content: "Summarize $1",
      frontmatter: { name: "standup", description: "Daily standup", ...frontmatter },
      contentSha: "sha",
      upstreamPath: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("maps invocation and argHint out of frontmatter", () => {
    const src = rowToSkillSource(skillRow({ invocation: "prompt", argHint: "<topic>" }));
    expect(src).toMatchObject({
      name: "standup",
      source: "user",
      invocation: "prompt",
      argHint: "<topic>",
    });
  });

  it("omits invocation/argHint when absent or the wrong type", () => {
    const src = rowToSkillSource(skillRow({ invocation: 42, argHint: { nope: true } }));
    expect(src.invocation).toBeUndefined();
    expect(src.argHint).toBeUndefined();
  });

  it("maps a repo-origin row to source 'repo'", () => {
    const row = { ...skillRow({ invocation: "context" }), origin: "repo" as const };
    const src = rowToSkillSource(row);
    expect(src.source).toBe("repo");
    expect(src.invocation).toBe("context");
  });
});
