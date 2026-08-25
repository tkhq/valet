/**
 * The skills collector, driven through `syncOnce` — the one entry point that
 * mirrors a repository's skills into the `skills` table.
 *
 * Every case runs the real `GitHubSkillRepoReader` against the shared GitHub
 * fixture, so "how many API calls did that poll cost" is a property this
 * suite can assert directly. That number is the design: a poll that finds an
 * unmoved head commit must cost exactly one call.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../../lib/drizzle.js";
import { freshTestPgDb } from "../../test-helpers/pg-test-db.js";
import {
  commitBody,
  contentsBody,
  startGithubFixture,
  treeEntry,
  type GithubFixture,
} from "../../test-helpers/github-fixture.js";
import {
  contentSources,
  orgMembers,
  orgs,
  skills,
  teamMembers,
  teams,
  users,
} from "../../schema/index.js";
import { PgCredentialStore } from "../../plugins/credential-store.js";
import { deriveSecretKey } from "../../lib/secret-crypto.js";
import { createSkill, type SkillOwner } from "../skills.js";
import { createContentSource } from "../content-sources.js";
import { GitHubSkillRepoReader } from "../skill-repo-reader.js";
import { skillRepoReaderFactory } from "../content-source-credential.js";
import { MAX_SKILL_CANDIDATES } from "../skill-discovery.js";
import { claimDueContentSources, ContentSyncService, SYNC_INTERVAL_MS } from "./service.js";

const ORG = "org1";
const TEAM = "team_1";

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
  /** Blobs addressed from the repository ROOT, whatever `root` is: nested
   * skills, junk trees, and second copies of a name. Discovery has to judge
   * these on the path alone, which is what these cases exercise. */
  extra?: Record<string, string>;
  /** Plays a PRIVATE repository: every request without this bearer token
   * gets the same 404 GitHub gives for a repository that is not there. */
  requireToken?: string;
  /** Plays a repository with more files than one tree read returns. */
  truncatedTree?: boolean;
}

let fixture: GithubFixture | undefined;

/** Git addresses a file by the hash of its content, so a body edit moves the
 * blob sha and nothing else does. Sync depends on exactly that: the manifest
 * key is the blob sha, so a commit that touched no skill is free. */
function blobShaOf(content: string): string {
  return `blob-${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12)}`;
}

/** Every file the repository holds, keyed by path from its root. Computed on
 * each request, because a test mutates `repo` between syncs. */
function blobsOf(repo: FakeRepo): Map<string, string> {
  const prefix = repo.root === undefined || repo.root.length === 0 ? "" : `${repo.root}/`;
  const blobs = new Map<string, string>();
  for (const [name, content] of Object.entries(repo.skills)) {
    if (typeof content === "string") blobs.set(`${prefix}${name}/SKILL.md`, content);
  }
  for (const [name, content] of Object.entries(repo.prompts ?? {})) {
    blobs.set(`${prefix}prompts/${name}.md`, content);
  }
  for (const name of repo.files ?? []) blobs.set(`${prefix}${name}`, `# ${name}\n`);
  for (const [path, content] of Object.entries(repo.extra ?? {})) blobs.set(path, content);
  return blobs;
}

/** Serves `repo` over the GitHub fixture. Mutate `repo` between syncs to
 * move the repository forward. */
function serve(repo: FakeRepo): GithubFixture {
  const notFound = { status: 404 as const, body: { message: "Not Found" } };
  // The fixture records a request BEFORE it calls the handler, so the last
  // recorded call is the one being answered. That is the only way a handler
  // can see the header that arrived.
  const denied = (): boolean =>
    repo.requireToken !== undefined &&
    fixture?.calls[fixture.calls.length - 1]?.authHeader !== `Bearer ${repo.requireToken}`;
  fixture = startGithubFixture({
    getCommit: () => (denied() ? notFound : { body: commitBody(repo.sha) }),
    getTree: () => {
      if (denied()) return notFound;
      return {
        body: {
          sha: `tree-${repo.sha}`,
          truncated: repo.truncatedTree === true,
          tree: [...blobsOf(repo)].map(([path, content]) =>
            treeEntry(path, { sha: blobShaOf(content) }),
          ),
        },
      };
    },
    getContents: (_owner, _name, path) => {
      if (denied()) return notFound;
      const blobs = blobsOf(repo);
      const content = blobs.get(path);
      if (typeof content === "string") {
        return {
          body: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(content, "utf8").toString("base64"),
            sha: blobShaOf(content),
          },
        };
      }
      // Directory listings, which only the tree-cut fallback still reads.
      const root = repo.root ?? "";
      if (path === root) {
        return {
          body: [
            ...Object.keys(repo.skills).map((name) => entry(name, "dir")),
            ...(repo.files ?? []).map((name) => entry(name, "file")),
          ],
        };
      }
      const promptsDir = root.length > 0 ? `${root}/prompts` : "prompts";
      if (path === promptsDir && repo.prompts !== undefined) {
        return { body: Object.keys(repo.prompts).map((name) => entry(`${name}.md`, "file")) };
      }
      return notFound;
    },
  });
  return fixture;
}

function entry(name: string, type: "file" | "dir") {
  return { name, path: name, type, size: 0, sha: `sha-${name}` };
}

describe("skill collector", () => {
  let db: AppDb;
  let credentials: PgCredentialStore;

  beforeEach(async () => {
    const { pgdb, appDb } = await freshTestPgDb();
    db = appDb;
    credentials = new PgCredentialStore(pgdb, deriveSecretKey("test-key"));
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    for (const id of ["u1", "u2"]) {
      await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
      await db.insert(orgMembers).values({ orgId: ORG, userId: id, role: "member" });
    }
    // A real team holding both users. A team source's credential now depends
    // on live membership, so the team cases need rows to take away.
    await db.insert(teams).values({ id: TEAM, orgId: ORG, name: "Team", createdAt: Date.now() });
    for (const id of ["u1", "u2"]) {
      await db.insert(teamMembers).values({ teamId: TEAM, userId: id, role: "member" });
    }
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  function serviceFor(f: GithubFixture): ContentSyncService {
    return new ContentSyncService({ db, reader: new GitHubSkillRepoReader({ apiUrl: f.url }) });
  }

  /** The service as `providers/node.ts` builds it: a per-source reader that
   * carries the credential the source's owner holds. */
  function credentialedServiceFor(f: GithubFixture): ContentSyncService {
    const deps = { db, credentials, key: deriveSecretKey("cache-key"), apiUrl: f.url };
    return new ContentSyncService({
      db,
      reader: new GitHubSkillRepoReader({ apiUrl: f.url }),
      readerFor: skillRepoReaderFactory(deps, { apiUrl: f.url }),
    });
  }

  async function connectGitHub(userId: string, token: string, login: string): Promise<void> {
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: token,
      metadata: { login },
    });
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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

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

    const [after] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
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
    const source = await createContentSource(db, owner("u1"), {
      repo: "tkhq/skills",
      subpath: "agent/skills",
    });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.imported).toBe(1);
    const [row] = await db.select().from(skills);
    expect(row?.upstreamPath).toBe("agent/skills/deploy/SKILL.md");
  });

  describe("discovery", () => {
    // The report this whole change exists for. Somebody added a private
    // repository whose skills sit in `04-skills/`, did not type that
    // directory, and got "0 skills" with no error: the old scan listed the
    // ROOT, found directories that hold no `SKILL.md`, and reported success.
    it("finds skills nested at any depth with no subdirectory set", async () => {
      const f = serve({
        sha: "commit-1",
        skills: {},
        extra: {
          "04-skills/deploy/SKILL.md": skillMd("deploy", "Deploy it."),
          "04-skills/on-call/SKILL.md": skillMd("on-call", "Answer a page."),
          ".claude/skills/triage/SKILL.md": skillMd("triage", "Triage a bug."),
          "01-notes/README.md": "# Notes\n",
        },
      });
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/tk-brain" });

      const outcome = await serviceFor(f).syncOnce(source.id);

      expect(outcome?.status).toBe("ok");
      expect(outcome?.imported).toBe(3);
      expect(outcome?.discovery).toBe("tree");
      expect(outcome?.discovered).toBe(3);
      const rows = await db.select().from(skills).orderBy(skills.name);
      expect(rows.map((r) => r.name)).toEqual(["deploy", "on-call", "triage"]);
      // The name is the directory that holds the file, at whatever depth.
      expect(rows[0]?.upstreamPath).toBe("04-skills/deploy/SKILL.md");
      // `.claude/skills/<name>/SKILL.md` is the one dot-directory scanned.
      expect(rows[2]?.upstreamPath).toBe(".claude/skills/triage/SKILL.md");
    });

    it("narrows the scan to the subdirectory when one is set", async () => {
      const f = serve({
        sha: "commit-1",
        skills: {},
        extra: {
          "04-skills/deploy/SKILL.md": skillMd("deploy", "Deploy it."),
          "99-drafts/escalate/SKILL.md": skillMd("escalate", "Escalate it."),
          // The subdirectory matches whole segments, so a directory whose
          // name merely starts with it stays out.
          "04-skills-archive/old/SKILL.md": skillMd("old", "Do not import."),
        },
      });
      const source = await createContentSource(db, owner("u1"), {
        repo: "tkhq/tk-brain",
        subpath: "04-skills",
      });

      const outcome = await serviceFor(f).syncOnce(source.id);

      expect(outcome?.discovered).toBe(1);
      expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["deploy"]);
    });

    it("keeps a junk path out, and does not count it as a skill", async () => {
      const f = serve({
        sha: "commit-1",
        skills: { deploy: skillMd("deploy", "Deploy it.") },
        extra: {
          // Somebody else's package, a build output's copy, and a fixture
          // written to exercise a parser. None is this repository's skill.
          "node_modules/@acme/kit/skills/deploy/SKILL.md": skillMd("deploy", "Not ours."),
          "dist/skills/report/SKILL.md": skillMd("report", "A copy."),
          "src/__tests__/fixtures/broken/SKILL.md": skillMd("broken", "A fixture."),
          ".github/workflows/ci/SKILL.md": skillMd("ci", "Tooling."),
        },
      });
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

      const outcome = await serviceFor(f).syncOnce(source.id);

      expect(outcome?.status).toBe("ok");
      expect(outcome?.discovered).toBe(1);
      expect(outcome?.excluded).toBe(4);
      expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["deploy"]);
    });

    it("keeps a mirrored skill that moves under a directory it does not scan", async () => {
      // The case where the exclusion rule is WRONG. `build` is an excluded
      // ancestor, so a real skill moved under it stops being a candidate —
      // which is indistinguishable from the file being deleted, and would
      // take the skill out of the corpus with no message anywhere. A rule
      // that can over-exclude must not destroy data when it does.
      const repo: FakeRepo = {
        sha: "commit-1",
        skills: {
          deploy: skillMd("deploy", "Deploy it."),
          escalate: skillMd("escalate", "Escalate it."),
        },
      };
      const f = serve(repo);
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
      const service = serviceFor(f);
      await service.syncOnce(source.id);

      repo.sha = "commit-2";
      delete repo.skills.escalate;
      repo.extra = { "build/escalate/SKILL.md": skillMd("escalate", "Escalate it.") };

      const outcome = await service.syncOnce(source.id);

      expect(outcome?.status).toBe("warning");
      expect(outcome?.deleted).toBe(0);
      expect(outcome?.excluded).toBe(1);
      const rows = await db.select().from(skills).orderBy(skills.name);
      expect(rows.map((r) => r.name)).toEqual(["deploy", "escalate"]);
      // The warning names the PATH, because only the reader can say whether
      // that path is a real skill or a vendored copy.
      expect(outcome?.warnings.join("\n")).toContain("build/escalate/SKILL.md");
      const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
      expect(row?.status).toBe("warning");
      expect(row?.lastError).toContain("build/escalate/SKILL.md");
    });

    it("says nothing about an excluded copy of a skill it did import", async () => {
      // The other half of the rule above. A repository that vendors a copy
      // of a skill it also owns is normal — the `.claude` layout does it by
      // design — and the owner's copy imports from its real path. Warning
      // about the excluded one would put a standing false alarm on the row.
      const repo: FakeRepo = {
        sha: "commit-1",
        skills: { configure: skillMd("configure", "Configure it.") },
      };
      const f = serve(repo);
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
      const service = serviceFor(f);
      await service.syncOnce(source.id);

      repo.sha = "commit-2";
      repo.extra = {
        ".claude/plugins/cache/acme/1.0.0/skills/configure/SKILL.md": skillMd(
          "configure",
          "Somebody else's.",
        ),
      };

      const outcome = await service.syncOnce(source.id);

      expect(outcome?.status).toBe("ok");
      expect(outcome?.excluded).toBe(1);
      expect(outcome?.warnings).toEqual([]);
      expect(outcome?.deleted).toBe(0);
      expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["configure"]);
    });

    it("reaches inside an excluded tree when the subdirectory names it", async () => {
      // The escape hatch for over-exclusion: the rules run on the part of
      // the path BELOW the subdirectory, so naming one is deliberate.
      const f = serve({
        sha: "commit-1",
        skills: {},
        extra: { "node_modules/@acme/skills/deploy/SKILL.md": skillMd("deploy", "Deploy it.") },
      });
      const source = await createContentSource(db, owner("u1"), {
        repo: "tkhq/skills",
        subpath: "node_modules/@acme/skills",
      });

      const outcome = await serviceFor(f).syncOnce(source.id);

      expect(outcome?.imported).toBe(1);
      expect(outcome?.excluded).toBe(0);
    });

    it("imports neither of two skills that share a name, and names both paths", async () => {
      // One level under one directory made this impossible. Scanning the
      // whole repository makes it likely, and nothing here can rank the two:
      // taking the first by sorted path would make the skill somebody gets
      // depend on the names of unrelated directories.
      const f = serve({
        sha: "commit-1",
        skills: {},
        extra: {
          "a/review/SKILL.md": skillMd("review", "One review skill."),
          "b/review/SKILL.md": skillMd("review", "Another review skill."),
          "c/deploy/SKILL.md": skillMd("deploy", "Deploy it."),
        },
      });
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

      const outcome = await serviceFor(f).syncOnce(source.id);

      expect(outcome?.status).toBe("warning");
      expect(outcome?.imported).toBe(1);
      const message = outcome?.warnings.join(" ") ?? "";
      expect(message).toContain("a/review/SKILL.md");
      expect(message).toContain("b/review/SKILL.md");
      expect(message).toContain("Two skills cannot share a name");
      // Neither was written, and the unaffected skill still came in.
      expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["deploy"]);
    });

    it("keeps the row of a name that two files start to claim", async () => {
      // `review` is mirrored, then a second `review/SKILL.md` appears. The
      // name is still upstream, so the row must not be deleted on the
      // strength of an ambiguity nobody here can resolve.
      const repo: FakeRepo = {
        sha: "commit-1",
        skills: {},
        extra: { "a/review/SKILL.md": skillMd("review", "One review skill.") },
      };
      const f = serve(repo);
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
      const service = serviceFor(f);
      await service.syncOnce(source.id);
      expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["review"]);

      repo.sha = "commit-2";
      repo.extra = {
        ...repo.extra,
        "b/review/SKILL.md": skillMd("review", "Another review skill."),
      };
      const outcome = await service.syncOnce(source.id);

      expect(outcome?.status).toBe("warning");
      expect(outcome?.deleted).toBe(0);
      const [row] = await db.select().from(skills);
      expect(row?.name).toBe("review");
      expect(row?.upstreamPath).toBe("a/review/SKILL.md");
    });

    it("skips a symlinked SKILL.md, whose blob holds a path and not a skill", async () => {
      const f = serve({ sha: "commit-1", skills: { deploy: skillMd("deploy", "Deploy it.") } });
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
      await serviceFor(f).syncOnce(source.id);
      await f.close();

      fixture = startGithubFixture({
        getCommit: () => ({ body: commitBody("commit-2") }),
        getTree: () => ({
          body: {
            sha: "tree-2",
            truncated: false,
            tree: [
              treeEntry("deploy/SKILL.md", { sha: "blob-deploy" }),
              treeEntry("mirror/SKILL.md", { sha: "blob-link", mode: "120000" }),
            ],
          },
        }),
        getContents: () => ({
          body: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(skillMd("deploy", "Deploy it."), "utf8").toString("base64"),
            sha: "blob-deploy",
          },
        }),
      });
      const outcome = await serviceFor(fixture).syncOnce(source.id);

      expect(outcome?.discovered).toBe(1);
      expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["deploy"]);
    });

    it("finds a prompts directory at any depth", async () => {
      const f = serve({
        sha: "commit-1",
        skills: {},
        extra: {
          "04-skills/deploy/SKILL.md": skillMd("deploy", "Deploy it."),
          "04-skills/prompts/standup.md": "---\ndescription: Daily standup\n---\nSummarize $1",
          // Deeper than a direct child: something a prompt includes.
          "04-skills/prompts/parts/intro.md": "Shared text",
        },
      });
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

      const outcome = await serviceFor(f).syncOnce(source.id);

      expect(outcome?.imported).toBe(2);
      const rows = await db.select().from(skills).orderBy(skills.name);
      expect(rows.map((r) => r.name)).toEqual(["deploy", "standup"]);
      expect(rows[1]?.frontmatter).toMatchObject({ invocation: "prompt" });
    });
  });

  describe("a sync that imports nothing says why", () => {
    it("reports a repository that holds no SKILL.md, rather than plain success", async () => {
      // The exact shape of the report: the old scan reported `ok` with zero
      // counts, and the panel showed "0 skills · synced just now".
      const f = serve({ sha: "commit-1", skills: {}, extra: { "README.md": "# Notes\n" } });
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/tk-brain" });

      const outcome = await serviceFor(f).syncOnce(source.id);

      expect(outcome?.status).toBe("warning");
      expect(outcome?.discovered).toBe(0);
      expect(outcome?.excluded).toBe(0);
      expect(outcome?.notice).toContain("found no SKILL.md file");
      expect(outcome?.notice).toContain("check the branch");
      const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
      expect(row?.status).toBe("warning");
      expect(row?.lastError).toContain("found no SKILL.md file");
    });

    it("names the subdirectory when one is set and holds nothing", async () => {
      // The subdirectory IS there — it holds a README — and holds no skill.
      // That is a real emptiness, unlike the renamed case below, so the
      // notice names the subdirectory as the thing to check.
      const f = serve({
        sha: "commit-1",
        skills: {},
        extra: {
          "skills/README.md": "# Skills\n",
          "04-skills/deploy/SKILL.md": skillMd("deploy", "Deploy it."),
        },
      });
      const source = await createContentSource(db, owner("u1"), {
        repo: "tkhq/tk-brain",
        subpath: "skills",
      });

      const outcome = await serviceFor(f).syncOnce(source.id);

      expect(outcome?.status).toBe("warning");
      expect(outcome?.notice).toContain("no SKILL.md file under skills");
      expect(outcome?.notice).toContain("Check the subdirectory");
    });

    it("fails, and mirrors on, when the subdirectory is renamed upstream", async () => {
      // The trade the tree read made, and the one place it had to be paid
      // back. The old scan asked the contents endpoint for `04-skills`, got
      // a 404, and failed — which KEPT the mirrored rows. A tree read
      // answers the whole repository, so the same rename looks like "this
      // repository holds no skill", and reconcile would delete every row.
      const repo: FakeRepo = {
        sha: "commit-1",
        root: "04-skills",
        skills: {
          deploy: skillMd("deploy", "Deploy it."),
          "on-call": skillMd("on-call", "Answer."),
        },
      };
      const f = serve(repo);
      const source = await createContentSource(db, owner("u1"), {
        repo: "tkhq/skills",
        subpath: "04-skills",
      });
      const service = serviceFor(f);
      await service.syncOnce(source.id);
      expect(await db.select().from(skills)).toHaveLength(2);

      // The skills are all still in the repository. Only the directory moved.
      repo.sha = "commit-2";
      repo.root = "skills";

      const outcome = await service.syncOnce(source.id);

      expect(outcome?.status).toBe("error");
      expect(outcome?.deleted).toBe(0);
      expect(outcome?.error).toContain("has no directory 04-skills");
      expect(outcome?.error).toContain("Check the branch");
      // The mirror survives, which is the whole point.
      const rows = await db.select().from(skills).orderBy(skills.name);
      expect(rows.map((r) => r.name)).toEqual(["deploy", "on-call"]);
      const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
      // The commit is NOT recorded, so a fix upstream is picked up.
      expect(row?.lastSha).toBe("commit-1");
    });

    it("names the skills it removed when the subdirectory empties out", async () => {
      // The directory is still there and its skills are gone, so deleting
      // the rows is right. Saying only "check the subdirectory" is not: the
      // advice arrives after the data, and the count is what the reader acts
      // on.
      const repo: FakeRepo = {
        sha: "commit-1",
        root: "04-skills",
        skills: {
          deploy: skillMd("deploy", "Deploy it."),
          "on-call": skillMd("on-call", "Answer."),
        },
      };
      const f = serve(repo);
      const source = await createContentSource(db, owner("u1"), {
        repo: "tkhq/skills",
        subpath: "04-skills",
      });
      const service = serviceFor(f);
      await service.syncOnce(source.id);

      repo.sha = "commit-2";
      repo.skills = {};
      repo.extra = { "04-skills/README.md": "# Nothing here now\n" };

      const outcome = await service.syncOnce(source.id);

      expect(outcome?.status).toBe("warning");
      expect(outcome?.deleted).toBe(2);
      expect(outcome?.notice).toContain("removed the 2 skills it had mirrored");
      expect(await db.select().from(skills)).toHaveLength(0);
    });

    it("says so when every SKILL.md sits under a directory it does not scan", async () => {
      const f = serve({
        sha: "commit-1",
        skills: {},
        extra: { "node_modules/@acme/kit/skills/deploy/SKILL.md": skillMd("deploy", "Not ours.") },
      });
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/tk-brain" });

      const outcome = await serviceFor(f).syncOnce(source.id);

      expect(outcome?.status).toBe("warning");
      expect(outcome?.discovered).toBe(0);
      expect(outcome?.excluded).toBe(1);
      expect(outcome?.notice).toContain("all under directories it does not scan");
      expect(outcome?.notice).toContain("Set the subdirectory");
    });

    it("keeps the report on the row when the next poll finds the commit unmoved", async () => {
      // Without this the row flips to a silent `ok` on the next sweep, and
      // the person is back to "0 skills, no reason given" fifteen minutes
      // after reading the reason.
      const f = serve({ sha: "commit-1", skills: {} });
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/tk-brain" });
      const service = serviceFor(f);
      await service.syncOnce(source.id);

      f.calls.length = 0;
      const outcome = await service.syncOnce(source.id);

      expect(f.calls).toHaveLength(1);
      expect(outcome?.status).toBe("warning");
      const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
      expect(row?.status).toBe("warning");
      expect(row?.lastError).toContain("found no SKILL.md file");
    });

    it("says nothing extra when skills were found and every one was skipped", async () => {
      // Each broken skill already carries its own line. A second message
      // about the repository would hide them behind a wrong diagnosis.
      const f = serve({
        sha: "commit-1",
        skills: { broken: "---\nname: Not A Name\n---\n\nBody.\n" },
      });
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

      const outcome = await serviceFor(f).syncOnce(source.id);

      expect(outcome?.status).toBe("warning");
      expect(outcome?.discovered).toBe(1);
      expect(outcome?.notice).toBeNull();
      expect(outcome?.warnings.join(" ")).toContain("broken");
    });
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
    const source = await createContentSource(db, owner("u1"), { repo: "anthropics/skills" });

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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
    const service = serviceFor(f);
    await service.syncOnce(source.id);
    const [before] = await db.select().from(skills);

    // The commit moves, but nothing under the skills directory changed.
    repo.sha = "commit-2";
    f.calls.length = 0;
    const outcome = await service.syncOnce(source.id);

    // Two calls, not eleven: the manifest key is the blob sha the tree read
    // carries, so the second compare runs before any file is read.
    expect(f.calls.map((call) => call.path)).toEqual([
      "/repos/tkhq/skills/commits/HEAD",
      "/repos/tkhq/skills/git/trees/tree-commit-2",
    ]);
    expect(outcome?.changed).toBe(false);
    expect(outcome).toMatchObject({ imported: 0, updated: 0, deleted: 0 });
    const [after] = await db.select().from(skills);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
    expect(row?.lastSha).toBe("commit-2");
  });

  it("rewrites a skill whose body changed upstream", async () => {
    const repo: FakeRepo = {
      sha: "commit-1",
      skills: { deploy: skillMd("deploy", "Deploy it.", "Run make deploy.") },
    };
    const f = serve(repo);
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
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
    const mine = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
    // A SECOND source in the SAME owner scope: only `source_id` separates
    // its rows from the ones being reconciled.
    const sibling = await createContentSource(db, owner("u1"), { repo: "tkhq/other" });
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
    const theirs = await createContentSource(db, owner("u2"), { repo: "tkhq/skills" });
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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
    const service = serviceFor(f);

    const outcome = await service.syncOnce(source.id);

    expect(outcome?.status).toBe("warning");
    expect(outcome?.imported).toBe(1);
    expect(outcome?.warnings.join(" ")).toContain("broken");
    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.status).toBe("warning");
    expect(outcome?.imported).toBe(0);
    expect(outcome?.warnings.join(" ")).toContain("deploy");
    const rows = await db.select().from(skills);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe("local");
    expect(rows[0]?.content).toBe("# Local\n");
  });

  it("reports a missing repository, names what to connect, and backs off", async () => {
    fixture = startGithubFixture({
      getCommit: () => ({ status: 404, body: { message: "Not Found" } }),
    });
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/private" });

    const outcome = await serviceFor(fixture).syncOnce(source.id);

    expect(outcome?.status).toBe("error");
    // The message a person reads when nothing is connected must name the
    // screen that fixes it, and must NOT tell them to publish the repository.
    expect(outcome?.error).toContain("no GitHub credential");
    expect(outcome?.error).toContain("Connected accounts");
    expect(outcome?.error).not.toContain("make the repository public");
    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
    expect(row?.status).toBe("error");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("Connected accounts");
    expect(row?.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(row?.lastSha).toBeNull();
  });

  describe("a private repository", () => {
    const PRIVATE = {
      sha: "commit-1",
      skills: { deploy: skillMd("deploy", "Deploy it.") },
      requireToken: "ghu_u1",
    } as const;

    it("mirrors when the owner's GitHub account can read it", async () => {
      const f = serve({ ...PRIVATE });
      await connectGitHub("u1", "ghu_u1", "octocat");
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/tk-brain" });

      const outcome = await credentialedServiceFor(f).syncOnce(source.id);

      expect(outcome?.status).toBe("ok");
      expect(outcome?.imported).toBe(1);
      expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["deploy"]);
      expect(f.calls.every((call) => call.authHeader === "Bearer ghu_u1")).toBe(true);
    });

    it("tells an unconnected owner what to connect, and mirrors nothing", async () => {
      const f = serve({ ...PRIVATE });
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/tk-brain" });

      const outcome = await credentialedServiceFor(f).syncOnce(source.id);

      expect(outcome?.status).toBe("error");
      expect(outcome?.error).toContain("no GitHub credential");
      expect(outcome?.error).toContain("Connected accounts");
      expect(outcome?.error).not.toContain("make the repository public");
      expect(await db.select().from(skills)).toEqual([]);
      expect(f.calls[0]?.authHeader).toBeUndefined();
    });

    it("names the account when a connected one cannot see it", async () => {
      const f = serve({ ...PRIVATE });
      // Connected, but to an account the repository does not admit.
      await connectGitHub("u1", "ghu_other", "hubot");
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/tk-brain" });

      const outcome = await credentialedServiceFor(f).syncOnce(source.id);

      expect(outcome?.error).toContain("the GitHub account hubot");
      expect(outcome?.error).toContain("Get access to the repository on GitHub");
      // The token that failed must not travel with the reason it failed.
      expect(outcome?.error).not.toContain("ghu_other");
    });

    it("keeps no token material in the row the wire and the UI read", async () => {
      const f = serve({ ...PRIVATE });
      await connectGitHub("u1", "ghu_other", "hubot");
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/tk-brain" });

      await credentialedServiceFor(f).syncOnce(source.id);

      const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
      expect(row?.lastError).not.toContain("ghu_other");
      expect(row?.lastError).toContain("hubot");
    });

    it("does not let a team source borrow the credential of a nearby user", async () => {
      // The source was added by u2, who has no GitHub connection. u1 IS
      // connected and could read the repository. The sync must stay
      // anonymous rather than reach for whatever credential is nearby.
      const f = serve({ ...PRIVATE });
      await connectGitHub("u1", "ghu_u1", "octocat");
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/tk-brain" });
      await db
        .update(contentSources)
        .set({ ownerType: "team", ownerId: TEAM, createdBy: "u2" })
        .where(eq(contentSources.id, source.id));

      const outcome = await credentialedServiceFor(f).syncOnce(source.id);

      expect(outcome?.status).toBe("error");
      expect(outcome?.error).toContain("no GitHub credential");
      expect(f.calls.every((call) => call.authHeader === undefined)).toBe(true);
    });

    it("stops pulling with the creator's credential once they leave the team", async () => {
      // The whole loop, end to end, because this is what the product runs on
      // a timer and on "Sync now". u2 legitimately added a private repository
      // for their team. u2 then leaves the team, which deletes one
      // `team_members` row and nothing else — their `users` row, their org
      // membership and their GitHub credential all survive.
      const f = serve({ ...PRIVATE, requireToken: "ghu_u2" });
      await connectGitHub("u2", "ghu_u2", "hubot");
      const source = await createContentSource(db, owner("u2"), { repo: "tkhq/tk-brain" });
      await db
        .update(contentSources)
        .set({ ownerType: "team", ownerId: TEAM, createdBy: "u2" })
        .where(eq(contentSources.id, source.id));

      // While u2 is a member the mirror fills, which is the intended feature.
      expect((await credentialedServiceFor(f).syncOnce(source.id))?.status).toBe("ok");
      expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["deploy"]);
      const callsBeforeLeaving = f.calls.length;
      expect(callsBeforeLeaving).toBeGreaterThan(0);

      await db
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, TEAM), eq(teamMembers.userId, "u2")));
      // Force the next sync to do real work rather than stop at an unmoved
      // head commit, the way a repository push would.
      await db.update(contentSources).set({ lastSha: null }).where(eq(contentSources.id, source.id));

      const after = await credentialedServiceFor(f).syncOnce(source.id);

      expect(after?.status).toBe("error");
      expect(after?.error).toContain("no GitHub credential");
      // Not one request after the departure carried the ex-member's token.
      expect(f.calls.slice(callsBeforeLeaving).map((call) => call.authHeader)).not.toContain(
        "Bearer ghu_u2",
      );
    });

    it("names an action the team reader can take, and no GitHub login", async () => {
      // A team source's error is read by the whole team, and the reader is
      // usually not the person whose credential the sync uses. Telling them
      // to get access does nothing, and naming the login exposes one person
      // on a row that otherwise names nobody.
      const f = serve({ ...PRIVATE });
      await connectGitHub("u2", "ghu_other", "hubot");
      const source = await createContentSource(db, owner("u2"), { repo: "tkhq/tk-brain" });
      await db
        .update(contentSources)
        .set({ ownerType: "team", ownerId: TEAM, createdBy: "u2" })
        .where(eq(contentSources.id, source.id));

      await credentialedServiceFor(f).syncOnce(source.id);

      const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
      expect(row?.lastError).not.toContain("ghu_other");
      expect(row?.lastError).not.toContain("hubot");
      expect(row?.lastError).toContain("the GitHub account that added this source");
      expect(row?.lastError).toContain("add the source again yourself");
    });
  });

  it("still mirrors a public repository with no credential connected", async () => {
    // The regression this change must not cause: tracking a public
    // repository has never needed a GitHub connection, and still does not.
    const f = serve({ sha: "commit-1", skills: { deploy: skillMd("deploy", "Deploy it.") } });
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await credentialedServiceFor(f).syncOnce(source.id);

    expect(outcome?.status).toBe("ok");
    expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["deploy"]);
    expect(f.calls.every((call) => call.authHeader === undefined)).toBe(true);
  });

  it("retries a file that discovery found and the sync could not read", async () => {
    // A 404 on ONE file, in the window between the tree read and the file
    // reads. Dropping it silently is not the whole bug: recording the
    // manifest hash computed from the full listing makes compare 2 skip the
    // commit on every later poll, so the skill stays missing until somebody
    // edits that exact file.
    const repo: FakeRepo = { sha: "commit-1", skills: { deploy: skillMd("deploy", "Deploy it.") } };
    let escalateReadable = false;
    fixture = startGithubFixture({
      getCommit: () => ({ body: commitBody(repo.sha) }),
      getTree: () => ({
        body: {
          sha: `tree-${repo.sha}`,
          truncated: false,
          tree: [
            treeEntry("deploy/SKILL.md", { sha: "blob-deploy" }),
            treeEntry("escalate/SKILL.md", { sha: "blob-escalate" }),
          ],
        },
      }),
      getContents: (_o, _r, path) => {
        if (path === "deploy/SKILL.md") {
          return contentsBody(skillMd("deploy", "Deploy it."), "blob-deploy");
        }
        if (path === "escalate/SKILL.md" && escalateReadable) {
          return contentsBody(skillMd("escalate", "Escalate it."), "blob-escalate");
        }
        return { status: 404, body: { message: "Not Found" } };
      },
    });
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
    const service = serviceFor(fixture);

    const first = await service.syncOnce(source.id);

    expect(first?.status).toBe("warning");
    expect(first?.imported).toBe(1);
    expect(first?.warnings.join("\n")).toContain("escalate/SKILL.md");
    expect(first?.warnings.join("\n")).toContain("reads it again on the next sync");
    const [afterFirst] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
    // Neither compare may be told this commit is mirrored, because it is not.
    expect(afterFirst?.lastSha).toBeNull();
    expect(afterFirst?.lastManifestHash).toBeNull();

    // The file becomes readable and the head moves. Nothing about the
    // manifest changed, so the old code stopped at compare 2 forever.
    escalateReadable = true;
    repo.sha = "commit-2";
    const second = await service.syncOnce(source.id);

    expect(second?.status).toBe("ok");
    expect(second?.imported).toBe(1);
    const rows = await db.select().from(skills).orderBy(skills.name);
    expect(rows.map((r) => r.name)).toEqual(["deploy", "escalate"]);
    const [afterSecond] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
    expect(afterSecond?.lastSha).toBe("commit-2");
    expect(afterSecond?.lastManifestHash).not.toBeNull();
  });

  it("regenerates the report after a failure, instead of coming back green", async () => {
    // warning → error → unchanged manifest. `recordFailure` overwrites
    // `last_error` with the transport message, so the warning report is
    // gone; re-deriving the row's health from its own previous status
    // therefore reports `ok` on a source that is still missing a skill.
    const repo: FakeRepo = {
      sha: "commit-1",
      skills: {
        deploy: skillMd("deploy", "Deploy it."),
        broken: "---\nname: Not A Name\n---\n\nBody.\n",
      },
    };
    const f = serve(repo);
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
    const service = serviceFor(f);

    const first = await service.syncOnce(source.id);
    expect(first?.status).toBe("warning");
    expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["deploy"]);

    // A transport failure lands next, and takes the warning text with it.
    await f.close();
    fixture = startGithubFixture({ getCommit: () => ({ status: 500, body: { message: "boom" } }) });
    const failed = await serviceFor(fixture).syncOnce(source.id);
    expect(failed?.status).toBe("error");
    await fixture.close();

    // The head moves; the skills it holds are unchanged.
    repo.sha = "commit-2";
    const back = serve(repo);
    const third = await serviceFor(back).syncOnce(source.id);

    expect(third?.status).toBe("warning");
    expect(third?.warnings.join("\n")).toContain("broken");
    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
    expect(row?.status).toBe("warning");
    expect(row?.lastError).toContain("broken");
    // Still one skill mirrored, which is what the warning is about.
    expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["deploy"]);
  });

  it("imports no skill from a repository that holds more than one sync reads", async () => {
    // The tree read is one request; the file reads are one each, in
    // sequence. Importing the first N of an over-long list and reconciling
    // would make every file past N look deleted upstream, so this fails and
    // names the subdirectory as the fix.
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_SKILL_CANDIDATES + 1; i += 1) {
      many[`skills/skill-${i}/SKILL.md`] = skillMd(`skill-${i}`, "One of very many.");
    }
    const f = serve({ sha: "commit-1", skills: {}, extra: many });
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.status).toBe("error");
    expect(outcome?.error).toContain(`reads at most ${MAX_SKILL_CANDIDATES}`);
    expect(outcome?.error).toContain("import the /tree/ URL");
    expect(await db.select().from(skills)).toHaveLength(0);
    // No SKILL.md was read: the sync stopped at the tree.
    expect(f.calls.filter((call) => call.path.endsWith("/SKILL.md"))).toHaveLength(0);
  });

  it("keeps the mirrored skills when one file read fails mid-sync", async () => {
    const repo: FakeRepo = {
      sha: "commit-1",
      skills: { deploy: skillMd("deploy", "Deploy it."), "on-call": skillMd("on-call", "Answer.") },
    };
    const f = serve(repo);
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
    const service = serviceFor(f);
    await service.syncOnce(source.id);
    await f.close();

    // A GitHub fault on the second poll must not look like "every skill was
    // deleted upstream". Discovery succeeds and reports both files as
    // changed, so the sync gets as far as reading one — and that read is
    // what fails.
    fixture = startGithubFixture({
      getCommit: () => ({ body: commitBody("commit-2") }),
      getTree: () => ({
        body: {
          sha: "tree-commit-2",
          truncated: false,
          tree: [
            treeEntry("deploy/SKILL.md", { sha: "blob-moved-1" }),
            treeEntry("on-call/SKILL.md", { sha: "blob-moved-2" }),
          ],
        },
      }),
      getContents: () => ({ status: 500, body: { message: "boom" } }),
    });
    const outcome = await serviceFor(fixture).syncOnce(source.id);

    expect(outcome?.status).toBe("error");
    expect(await db.select().from(skills)).toHaveLength(2);
    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
    expect(row?.lastSha).toBe("commit-1");
  });

  describe("a repository too large for one tree read", () => {
    /** Two mirrored skills, then the repository grows past the tree limit. */
    async function mirroredThenTruncated(subpath?: string): Promise<{
      f: GithubFixture;
      sourceId: string;
      repo: FakeRepo;
      before: { name: string; updatedAt: number; contentSha: string }[];
    }> {
      const repo: FakeRepo = {
        sha: "commit-1",
        ...(subpath === undefined ? {} : { root: subpath }),
        skills: {
          deploy: skillMd("deploy", "Deploy it."),
          "on-call": skillMd("on-call", "Answer."),
        },
      };
      const f = serve(repo);
      const source = await createContentSource(db, owner("u1"), {
        repo: "tkhq/skills",
        ...(subpath === undefined ? {} : { subpath }),
      });
      await serviceFor(f).syncOnce(source.id);
      const rows = await db.select().from(skills).orderBy(skills.name);
      expect(rows.map((r) => r.name)).toEqual(["deploy", "on-call"]);
      repo.sha = "commit-2";
      repo.truncatedTree = true;
      // Only the calls the NEXT sync makes are interesting here.
      f.calls.length = 0;
      return {
        f,
        sourceId: source.id,
        repo,
        before: rows.map((r) => ({
          name: r.name,
          updatedAt: r.updatedAt,
          contentSha: r.contentSha,
        })),
      };
    }

    it("imports no subset, and names the subdirectory as the fix", async () => {
      // The whole repository is the scan, so there is nowhere smaller to
      // look. The files GitHub left out of the cut tree cannot be told apart
      // from skills the repository no longer holds, so the sync must fail
      // rather than reconcile against a part of the listing.
      const { f, sourceId, before } = await mirroredThenTruncated();

      const outcome = await serviceFor(f).syncOnce(sourceId);

      expect(outcome?.status).toBe("error");
      expect(outcome?.error).toContain("read part of it");
      expect(outcome?.error).toContain("Set the subdirectory");
      expect(outcome).toMatchObject({ imported: 0, updated: 0, deleted: 0 });
      // Both rows are still there, and neither was rewritten.
      const after = await db.select().from(skills).orderBy(skills.name);
      expect(after.map((r) => r.name)).toEqual(["deploy", "on-call"]);
      expect(after.map((r) => r.updatedAt)).toEqual(before.map((r) => r.updatedAt));
      expect(after.map((r) => r.contentSha)).toEqual(before.map((r) => r.contentSha));
      // The sync stopped at the tree: no SKILL.md was read.
      expect(f.calls.filter((call) => call.path.endsWith("/SKILL.md"))).toHaveLength(0);

      const [row] = await db.select().from(contentSources).where(eq(contentSources.id, sourceId));
      expect(row?.status).toBe("error");
      expect(row?.attempts).toBe(1);
      // The commit is NOT recorded, so the next poll reads the repository again.
      expect(row?.lastSha).toBe("commit-1");
    });

    it("falls back to the configured subdirectory, and says that it did", async () => {
      // A subdirectory is somewhere smaller to look, and the contents
      // endpoint carries its own cut guard, so this source keeps importing.
      // It reports `warning`, not `ok`: the scan no longer covers the
      // repository, and a source whose deletions stop applying must not look
      // healthy.
      const { f, sourceId, repo } = await mirroredThenTruncated("agent/skills");
      repo.skills.escalate = skillMd("escalate", "Escalate it.");

      const outcome = await serviceFor(f).syncOnce(sourceId);

      expect(outcome?.status).toBe("warning");
      expect(outcome?.discovery).toBe("directory-walk");
      expect(outcome?.imported).toBe(1);
      expect(outcome?.notice).toContain("one level deep");
      expect(outcome?.notice).toContain("no skill is deleted");
      const rows = await db.select().from(skills).orderBy(skills.name);
      expect(rows.map((r) => r.name)).toEqual(["deploy", "escalate", "on-call"]);
    });

    it("keeps a nested skill the fallback cannot reach", async () => {
      // The narrowing the fallback introduces. The tree read mirrored
      // `<dir>/team/escalate/SKILL.md`; the walk reads one level and sees
      // only `<dir>/team/SKILL.md`, which is not there. Absent from a
      // NARROWER scan is not "deleted upstream", and treating it as one
      // destroys a skill the repository still holds.
      const repo: FakeRepo = {
        sha: "commit-1",
        root: "agent/skills",
        skills: { deploy: skillMd("deploy", "Deploy it.") },
        extra: {
          "agent/skills/team/escalate/SKILL.md": skillMd("escalate", "Escalate it."),
        },
      };
      const f = serve(repo);
      const source = await createContentSource(db, owner("u1"), {
        repo: "tkhq/skills",
        subpath: "agent/skills",
      });
      const service = serviceFor(f);
      await service.syncOnce(source.id);
      const mirrored = await db.select().from(skills).orderBy(skills.name);
      expect(mirrored.map((r) => r.name)).toEqual(["deploy", "escalate"]);

      // The repository grows past the tree limit. Nothing about the skills
      // changed.
      repo.sha = "commit-2";
      repo.truncatedTree = true;

      const outcome = await service.syncOnce(source.id);

      expect(outcome?.status).toBe("warning");
      expect(outcome?.discovery).toBe("directory-walk");
      expect(outcome?.deleted).toBe(0);
      const rows = await db.select().from(skills).orderBy(skills.name);
      expect(rows.map((r) => r.name)).toEqual(["deploy", "escalate"]);
      // The report names what the scan could not re-read, so the stale row
      // is a stated outcome and not a silent one.
      expect(outcome?.notice).toContain("kept 1 mirrored skill this scan did not reach: escalate");
    });

    it("keeps every mirrored skill when the fallback listing is partial too", async () => {
      const { f, sourceId } = await mirroredThenTruncated("agent/skills");
      await f.close();

      // The directory now holds more entries than the reader collects. GitHub
      // answers a listing whole, so the over-long directory arrives in one
      // response and the reader keeps the first 500 entries of it. Everything
      // past the cut is missing from what the reader returns, and missing is
      // what reconcile reads as deleted upstream.
      const oversized = Array.from({ length: 600 }, (_v, i) => entry(`skill-${i}`, "dir"));
      fixture = startGithubFixture({
        getCommit: () => ({ body: commitBody("commit-2") }),
        getTree: () => ({ body: { sha: "tree-2", truncated: true, tree: [] } }),
        getContents: (_o, _r, path) =>
          path === "agent/skills" ? { body: oversized } : { status: 404, body: { message: "Not Found" } },
      });
      const outcome = await serviceFor(fixture).syncOnce(sourceId);

      expect(outcome?.status).toBe("error");
      expect(outcome?.deleted).toBe(0);
      expect(outcome?.error).toContain("part of its listing");
      expect(await db.select().from(skills)).toHaveLength(2);
      const [row] = await db.select().from(contentSources).where(eq(contentSources.id, sourceId));
      expect(row?.lastSha).toBe("commit-1");
      // The message names the fix, which is to re-import a smaller directory.
      expect(row?.lastError).toContain("Remove this repository");
    });
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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

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
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

    const outcome = await serviceFor(f).syncOnce(source.id);

    expect(outcome?.status).toBe("warning");
    // The reserved-name file is warned about.
    expect(outcome?.warnings.join(" ")).toContain("status");
    // The good prompt is still imported.
    const rows = await db.select().from(skills);
    expect(rows.some((r) => r.name === "summary")).toBe(true);
    expect(rows.some((r) => r.name === "status")).toBe(false);
  });

  // F4 (skill collector): a skill directory named after a reserved builtin is
  // skipped with a per-file warning; the rest of the sync continues.
  it("skips a skill directory whose name is a reserved builtin command", async () => {
    const f = serve({
      sha: "commit-1",
      skills: {
        status: skillMd("status", "Shows status."),
        good: skillMd("good", "A safe skill."),
      },
    });
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

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
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
      const now = source.nextAttemptAt;

      expect(await claimDueContentSources(db, now)).toEqual([source.id]);
      // The fence: the loser of a race re-checks the due predicate against
      // the winner's committed row, where `next_attempt_at` has moved.
      expect(await claimDueContentSources(db, now)).toEqual([]);

      const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
      expect(row?.nextAttemptAt).toBeGreaterThan(now);
    });

    it("leaves a source that is not due yet", async () => {
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
      await db
        .update(contentSources)
        .set({ nextAttemptAt: source.nextAttemptAt + 60_000 })
        .where(eq(contentSources.id, source.id));

      expect(await claimDueContentSources(db, source.nextAttemptAt)).toEqual([]);
    });

    it("leaves a disabled source", async () => {
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
      await db.update(contentSources).set({ enabled: false }).where(eq(contentSources.id, source.id));

      expect(await claimDueContentSources(db, source.nextAttemptAt)).toEqual([]);
    });

    it("syncs every source one pass claims", async () => {
      const f = serve({ sha: "commit-1", skills: { deploy: skillMd("deploy", "Deploy it.") } });
      const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });

      // Read the clock before the sync, not after. The sync schedules from
      // its own `Date.now()`, which is at or after this one, so the bound
      // holds however long the assertions below take to run.
      const beforeSync = Date.now();
      await serviceFor(f).pollOnce();

      expect((await db.select().from(skills)).map((r) => r.name)).toEqual(["deploy"]);
      const [row] = await db.select().from(contentSources).where(eq(contentSources.id, source.id));
      expect(row?.status).toBe("ok");
      // The sync's own schedule replaces the claim lease.
      expect(row?.nextAttemptAt).toBeGreaterThanOrEqual(beforeSync + SYNC_INTERVAL_MS);
    });
  });
});
