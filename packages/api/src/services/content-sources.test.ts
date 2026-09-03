/**
 * Tracked repositories — the `skill_sources` rows a person adds, and
 * the repo-spec parsing that turns what they paste into one row.
 *
 * Ownership mirrors `services/skills.ts` exactly (your own rows plus the rows
 * of every team you belong to, a cross-owner read reported as not found), so
 * this suite asserts the same properties that suite does, on sources.
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import {
  orgMembers,
  orgs,
  skills,
  users,
  workflowDefinitions,
  workflowSchedules,
  workflowVersions,
} from "../schema/index.js";
import { addMember, createTeam, deleteTeam } from "./teams.js";
import { createSkill, type SkillOwner } from "./skills.js";
import {
  createContentSource,
  parseContentKinds,
  decodeContentSourceCursor,
  deleteContentSource,
  listContentSources,
  ownedContentSourceRow,
  parseRepoInput,
  readableContentSourceRow,
  CONTENT_SOURCE_DEFAULT_LIMIT,
  ContentSourceConflictError,
  ContentSourceInputError,
} from "./content-sources.js";

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
    expect(() => parseRepoInput("https://gitlab.com/tkhq/skills")).toThrow(ContentSourceInputError);
  });

  it("rejects text that is not a repository", () => {
    expect(() => parseRepoInput("")).toThrow(ContentSourceInputError);
    expect(() => parseRepoInput("skills")).toThrow(ContentSourceInputError);
    expect(() => parseRepoInput("tkhq/skills/extra")).toThrow(ContentSourceInputError);
  });

  it("rejects a subdirectory that climbs out of the repository", () => {
    expect(() => parseRepoInput("tkhq/skills", { subpath: "../etc" })).toThrow(
      ContentSourceInputError,
    );
  });
});

describe("content sources service", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1");
    await seedUser(db, "u2");
  });

  /** The repositories one caller reaches on the first page, which every case
   * below stays well inside. */
  async function repos(userId: string): Promise<string[]> {
    const page = await listContentSources(db, owner(userId), undefined, CONTENT_SOURCE_DEFAULT_LIMIT, undefined);
    return page.rows.map((r) => r.repoFullName);
  }

  it("creates a source for the caller and schedules its first sync now", async () => {
    const created = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

    expect(created.id).toMatch(/^skillsrc_/);
    expect(created.repoFullName).toBe("tkhq/skills");
    expect(created.ownerType).toBe("user");
    expect(created.ownerId).toBe("u1");
    expect(created.enabled).toBe(true);
    expect(created.status).toBe("pending");
    expect(created.lastSha).toBeNull();
    expect(created.nextAttemptAt).toBeLessThanOrEqual(Date.now());
    // Skills only until a caller asks for more, so a source added today
    // mirrors exactly what a source added before `kinds` existed mirrors.
    expect(created.kinds).toEqual(["skills"]);
  });

  it("hides another user's source behind the null a missing id returns", async () => {
    const mine = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

    expect(await ownedContentSourceRow(db, owner("u2"), mine.id)).toBeNull();
    expect(await ownedContentSourceRow(db, owner("u2"), "skillsrc_missing")).toBeNull();
    expect(await readableContentSourceRow(db, owner("u2"), mine.id)).toBeNull();
  });

  it("lets a member read an org source they cannot write", async () => {
    const orgSource = await createContentSource(db, owner("u1"), {
      repo: "tkhq/theirs",
      ownerType: "org",
      isOrgAdmin: true,
    });

    expect(await ownedContentSourceRow(db, owner("u2"), orgSource.id)).toBeNull();
    expect(await ownedContentSourceRow(db, owner("u2"), orgSource.id, { isOrgAdmin: true })).not.toBeNull();
    expect(await readableContentSourceRow(db, owner("u2"), orgSource.id)).not.toBeNull();
  });

  it("rejects the same repository and subdirectory twice in one owner scope", async () => {
    await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

    await expect(createContentSource(db, owner("u1"), { repo: "tkhq/skills" })).rejects.toThrow(
      ContentSourceConflictError,
    );
    // A different subdirectory of the same repository is a different source.
    await createContentSource(db, owner("u1"), { repo: "tkhq/skills", subpath: "agent" });
  });

  it("records who added the source, whatever the source belongs to", async () => {
    // The sweep has no request context, so `created_by` is the only user
    // identity a team source carries. Without it the sync cannot pick a
    // credential, and the whole source falls back to an anonymous read —
    // see `services/content-source-credential.ts`.
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });

    const personal = await createContentSource(db, owner("u1"), { repo: "tkhq/mine" });
    const teamSource = await createContentSource(db, owner("u1"), {
      repo: "tkhq/ours",
      teamId: team.id,
    });
    const orgSource = await createContentSource(db, owner("u1"), {
      repo: "tkhq/theirs",
      ownerType: "org",
      isOrgAdmin: true,
    });

    expect(personal.createdBy).toBe("u1");
    expect(teamSource.createdBy).toBe("u1");
    expect(orgSource.createdBy).toBe("u1");
    // Persisted, not only present on the returned object: the sweep re-reads
    // the row and never sees what `createContentSource` returned.
    const stored = await ownedContentSourceRow(db, owner("u1"), teamSource.id);
    expect(stored?.createdBy).toBe("u1");
  });

  it("drops org rows when includeOrg is false", async () => {
    await createContentSource(db, owner("u1"), { repo: "tkhq/mine" });
    await createContentSource(db, owner("u1"), {
      repo: "tkhq/theirs",
      ownerType: "org",
      isOrgAdmin: true,
    });

    const whole = await listContentSources(db, owner("u1"), undefined, CONTENT_SOURCE_DEFAULT_LIMIT, undefined);
    expect(whole.rows.map((r) => r.repoFullName).sort()).toEqual(["tkhq/mine", "tkhq/theirs"]);

    const withoutOrg = await listContentSources(
      db,
      owner("u1"),
      undefined,
      CONTENT_SOURCE_DEFAULT_LIMIT,
      undefined,
      { includeOrg: false },
    );
    expect(withoutOrg.rows.map((r) => r.repoFullName)).toEqual(["tkhq/mine"]);
  });

  it("lists the caller's own sources and every team source they can reach", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createContentSource(db, owner("u1"), { repo: "tkhq/mine" });
    await createContentSource(db, owner("u1"), { repo: "tkhq/ours", teamId: team.id });

    expect(await repos("u1")).toEqual(["tkhq/mine", "tkhq/ours"]);
    expect(await repos("u2")).toEqual([]);

    await addMember(db, { teamId: team.id, userId: "u2", role: "member" });
    expect(await repos("u2")).toEqual(["tkhq/ours"]);
  });

  it("pages by repository name, and stops issuing a cursor at the last page", async () => {
    for (const repo of ["tkhq/a", "tkhq/b", "tkhq/c"]) {
      await createContentSource(db, owner("u1"), { repo });
    }

    const first = await listContentSources(db, owner("u1"), undefined, 2, undefined);
    expect(first.rows.map((r) => r.repoFullName)).toEqual(["tkhq/a", "tkhq/b"]);
    expect(first.nextCursor).toBeDefined();

    const second = await listContentSources(
      db,
      owner("u1"),
      undefined,
      2,
      decodeContentSourceCursor(first.nextCursor ?? ""),
    );
    expect(second.rows.map((r) => r.repoFullName)).toEqual(["tkhq/c"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("walks past two owners tracking the same repository", async () => {
    // `(repo, subpath)` repeats across owners — the unique index allows it —
    // so a cursor without the row id would loop on the first of the pair.
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createContentSource(db, owner("u1"), { repo: "tkhq/same" });
    await createContentSource(db, owner("u1"), { repo: "tkhq/same", teamId: team.id });

    const first = await listContentSources(db, owner("u1"), undefined, 1, undefined);
    expect(first.nextCursor).toBeDefined();
    const second = await listContentSources(
      db,
      owner("u1"),
      undefined,
      1,
      decodeContentSourceCursor(first.nextCursor ?? ""),
    );

    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.id).not.toBe(first.rows[0]?.id);
    expect(second.nextCursor).toBeUndefined();
  });

  it("refuses a cursor it did not issue", () => {
    expect(decodeContentSourceCursor("not-a-cursor")).toBeUndefined();
    // Well-formed base64url JSON, but not this listing's sort key.
    expect(decodeContentSourceCursor(Buffer.from('{"s":1}').toString("base64url"))).toBeUndefined();
  });

  it("reports a team the caller does not belong to as not found", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });

    await expect(
      createContentSource(db, owner("u2"), { repo: "tkhq/skills", teamId: team.id }),
    ).rejects.toThrow(/team/);
  });

  it("deletes a source together with the skills it mirrors, and nothing else", async () => {
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
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

    expect(await deleteContentSource(db, owner("u1"), source.id)).toBe(true);

    const left = await db.select().from(skills);
    expect(left.map((r) => r.name)).toEqual(["written-here"]);
    expect(await ownedContentSourceRow(db, owner("u1"), source.id)).toBeNull();
  });

  // Decision 10: push access to a tracked repository becomes authority to run
  // tool nodes as the owner, so the control is who may add the source.
  describe("what a source is allowed to collect", () => {
    it("defaults to skills, and stores one canonical order", async () => {
      const plain = await createContentSource(db, owner("u1"), { repo: "tkhq/a" });
      expect(plain.kinds).toEqual(["skills"]);

      const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
      const both = await createContentSource(db, owner("u1"), {
        repo: "tkhq/b",
        teamId: team.id,
        kinds: parseContentKinds(["workflows", "skills"]),
      });
      expect(both.kinds).toEqual(["skills", "workflows"]);
    });

    it("refuses a team source collecting workflows for a plain member, naming the fix", async () => {
      const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
      await addMember(db, { teamId: team.id, userId: "u2", role: "member" });

      await expect(
        createContentSource(db, owner("u2"), {
          repo: "tkhq/c",
          teamId: team.id,
          kinds: ["skills", "workflows"],
        }),
      ).rejects.toThrow(/team admin/);

      // The same member may still add a skills-only team source.
      const ok = await createContentSource(db, owner("u2"), { repo: "tkhq/d", teamId: team.id });
      expect(ok.kinds).toEqual(["skills"]);
    });

    it("lets a team admin add one", async () => {
      const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
      await addMember(db, { teamId: team.id, userId: "u2", role: "admin" });

      const row = await createContentSource(db, owner("u2"), {
        repo: "tkhq/e",
        teamId: team.id,
        kinds: ["workflows"],
      });
      expect(row.kinds).toEqual(["workflows"]);
    });

    it("refuses a personal source collecting workflows", async () => {
      await expect(
        createContentSource(db, owner("u1"), { repo: "tkhq/f", kinds: ["workflows"] }),
      ).rejects.toThrow(/team source or an org source/);
    });

    it("reads an unchecked body, naming the choices", () => {
      expect(parseContentKinds(undefined)).toEqual(["skills"]);
      expect(() => parseContentKinds([])).toThrow(/Choose what to collect/);
      expect(() => parseContentKinds(["skils"])).toThrow(/does not collect/);
      expect(() => parseContentKinds("skills")).toThrow(/Choose what to collect/);
    });
  });

  // A mirrored workflow is read-only in the product, so an orphan left behind
  // here could never be removed through any route: the guard in
  // `workflows/service.ts` refuses the delete, and the source that would have
  // removed it is gone.
  it("deletes the workflows a source mirrors, and their versions and triggers", async () => {
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/automation" });
    const now = Date.now();
    await db.insert(workflowDefinitions).values([
      {
        id: "wf_mirrored",
        orgId: ORG,
        ownerType: "user",
        ownerId: "u1",
        name: "Nightly",
        definition: { version: "dag/v1", nodes: [], edges: [] },
        origin: "repo",
        sourceId: source.id,
        upstreamPath: ".valet/workflows/nightly.yaml",
        contentSha: "blob-1",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "wf_local",
        orgId: ORG,
        ownerType: "user",
        ownerId: "u1",
        name: "Written here",
        definition: { version: "dag/v1", nodes: [], edges: [] },
        origin: "local",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(workflowVersions).values({
      id: "wfv_1",
      workflowId: "wf_mirrored",
      version: 1,
      name: "Nightly",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      origin: "repo",
      sourceCommit: "c1",
      createdAt: now,
    });
    await db.insert(workflowSchedules).values({
      id: "sched_1",
      orgId: ORG,
      ownerType: "user",
      ownerId: "u1",
      targetKind: "workflow",
      workflowId: "wf_mirrored",
      name: "nightly",
      cron: "0 3 * * *",
      nextFireAt: now + 1000,
      createdBy: "u1",
      createdAt: now,
      updatedAt: now,
    });

    expect(await deleteContentSource(db, owner("u1"), source.id)).toBe(true);

    const left = await db.select().from(workflowDefinitions);
    expect(left.map((r) => r.id)).toEqual(["wf_local"]);
    expect(await db.select().from(workflowVersions)).toHaveLength(0);
    // A schedule left behind keeps firing against a workflow that is gone.
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("refuses to delete another owner's source", async () => {
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

    expect(await deleteContentSource(db, owner("u2"), source.id)).toBe(false);
    expect(await ownedContentSourceRow(db, owner("u1"), source.id)).not.toBeNull();
  });

  it("removes a deleted team's sources with the team", async () => {
    const team = await createTeam(db, { orgId: ORG, name: "Platform", creatorUserId: "u1" });
    await createContentSource(db, owner("u1"), { repo: "tkhq/ours", teamId: team.id });

    await deleteTeam(db, { teamId: team.id });

    expect(await repos("u1")).toEqual([]);
  });
});
