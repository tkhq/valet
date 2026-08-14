/**
 * `syncOnce` — the one entry point that mirrors a public repository's skills
 * into the `skills` table.
 *
 * Every case runs the real `PublicSkillRepoReader` against the shared GitHub
 * fixture, so "how many API calls did that poll cost" is a property this
 * suite can assert directly. That number is the design: a poll that finds an
 * unmoved head commit must cost exactly one call.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { orgMembers, orgs, skills, skillSources, users } from "../schema/index.js";
import { createSkill, type SkillOwner } from "./skills.js";
import { createSkillSource } from "./skill-sources.js";
import { PublicSkillRepoReader } from "./skill-repo-reader.js";
import { claimDueSkillSources, SkillSyncService, SYNC_INTERVAL_MS } from "./skill-sync.js";

const ORG = "org1";

function owner(userId: string): SkillOwner {
  return { userId, orgId: ORG };
}

function skillMd(name: string, description: string, body = "Do the thing."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

/** Directory name to its `SKILL.md`. `null` means a directory with no
 * `SKILL.md` in it — a directory that is not a skill. */
type RepoSkills = Record<string, string | null>;
/** Prompt file name (without .md) to its Markdown content. */
type RepoPrompts = Record<string, string>;

interface FakeRepo {
  sha: string;
  skills: RepoSkills;
  /** Prompt files in `<root>/prompts/`, keyed by filename without `.md`. */
  prompts?: RepoPrompts;
  /** Files beside the skill directories, e.g. `README.md`. */
  files?: string[];
  /** Directory the skill directories sit in. Empty means the root. */
  root?: string;
}

let fixture: GithubFixture | undefined;

/** Serves `repo` over the GitHub fixture. Mutate `repo` between syncs to
 * move the repository forward. */
function serve(repo: FakeRepo): GithubFixture {
  fixture = startGithubFixture({
    getCommit: () => ({ body: { sha: repo.sha } }),
    getContents: (_owner, _name, path) => {
      const root = repo.root ?? "";
      const prefix = root.length > 0 ? `${root}/` : "";
      // Root listing: skill directories + loose files.
      if (path === root) {
        return {
          body: [
            ...Object.keys(repo.skills).map((name) => entry(name, "dir")),
            ...(repo.files ?? []).map((name) => entry(name, "file")),
          ],
        };
      }
      // prompts/ directory listing.
      const promptsDir = root.length > 0 ? `${root}/prompts` : "prompts";
      if (path === promptsDir) {
        const prompts = repo.prompts ?? {};
        return {
          body: Object.keys(prompts).map((name) => entry(`${name}.md`, "file")),
        };
      }
      // Individual prompt file read.
      const promptFileMatch = new RegExp(`^${escapeRegex(promptsDir)}/([^/]+)\\.md$`).exec(path);
      if (promptFileMatch) {
        const name = promptFileMatch[1];
        const content = name !== undefined ? (repo.prompts ?? {})[name] : undefined;
        if (typeof content !== "string") return { status: 404, body: { message: "Not Found" } };
        return {
          body: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(content, "utf8").toString("base64"),
            sha: `blob-prompt-${name}`,
          },
        };
      }
      // SKILL.md read for a skill directory.
      const match = /^(.*)\/SKILL\.md$/.exec(path);
      const dir = match?.[1]?.slice(prefix.length);
      const content = dir === undefined ? undefined : repo.skills[dir];
      if (typeof content !== "string") return { status: 404, body: { message: "Not Found" } };
      return {
        body: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(content, "utf8").toString("base64"),
          sha: `blob-${dir}`,
        },
      };
    },
  });
  return fixture;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function entry(name: string, type: "file" | "dir") {
  return { name, path: name, type, size: 0, sha: `sha-${name}` };
}

describe("skill sync", () => {
  let db: AppDb;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    for (const id of ["u1", "u2"]) {
      await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
      await db.insert(orgMembers).values({ orgId: ORG, userId: id, role: "member" });
    }
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  function serviceFor(f: GithubFixture): SkillSyncService {
    return new SkillSyncService({ db, reader: new PublicSkillRepoReader({ apiUrl: f.url }) });
  }

  it("imports every skill directory on the first sync", async () => {
    const f = serve({
      sha: "commit-1",
      skills: {
        deploy: skillMd("deploy", "How to deploy the service."),
        "on-call": skillMd("on-call", "How to answer a page."),
      },
      files: ["README.md"],
    });
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.status).toBe("ok");
    expect(outcome?.imported).toBe(2);
    expect(outcome?.headSha).toBe("commit-1");

    const rows = await db.select().from(skills).orderBy(skills.name);
    expect(rows.map((r) => r.name)).toEqual(["deploy", "on-call"]);
    expect(rows[0]?.origin).toBe("repo");
    expect(rows[0]?.sourceId).toBe(source.id);
    expect(rows[0]?.upstreamPath).toBe("deploy/SKILL.md");
    expect(rows[0]?.ownerType).toBe("user");
    expect(rows[0]?.ownerId).toBe("u1");
    expect(rows[0]?.description).toBe("How to deploy the service.");
    expect(rows[0]?.content).toBe("Do the thing.\n");

    const [after] = await db.select().from(skillSources).where(eq(skillSources.id, source.id));
    expect(after?.status).toBe("ok");
    expect(after?.lastSha).toBe("commit-1");
    expect(after?.lastManifestHash).not.toBeNull();
    expect(after?.lastSyncedAt).not.toBeNull();
    expect(after?.attempts).toBe(0);
    expect(after?.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it("reads only the skill directories under the configured subdirectory", async () => {
    const f = serve({
      sha: "commit-1",
      root: "agent/skills",
      skills: { deploy: skillMd("deploy", "How to deploy the service.") },
    });
    const source = await createSkillSource(db, owner("u1"), {
      repo: "tkhq/skills",
      subpath: "agent/skills",
    });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.imported).toBe(1);
    const [row] = await db.select().from(skills);
    expect(row?.upstreamPath).toBe("agent/skills/deploy/SKILL.md");
  });

  it("imports the whole description when upstream writes it as a block scalar", async () => {
    // The frontmatter of `skills/claude-api/SKILL.md` in anthropics/skills.
    const claudeApi = `---
name: claude-api
description: |-
  Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use...
  TRIGGER — read BEFORE opening the target file; ...
  SKIP only when another provider is being worked on ...
license: Complete terms in LICENSE.txt
---

Read the reference.
`;
    const f = serve({ sha: "commit-1", skills: { "claude-api": claudeApi } });
    const source = await createSkillSource(db, owner("u1"), { repo: "anthropics/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.warnings).toEqual([]);
    expect(outcome?.imported).toBe(1);
    const [row] = await db.select().from(skills);
    expect(row?.description).toBe(
      "Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use...\n" +
        "TRIGGER — read BEFORE opening the target file; ...\n" +
        "SKIP only when another provider is being worked on ...",
    );
    expect(row?.content).toBe("Read the reference.\n");
  });

  it("costs exactly one call when the head commit has not moved", async () => {
    const repo: FakeRepo = { sha: "commit-1", skills: { deploy: skillMd("deploy", "Deploy it.") } };
    const f = serve(repo);
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });
    const service = serviceFor(f);
    await service.syncOnce(source.id);

    f.calls.length = 0;
    const outcome = await service.syncOnce(source.id);

    expect(outcome?.status).toBe("ok");
    expect(outcome?.changed).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.path).toBe("/repos/tkhq/skills/commits/HEAD");
  });

  it("records a moved commit that carries the same skills, and writes no skill rows", async () => {
    const repo: FakeRepo = { sha: "commit-1", skills: { deploy: skillMd("deploy", "Deploy it.") } };
    const f = serve(repo);
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });
    const service = serviceFor(f);
    await service.syncOnce(source.id);
    const [before] = await db.select().from(skills);

    // The commit moves, but nothing under the skills directory changed.
    repo.sha = "commit-2";
    const outcome = await service.syncOnce(source.id);

    expect(outcome?.changed).toBe(false);
    expect(outcome).toMatchObject({ imported: 0, updated: 0, deleted: 0 });
    const [after] = await db.select().from(skills);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    const [row] = await db.select().from(skillSources).where(eq(skillSources.id, source.id));
    expect(row?.lastSha).toBe("commit-2");
  });

  it("rewrites a skill whose body changed upstream", async () => {
    const repo: FakeRepo = {
      sha: "commit-1",
      skills: { deploy: skillMd("deploy", "Deploy it.", "Run make deploy.") },
    };
    const f = serve(repo);
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });
    const service = serviceFor(f);
    await service.syncOnce(source.id);

    repo.sha = "commit-2";
    repo.skills.deploy = skillMd("deploy", "Deploy it twice.", "Run make deploy, then check.");
    const outcome = await service.syncOnce(source.id);

    expect(outcome?.updated).toBe(1);
    expect(outcome?.imported).toBe(0);
    const [row] = await db.select().from(skills);
    expect(row?.content).toBe("Run make deploy, then check.\n");
    expect(row?.description).toBe("Deploy it twice.");
  });

  it("deletes only this source's repo skills when a directory disappears upstream", async () => {
    const repo: FakeRepo = {
      sha: "commit-1",
      skills: { deploy: skillMd("deploy", "Deploy it."), "on-call": skillMd("on-call", "Answer.") },
    };
    const f = serve(repo);
    const mine = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });
    // A SECOND source in the SAME owner scope: only `source_id` separates
    // its rows from the ones being reconciled.
    const sibling = await createSkillSource(db, owner("u1"), { repo: "tkhq/other" });
    await createSkill(db, owner("u1"), {
      name: "escalate",
      description: "The sibling source's mirror.",
      content: "# Escalate\n",
      origin: "repo",
      sourceId: sibling.id,
    });
    // A skill written in the product, in the same owner scope, never
    // upstream anywhere: `origin='local'` is all that protects it.
    await createSkill(db, owner("u1"), {
      name: "runbook",
      description: "Written here.",
      content: "# Local\n",
    });
    // Another owner's mirror of the name that is about to disappear.
    const theirs = await createSkillSource(db, owner("u2"), { repo: "tkhq/skills" });
    await createSkill(db, owner("u2"), {
      name: "on-call",
      description: "Their mirror.",
      content: "# Theirs\n",
      origin: "repo",
      sourceId: theirs.id,
    });
    const service = serviceFor(f);
    await service.syncOnce(mine.id);

    repo.sha = "commit-2";
    delete repo.skills["on-call"];
    const outcome = await service.syncOnce(mine.id);

    expect(outcome?.deleted).toBe(1);
    const mineRows = await db.select().from(skills).where(eq(skills.sourceId, mine.id));
    expect(mineRows.map((r) => r.name)).toEqual(["deploy"]);
    // The locally written skill survives, body untouched.
    const [local] = await db
      .select()
      .from(skills)
      .where(and(eq(skills.ownerId, "u1"), eq(skills.origin, "local")));
    expect(local?.name).toBe("runbook");
    expect(local?.content).toBe("# Local\n");
    // The sibling source's row and the other owner's row both survive.
    const siblingRows = await db.select().from(skills).where(eq(skills.sourceId, sibling.id));
    expect(siblingRows.map((r) => r.name)).toEqual(["escalate"]);
    const theirRows = await db.select().from(skills).where(eq(skills.ownerId, "u2"));
    expect(theirRows.map((r) => r.name)).toEqual(["on-call"]);
  });

  it("warns about a malformed SKILL.md and still records the commit", async () => {
    const repo: FakeRepo = {
      sha: "commit-1",
      skills: {
        deploy: skillMd("deploy", "Deploy it."),
        broken: "---\nname: Not A Name\n---\n\nBody.\n",
      },
    };
    const f = serve(repo);
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });
    const service = serviceFor(f);

    const outcome = await service.syncOnce(source.id);

    expect(outcome?.status).toBe("warning");
    expect(outcome?.imported).toBe(1);
    expect(outcome?.warnings.join(" ")).toContain("broken");
    const [row] = await db.select().from(skillSources).where(eq(skillSources.id, source.id));
    expect(row?.status).toBe("warning");
    expect(row?.lastSha).toBe("commit-1");
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toContain("broken");

    // A file that will never parse must not be re-read on every poll: the
    // commit was recorded, so the next poll stops after one call.
    f.calls.length = 0;
    await service.syncOnce(source.id);
    expect(f.calls).toHaveLength(1);
  });

  // `anthropics/skills` — the repository the spec points at — ships a skill
  // whose description runs past the spec's own 1024-character limit. Nobody
  // here can edit that repository, so refusing the skill would leave the
  // reference corpus half-importable. Mirror it, and say so.
  it("mirrors a skill whose description is over-long, and warns", async () => {
    const long = `Use this when ${"x".repeat(1100)}`;
    const f = serve({
      sha: "commit-1",
      skills: { deploy: skillMd("deploy", "Deploy it."), verbose: skillMd("verbose", long) },
    });
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.imported).toBe(2);
    expect(outcome?.warnings.join(" ")).toContain("1024");
    const rows = await db.select().from(skills).where(eq(skills.sourceId, source.id));
    const stored = rows.find((r) => r.name === "verbose");
    expect(stored?.description).toBe(long);
  });

  // The other half of the split: an over-long description is survivable, a
  // description the reader never recovered is not. This one must still skip.
  it("refuses a skill whose description is only a block-scalar header", async () => {
    const f = serve({
      sha: "commit-1",
      skills: {
        deploy: skillMd("deploy", "Deploy it."),
        lost: "---\nname: lost\ndescription: |-\nNot indented under the header.\n---\n\nBody.\n",
      },
    });
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.imported).toBe(1);
    expect(outcome?.warnings.join(" ")).toContain("lost");
    const rows = await db.select().from(skills).where(eq(skills.sourceId, source.id));
    expect(rows.map((r) => r.name)).toEqual(["deploy"]);
  });

  it("skips a directory that holds no SKILL.md without warning", async () => {
    const f = serve({
      sha: "commit-1",
      skills: { deploy: skillMd("deploy", "Deploy it."), ".github": null },
    });
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.status).toBe("ok");
    expect(outcome?.warnings).toEqual([]);
    expect(outcome?.imported).toBe(1);
  });

  it("warns instead of overwriting when the caller already holds that name", async () => {
    const f = serve({ sha: "commit-1", skills: { deploy: skillMd("deploy", "From the repo.") } });
    await createSkill(db, owner("u1"), {
      name: "deploy",
      description: "Written here.",
      content: "# Local\n",
    });
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.status).toBe("warning");
    expect(outcome?.imported).toBe(0);
    expect(outcome?.warnings.join(" ")).toContain("deploy");
    const rows = await db.select().from(skills);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe("local");
    expect(rows[0]?.content).toBe("# Local\n");
  });

  it("reports a missing repository with the public-only limit, and backs off", async () => {
    fixture = startGithubFixture({
      getCommit: () => ({ status: 404, body: { message: "Not Found" } }),
    });
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/private" });

    const outcome = await serviceFor(fixture).syncOnce(source.id);

    expect(outcome?.status).toBe("error");
    expect(outcome?.error).toContain("public");
    const [row] = await db.select().from(skillSources).where(eq(skillSources.id, source.id));
    expect(row?.status).toBe("error");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("public");
    expect(row?.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(row?.lastSha).toBeNull();
  });

  it("keeps the mirrored skills when one file read fails mid-sync", async () => {
    const repo: FakeRepo = {
      sha: "commit-1",
      skills: { deploy: skillMd("deploy", "Deploy it."), "on-call": skillMd("on-call", "Answer.") },
    };
    const f = serve(repo);
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });
    const service = serviceFor(f);
    await service.syncOnce(source.id);
    await f.close();

    // A GitHub fault on the second poll must not look like "every skill was
    // deleted upstream".
    fixture = startGithubFixture({
      getCommit: () => ({ body: { sha: "commit-2" } }),
      getContents: (_o, _r, path) =>
        path === ""
          ? { body: [entry("deploy", "dir"), entry("on-call", "dir")] }
          : { status: 500, body: { message: "boom" } },
    });
    const outcome = await serviceFor(fixture).syncOnce(source.id);

    expect(outcome?.status).toBe("error");
    expect(await db.select().from(skills)).toHaveLength(2);
    const [row] = await db.select().from(skillSources).where(eq(skillSources.id, source.id));
    expect(row?.lastSha).toBe("commit-1");
  });

  it("returns null for a source that is gone", async () => {
    fixture = startGithubFixture({});
    expect(await serviceFor(fixture).syncOnce("skillsrc_missing")).toBeNull();
  });

  it("imports prompts/*.md as prompt-invocation skills", async () => {
    const f = serve({
      sha: "commit-1",
      skills: { deploy: skillMd("deploy", "Deploy it.") },
      prompts: { standup: "---\ndescription: Daily standup\n---\nSummarize $1" },
    });
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.status).toBe("ok");
    expect(outcome?.imported).toBe(2);
    const rows = await db.select().from(skills).orderBy(skills.name);
    const prompt = rows.find((r) => r.name === "standup");
    expect(prompt?.frontmatter).toMatchObject({ invocation: "prompt" });
  });

  it("a malformed prompt file warns and does not block the sync", async () => {
    const f = serve({
      sha: "commit-1",
      skills: {},
      prompts: {
        bad: "---\ninvocation: sideways\n---\nx",
        good: "Body $1",
      },
    });
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.status).toBe("warning");
    const rows = await db.select().from(skills);
    expect(rows.some((r) => r.name === "good")).toBe(true);
    expect(rows.some((r) => r.name === "bad")).toBe(false);
  });

  // F1 regression: a skill directory and a same-named prompts/ file must not
  // corrupt each other. The skill row must carry the SKILL.md body; the prompt
  // entry hits the unique-index guard and produces a warning instead of a
  // corrupted row or a unique-violation crash.
  it("a same-named skill directory and prompt file do not corrupt each other", async () => {
    const f = serve({
      sha: "commit-1",
      skills: { standup: skillMd("standup", "Run the standup.", "Ask everyone for updates.") },
      prompts: { standup: "---\ndescription: Prompt version\n---\nSummarize $1" },
    });
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    // Status is warning — the prompt entry collides, and a warning is emitted.
    expect(outcome?.status).toBe("warning");
    // The skill row was imported (the skill directory wins by listing order).
    const rows = await db.select().from(skills).where(eq(skills.sourceId, source.id));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // The row must hold SKILL.md content, not the prompt body.
    expect(row?.content).toBe("Ask everyone for updates.\n");
    expect(row?.description).toBe("Run the standup.");
    // The collision warning names both the prompt path and the collision.
    expect(outcome?.warnings.join(" ")).toMatch(/prompts\/standup\.md/);
    expect(outcome?.warnings.join(" ")).toMatch(/collides/);
  });

  // F3: a prompts/ file named after a reserved builtin is skipped with a
  // per-file warning; the rest of the sync continues.
  it("skips a prompt file whose name is a reserved builtin command", async () => {
    const f = serve({
      sha: "commit-1",
      skills: {},
      prompts: {
        status: "Prompt body for a reserved name",
        summary: "---\ndescription: A safe name\n---\nSummarize $1",
      },
    });
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.status).toBe("warning");
    // The reserved-name file is warned about.
    expect(outcome?.warnings.join(" ")).toContain("status");
    // The good prompt is still imported.
    const rows = await db.select().from(skills);
    expect(rows.some((r) => r.name === "summary")).toBe(true);
    expect(rows.some((r) => r.name === "status")).toBe(false);
  });

  // F4 (skill-sync): a skill directory named after a reserved builtin is
  // skipped with a per-file warning; the rest of the sync continues.
  it("skips a skill directory whose name is a reserved builtin command", async () => {
    const f = serve({
      sha: "commit-1",
      skills: {
        status: skillMd("status", "Shows status."),
        good: skillMd("good", "A safe skill."),
      },
    });
    const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.status).toBe("warning");
    // The reserved-name directory is warned about.
    expect(outcome?.warnings.join(" ")).toContain("status");
    // The good skill is still imported.
    const rows = await db.select().from(skills);
    expect(rows.some((r) => r.name === "good")).toBe(true);
    expect(rows.some((r) => r.name === "status")).toBe(false);
  });

  describe("the sweep", () => {
    it("leases what it claims, so a second claim at the same instant gets nothing", async () => {
      const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });
      const now = source.nextAttemptAt;

      expect(await claimDueSkillSources(db, now)).toEqual([source.id]);
      // The fence: the loser of a race re-checks the due predicate against
      // the winner's committed row, where `next_attempt_at` has moved.
      expect(await claimDueSkillSources(db, now)).toEqual([]);

      const [row] = await db.select().from(skillSources).where(eq(skillSources.id, source.id));
      expect(row?.nextAttemptAt).toBeGreaterThan(now);
    });

    it("leaves a source that is not due yet", async () => {
      const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });
      await db
        .update(skillSources)
        .set({ nextAttemptAt: source.nextAttemptAt + 60_000 })
        .where(eq(skillSources.id, source.id));

      expect(await claimDueSkillSources(db, source.nextAttemptAt)).toEqual([]);
    });

    it("leaves a disabled source", async () => {
      const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });
      await db.update(skillSources).set({ enabled: false }).where(eq(skillSources.id, source.id));

      expect(await claimDueSkillSources(db, source.nextAttemptAt)).toEqual([]);
    });

    it("syncs every source one pass claims", async () => {
      const f = serve({ sha: "commit-1", skills: { deploy: skillMd("deploy", "Deploy it.") } });
      const source = await createSkillSource(db, owner("u1"), { repo: "tkhq/skills" });

      // Read the clock before the sync, not after. The sync schedules from
      // its own `Date.now()`, which is at or after this one, so the bound
      // holds however long the assertions below take to run.
      const beforeSync = Date.now();
      await serviceFor(f).pollOnce();

      expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["deploy"]);
      const [row] = await db.select().from(skillSources).where(eq(skillSources.id, source.id));
      expect(row?.status).toBe("ok");
      // The sync's own schedule replaces the claim lease.
      expect(row?.nextAttemptAt).toBeGreaterThanOrEqual(beforeSync + SYNC_INTERVAL_MS);
    });
  });
});
