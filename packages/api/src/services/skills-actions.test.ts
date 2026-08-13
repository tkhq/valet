/**
 * Agent-facing skill actions. The suite asserts the properties that make
 * this surface safe to hand to an LLM: every write runs the spec validator,
 * every call is scoped to the principal in `ctx`, and a service error comes
 * back as `success: false` instead of a throw.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { PluginActionContext } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { eq } from "drizzle-orm";
import { orgMembers, orgs, users } from "../schema/index.js";
import { createTeam } from "./teams.js";
import { createSkill, listSkills, ownedSkillRow } from "./skills.js";
import { skillsActionPlugin } from "./skills-actions.js";

const ORG = "org1";
const BODY = "# Deploy\n\nRun `make deploy`.\n";

/**
 * A partial `PluginActionContext`. The actions read `userId`/`orgId` and
 * nothing else, and a full `ToolContext` needs a live sandbox and credential
 * provider — the same shortcut `workflows/actions.test.ts` takes.
 */
function ctx(overrides?: { userId?: string; orgId?: string }): PluginActionContext {
  return {
    userId: "u1",
    orgId: ORG,
    actionId: "skills.list_skills",
    service: "skills",
    ...overrides,
  } as PluginActionContext;
}

async function seedUser(db: AppDb, id: string) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId: ORG, userId: id, role: "member" });
}

describe("skillsActionPlugin", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1");
    await seedUser(db, "u2");
  });

  function actionById(id: string) {
    const plugin = skillsActionPlugin(db);
    const found = plugin.actions.find((a) => a.id === id);
    if (!found) throw new Error(`action missing: ${id}`);
    return found;
  }

  it("exposes exactly the four skill actions under the skills service", () => {
    const plugin = skillsActionPlugin(db);
    expect(plugin.service).toBe("skills");
    expect(plugin.actions.map((a) => a.id).sort()).toEqual([
      "skills.create_skill",
      "skills.delete_skill",
      "skills.list_skills",
      "skills.update_skill",
    ]);
  });

  it("gates every write behind a human and leaves the listing open", () => {
    const plugin = skillsActionPlugin(db);
    const byId = new Map(plugin.actions.map((a) => [a.id, a.riskLevel]));
    // Low → auto-allowed. Reading the catalog changes nothing.
    expect(byId.get("skills.list_skills")).toBe("low");
    // High → the catalog's default policy asks a human first. A stored skill
    // is standing instruction text every later session of this owner can
    // pull in, and medium would let the agent write that with nobody in the
    // loop — the reasoning that keeps workflows.create_webhook at high.
    expect(byId.get("skills.create_skill")).toBe("high");
    expect(byId.get("skills.update_skill")).toBe("high");
    // High → the delete is a hard delete with no restore path.
    expect(byId.get("skills.delete_skill")).toBe("high");
  });

  it("refuses every action when the context carries no principal", async () => {
    const plugin = skillsActionPlugin(db);
    for (const action of plugin.actions) {
      const result = await action.execute({ name: "x", description: "x", content: "x", skill_id: "x" }, ctx({ userId: "" }));
      expect(result.success).toBe(false);
      expect(result.error).toContain("no authenticated principal");
    }
  });

  it("creates a skill the caller can read back", async () => {
    const result = await actionById("skills.create_skill").execute(
      { name: "deploy", description: "How to deploy the service.", content: BODY },
      ctx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { skillId: string; name: string; origin: string };
    expect(data.name).toBe("deploy");
    expect(data.origin).toBe("local");

    const row = await ownedSkillRow(db, { userId: "u1", orgId: ORG }, data.skillId);
    expect(row?.content).toBe(BODY);
  });

  it("rejects a name the skill spec rejects, and stores nothing", async () => {
    const result = await actionById("skills.create_skill").execute(
      { name: "Deploy Service", description: "How to deploy.", content: BODY },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lowercase/i);
    expect(await listSkills(db, { userId: "u1", orgId: ORG })).toEqual([]);
  });

  it("rejects an empty description, which every turn would otherwise carry blank", async () => {
    const result = await actionById("skills.create_skill").execute(
      { name: "deploy", description: "", content: BODY },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(await listSkills(db, { userId: "u1", orgId: ORG })).toEqual([]);
  });

  it("reports a duplicate name with the fix, instead of throwing", async () => {
    await createSkill(db, { userId: "u1", orgId: ORG }, {
      name: "deploy",
      description: "How to deploy.",
      content: BODY,
    });

    const result = await actionById("skills.create_skill").execute(
      { name: "deploy", description: "Another one.", content: BODY },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("creates for a team the caller belongs to and reports an outside team as not found", async () => {
    const mine = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    const theirs = await createTeam(db, { orgId: ORG, name: "Other", creatorUserId: "u2" });

    const ok = await actionById("skills.create_skill").execute(
      { name: "deploy", description: "How to deploy.", content: BODY, team_id: mine.id },
      ctx(),
    );
    expect(ok.success).toBe(true);
    expect((ok.data as { ownerType: string }).ownerType).toBe("team");

    const denied = await actionById("skills.create_skill").execute(
      { name: "leak", description: "How to leak.", content: BODY, team_id: theirs.id },
      ctx(),
    );
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("not found");
  });

  it("updates a skill it owns and re-runs the validator on the new frontmatter", async () => {
    const created = await createSkill(db, { userId: "u1", orgId: ORG }, {
      name: "deploy",
      description: "How to deploy.",
      content: BODY,
    });

    const ok = await actionById("skills.update_skill").execute(
      { skill_id: created.id, content: "# Deploy\n\nRun `make ship`.\n" },
      ctx(),
    );
    expect(ok.success).toBe(true);
    const row = await ownedSkillRow(db, { userId: "u1", orgId: ORG }, created.id);
    expect(row?.content).toBe("# Deploy\n\nRun `make ship`.\n");
    // The body changed, so the stored digest must move with it.
    expect(row?.contentSha).not.toBe(created.contentSha);

    const bad = await actionById("skills.update_skill").execute(
      { skill_id: created.id, name: "Deploy Service" },
      ctx(),
    );
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/lowercase/i);
  });

  it("reports another owner's skill as not found on update and on delete", async () => {
    const theirs = await createSkill(db, { userId: "u2", orgId: ORG }, {
      name: "deploy",
      description: "How to deploy.",
      content: BODY,
    });

    const update = await actionById("skills.update_skill").execute(
      { skill_id: theirs.id, content: "# Mine now\n" },
      ctx(),
    );
    expect(update.success).toBe(false);
    expect(update.error).toContain("not found");

    const remove = await actionById("skills.delete_skill").execute({ skill_id: theirs.id }, ctx());
    expect(remove.success).toBe(false);
    expect(remove.error).toContain("not found");

    const row = await ownedSkillRow(db, { userId: "u2", orgId: ORG }, theirs.id);
    expect(row?.content).toBe(BODY);
  });

  it("sends a repository skill back to its repository on write", async () => {
    const synced = await createSkill(db, { userId: "u1", orgId: ORG }, {
      name: "deploy",
      description: "How to deploy.",
      content: BODY,
      origin: "repo",
    });

    const update = await actionById("skills.update_skill").execute(
      { skill_id: synced.id, content: "# Local edit\n" },
      ctx(),
    );
    expect(update.success).toBe(false);
    expect(update.error).toContain("repository");

    const remove = await actionById("skills.delete_skill").execute({ skill_id: synced.id }, ctx());
    expect(remove.success).toBe(false);
    expect(remove.error).toContain("repository");
  });

  it("deletes a skill it owns", async () => {
    const created = await createSkill(db, { userId: "u1", orgId: ORG }, {
      name: "deploy",
      description: "How to deploy.",
      content: BODY,
    });

    const result = await actionById("skills.delete_skill").execute({ skill_id: created.id }, ctx());
    expect(result).toEqual({ success: true, data: { skillId: created.id, deleted: true } });
    expect(await ownedSkillRow(db, { userId: "u1", orgId: ORG }, created.id)).toBeNull();
  });

  it("lists the caller's own skills and their teams', never another user's", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createSkill(db, { userId: "u1", orgId: ORG }, {
      name: "mine",
      description: "Personal.",
      content: BODY,
    });
    await createSkill(db, { userId: "u1", orgId: ORG }, {
      name: "ours",
      description: "Team.",
      content: BODY,
      teamId: team.id,
    });
    await createSkill(db, { userId: "u2", orgId: ORG }, {
      name: "theirs",
      description: "Someone else's.",
      content: BODY,
    });

    const result = await actionById("skills.list_skills").execute({}, ctx());
    expect(result.success).toBe(true);
    const { skills } = result.data as {
      skills: Array<{ skillId: string; name: string; ownerType: string }>;
    };
    expect(skills.map((s) => s.name)).toEqual(["mine", "ours"]);
    // The listing is a catalog, not a read: bodies stay out of the turn.
    expect(skills.every((s) => !("content" in s))).toBe(true);
  });

  it("create_skill accepts invocation and argHint and list echoes them", async () => {
    const created = await actionById("skills.create_skill").execute(
      {
        name: "standup",
        description: "Summarize the standup.",
        content: "Summarize $1",
        invocation: "prompt",
        argHint: "<topic>",
      },
      ctx(),
    );
    expect(created.success).toBe(true);

    const listed = await actionById("skills.list_skills").execute({}, ctx());
    expect(listed.success).toBe(true);
    const { skills } = listed.data as {
      skills: Array<{ name: string; invocation?: string; argHint?: string }>;
    };
    const row = skills.find((s) => s.name === "standup");
    expect(row).toMatchObject({ invocation: "prompt", argHint: "<topic>" });
  });

  it("refuses an org create for a non-admin and names the fix", async () => {
    const result = await actionById("skills.create_skill").execute(
      { name: "orgwide", description: "Org policy.", content: BODY, owner_type: "org" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("org admin");
    expect(await listSkills(db, { userId: "u1", orgId: ORG })).toEqual([]);
  });

  it("creates an org skill when the caller is an org admin", async () => {
    await db.update(orgMembers).set({ role: "admin" }).where(eq(orgMembers.userId, "u1"));
    const result = await actionById("skills.create_skill").execute(
      { name: "orgwide", description: "Org policy.", content: BODY, owner_type: "org" },
      ctx(),
    );
    expect(result.success).toBe(true);
    expect((result.data as { ownerType: string }).ownerType).toBe("org");
  });
});
