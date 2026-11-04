import { beforeEach, describe, expect, it } from "vitest";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { writeFile } from "../services/memory.js";
import { addMember, createTeam } from "../services/teams.js";
import { buildPluginMemory } from "./plugin-memory.js";

async function seedUser(db: AppDb, id: string, orgId: string) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId, userId: id, role: "member" });
}

describe("buildPluginMemory", () => {
  const orgId = "org-pm";
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1", orgId);
  });

  it("reads and searches the team's shared memory, not a member's execution memory", async () => {
    const team = await createTeam(db, { orgId, name: "Reviewers", creatorUserId: "u1" });
    await addMember(db, { teamId: team.id, userId: "u1", role: "admin" });
    const owner = { type: "team" as const, id: team.id };
    await writeFile(db, { owner, actorUserId: "u1" }, { path: "conventions/review.md", content: "Flag missing awaits in handlers." });
    await writeFile(db, { owner, actorUserId: "u1", namespace: "execution-x" }, { path: "notes/private.md", content: "Private awaits note" });

    const memory = buildPluginMemory(db, owner, `team:${team.id}`);
    const hits = await memory.search("awaits");
    expect(hits.map((h) => h.path)).toEqual(["conventions/review.md"]);
    expect(hits[0].snippet).toContain("awaits");

    const file = await memory.read("conventions/review.md");
    expect(file?.content).toContain("Flag missing awaits in handlers.");
    expect(await memory.read("conventions/missing.md")).toBeNull();
  });
});
