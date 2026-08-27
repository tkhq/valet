import { describe, expect, it, beforeEach } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { createSkillSource } from "./skill-sources.js";
import type { SkillOwner } from "./skills.js";
import {
  findOrgSkillSourcesForPush,
  parseSkillPushPayload,
  skillSourceRefMatchesPush,
} from "./skill-sync-push.js";

const ORG = "org1";

function owner(userId: string): SkillOwner {
  return { userId, orgId: ORG };
}

function push(over: { repo?: string; ref?: string; defaultBranch?: string } = {}) {
  return {
    repoFullName: over.repo ?? "tkhq/skills",
    gitRef: over.ref ?? "refs/heads/main",
    defaultBranch: over.defaultBranch ?? "main",
  };
}

describe("parseSkillPushPayload", () => {
  it("reads the repository and ref", () => {
    expect(
      parseSkillPushPayload({
        ref: "refs/heads/main",
        repository: { full_name: "tkhq/skills", default_branch: "main" },
      }),
    ).toEqual({
      repoFullName: "tkhq/skills",
      gitRef: "refs/heads/main",
      defaultBranch: "main",
    });
  });

  it("defaults the branch name when GitHub omitted it", () => {
    expect(
      parseSkillPushPayload({
        ref: "refs/heads/main",
        repository: { full_name: "tkhq/skills" },
      })?.defaultBranch,
    ).toBe("main");
  });

  it("returns null when the payload is not a push", () => {
    expect(parseSkillPushPayload({ action: "created" })).toBeNull();
    expect(parseSkillPushPayload({ ref: "refs/heads/main" })).toBeNull();
  });
});

describe("skillSourceRefMatchesPush", () => {
  it("matches an empty source ref to the default branch only", () => {
    expect(skillSourceRefMatchesPush("", push())).toBe(true);
    expect(skillSourceRefMatchesPush("", push({ ref: "refs/heads/dev" }))).toBe(false);
    expect(skillSourceRefMatchesPush("", push({ ref: "refs/tags/v1" }))).toBe(false);
  });

  it("matches a named branch or tag, short or fully qualified", () => {
    expect(skillSourceRefMatchesPush("dev", push({ ref: "refs/heads/dev" }))).toBe(true);
    expect(skillSourceRefMatchesPush("refs/heads/dev", push({ ref: "refs/heads/dev" }))).toBe(true);
    expect(skillSourceRefMatchesPush("v1", push({ ref: "refs/tags/v1" }))).toBe(true);
    expect(skillSourceRefMatchesPush("main", push({ ref: "refs/heads/dev" }))).toBe(false);
  });
});

describe("findOrgSkillSourcesForPush", () => {
  let db: AppDb;

  beforeEach(async () => {
    const handle = await freshTestPgDb();
    db = handle.appDb;
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await db.insert(users).values({ id: "u1", email: "u1@x.test", name: "u1", role: "admin" });
    await db.insert(orgMembers).values({ orgId: ORG, userId: "u1", role: "admin" });
  });

  it("returns only the enabled org source on that repository and ref", async () => {
    const orgDev = await createSkillSource(db, owner("u1"), {
      repo: "tkhq/skills",
      ref: "dev",
      ownerType: "org",
    });
    await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });
    await createSkillSource(db, owner("u1"), { repo: "tkhq/other", ownerType: "org" });

    expect((await findOrgSkillSourcesForPush(db, ORG, push())).map((row) => row.id)).toEqual([]);
    expect((await findOrgSkillSourcesForPush(db, ORG, push({ ref: "refs/heads/dev" }))).map((row) => row.id)).toEqual([
      orgDev.id,
    ]);
  });
});
