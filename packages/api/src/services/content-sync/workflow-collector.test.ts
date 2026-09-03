/**
 * The workflow collector, driven through `syncOnce` — the same entry point
 * the skills collector runs under, against the same GitHub fixture.
 *
 * The cases that matter most are the ones about NOT writing: a transport
 * failure, a cut tree, and a file that stopped parsing all leave the mirrored
 * rows alone. A mirror that loses a working workflow because someone pushed a
 * typo is worse than a mirror that lags a commit.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../../lib/drizzle.js";
import { freshTestPgDb } from "../../test-helpers/pg-test-db.js";
import {
  commitBody,
  startGithubFixture,
  treeEntry,
  type GithubFixture,
} from "../../test-helpers/github-fixture.js";
import {
  contentSources,
  orgMembers,
  orgs,
  teamMembers,
  teams,
  users,
  workflowDefinitions,
  workflowRuns,
  workflowSchedules,
  workflowVersions,
} from "../../schema/index.js";
import { createContentSource } from "../content-sources.js";
import { GitHubSkillRepoReader } from "../skill-repo-reader.js";
import { ContentSyncService } from "./service.js";
import { SkillCollector } from "./skill-collector.js";
import { WorkflowCollector } from "./workflow-collector.js";

const ORG = "org1";
const TEAM = "team_1";

/** The smallest graph the dag/v1 validator accepts. */
const GRAPH = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

/** A workflow file in the envelope form the design documents. `end` names
 * the stop node, so a second call produces a different graph without needing
 * a node type that carries more fields. */
function workflowYaml(name: string, end = "stop"): string {
  return [
    "valet: workflow/v1",
    `name: ${name}`,
    "definition:",
    "  version: dag/v1",
    "  nodes:",
    "    - id: trigger",
    "      type: trigger",
    `    - id: ${end}`,
    "      type: stop",
    "  edges:",
    "    - from: trigger",
    `      to: ${end}`,
    "",
  ].join("\n");
}

let fixture: GithubFixture | undefined;

function blobShaOf(content: string): string {
  return `blob-${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12)}`;
}

interface FakeRepo {
  sha: string;
  /** Every file, keyed by path from the repository root. */
  files: Record<string, string>;
  truncatedTree?: boolean;
  /** Every request after this many fails, playing a GitHub outage. */
  failAfter?: number;
}

function serve(repo: FakeRepo): GithubFixture {
  const failed = { status: 500 as const, body: { message: "Server Error" } };
  const down = (): boolean =>
    repo.failAfter !== undefined && (fixture?.calls.length ?? 0) > repo.failAfter;
  fixture = startGithubFixture({
    getCommit: () => (down() ? failed : { body: commitBody(repo.sha) }),
    getTree: () =>
      down()
        ? failed
        : {
            body: {
              sha: `tree-${repo.sha}`,
              truncated: repo.truncatedTree === true,
              tree: Object.entries(repo.files).map(([path, content]) =>
                treeEntry(path, { sha: blobShaOf(content) }),
              ),
            },
          },
    getContents: (_owner, _name, path) => {
      if (down()) return failed;
      const content = repo.files[path];
      if (typeof content !== "string") return { status: 404, body: { message: "Not Found" } };
      return {
        body: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(content, "utf8").toString("base64"),
          sha: blobShaOf(content),
        },
      };
    },
  });
  return fixture;
}

describe("workflow collector", () => {
  let db: AppDb;

  beforeEach(async () => {
    const { appDb } = await freshTestPgDb();
    db = appDb;
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await db.insert(users).values({ id: "u1", email: "u1@x.test", name: "u1", role: "member" });
    await db.insert(orgMembers).values({ orgId: ORG, userId: "u1", role: "member" });
    await db.insert(teams).values({ id: TEAM, orgId: ORG, name: "Team", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId: TEAM, userId: "u1", role: "member" });
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  function serviceFor(f: GithubFixture): ContentSyncService {
    return new ContentSyncService({
      db,
      reader: new GitHubSkillRepoReader({ apiUrl: f.url }),
      collectors: [new SkillCollector(), new WorkflowCollector()],
    });
  }

  /** A team source that collects workflows and nothing else. `kinds` is not
   * accepted on create yet (that is the source-routes task), so this sets the
   * column. Workflows only, so the skills collector's "found no SKILL.md"
   * notice does not colour every outcome in this suite. */
  async function teamSource(repo = "tkhq/automation"): Promise<string> {
    const source = await createContentSource(db, { userId: "u1", orgId: ORG }, { repo, teamId: TEAM });
    await db
      .update(contentSources)
      .set({ kinds: ["workflows"] })
      .where(eq(contentSources.id, source.id));
    return source.id;
  }

  async function mirrored(): Promise<Array<typeof workflowDefinitions.$inferSelect>> {
    return db
      .select()
      .from(workflowDefinitions)
      .orderBy(workflowDefinitions.upstreamPath);
  }

  it("mirrors a workflow file from each root, owned by the source's team", async () => {
    const f = serve({
      sha: "c1",
      files: {
        ".valet/workflows/nightly.yaml": workflowYaml("Nightly"),
        "workflows/billing/invoice.yml": workflowYaml("Invoice"),
        "README.md": "# repo\n",
      },
    });
    const id = await teamSource();

    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("ok");

    const rows = await mirrored();
    expect(rows.map((r) => r.upstreamPath)).toEqual([
      ".valet/workflows/nightly.yaml",
      "workflows/billing/invoice.yml",
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Nightly", "Invoice"]);
    for (const row of rows) {
      expect(row.origin).toBe("repo");
      expect(row.sourceId).toBe(id);
      expect(row.ownerType).toBe("team");
      expect(row.ownerId).toBe(TEAM);
      expect(row.orgId).toBe(ORG);
    }
    // Version 1 per workflow, stamped with the commit that produced it.
    const versions = await db.select().from(workflowVersions);
    expect(versions).toHaveLength(2);
    expect(versions.every((v) => v.version === 1 && v.sourceCommit === "c1")).toBe(true);
  });

  it("adds a version carrying the new commit when the graph changes", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);

    repo.sha = "c2";
    // A different graph, still valid: the stop node is renamed, which moves
    // the definition hash and so mints a version.
    repo.files[".valet/workflows/nightly.yaml"] = workflowYaml("Nightly", "done");
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.warnings).toEqual([]);
    expect(outcome?.status).toBe("ok");

    const versions = await db.select().from(workflowVersions).orderBy(workflowVersions.version);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions.map((v) => v.sourceCommit)).toEqual(["c1", "c2"]);
    expect(versions.every((v) => v.origin === "repo")).toBe(true);
  });

  it("removes the definition, its versions, and its triggers when the file goes", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: {
        ".valet/workflows/nightly.yaml": workflowYaml("Nightly"),
        ".valet/workflows/keep.yaml": workflowYaml("Keep"),
      },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);

    const rowsBefore = await mirrored();
    const gone = rowsBefore.find((r) => r.upstreamPath === ".valet/workflows/nightly.yaml");
    expect(gone).toBeDefined();
    if (gone === undefined) throw new Error("unreachable");
    const now = Date.now();
    await db.insert(workflowSchedules).values({
      id: "sched_1",
      orgId: ORG,
      ownerType: "team",
      ownerId: TEAM,
      targetKind: "workflow",
      workflowId: gone.id,
      name: "nightly",
      cron: "0 3 * * *",
      nextFireAt: now + 1000,
      createdBy: "u1",
      createdAt: now,
      updatedAt: now,
    });

    repo.sha = "c2";
    delete repo.files[".valet/workflows/nightly.yaml"];
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("ok");

    const rows = await mirrored();
    expect(rows.map((r) => r.upstreamPath)).toEqual([".valet/workflows/keep.yaml"]);
    expect(await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, gone.id))).toHaveLength(0);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("disarms rather than deletes while a run has not settled, and deletes once it has", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);
    const [row] = await mirrored();

    const now = Date.now();
    await db.insert(workflowRuns).values({
      id: "wfrun_1",
      workflowId: row.id,
      definitionVersionId: "v1",
      definition: GRAPH,
      params: {},
      status: "running",
      ownerType: "team",
      ownerId: TEAM,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workflowSchedules).values({
      id: "sched_1",
      orgId: ORG,
      ownerType: "team",
      ownerId: TEAM,
      targetKind: "workflow",
      workflowId: row.id,
      name: "nightly",
      cron: "0 3 * * *",
      nextFireAt: now + 1000,
      createdBy: "u1",
      createdAt: now,
      updatedAt: now,
    });

    repo.sha = "c2";
    repo.files = { "README.md": "# repo\n" };
    await serviceFor(f).syncOnce(id);

    // The definition survives so the run stays reachable; nothing can start it.
    expect(await mirrored()).toHaveLength(1);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);

    await db.update(workflowRuns).set({ status: "settled" }).where(eq(workflowRuns.id, "wfrun_1"));
    repo.sha = "c3";
    await serviceFor(f).syncOnce(id);
    expect(await mirrored()).toHaveLength(0);
  });

  it("reconciles nothing when the read fails", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);
    expect(await mirrored()).toHaveLength(1);

    repo.sha = "c2";
    repo.files = {};
    repo.failAfter = f.calls.length;
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("error");
    expect(await mirrored()).toHaveLength(1);
  });

  it("deletes nothing when GitHub cuts the tree", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: { "wf/.valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    };
    const f = serve(repo);
    // A subpath, because a cut tree with no subpath fails the whole sync.
    const source = await createContentSource(
      db,
      { userId: "u1", orgId: ORG },
      { repo: "tkhq/automation", subpath: "wf", teamId: TEAM },
    );
    await db.update(contentSources).set({ kinds: ["workflows"] }).where(eq(contentSources.id, source.id));

    await serviceFor(f).syncOnce(source.id);
    // The path is judged from the repository root, so a subpath'd root is not
    // a workflow root: nothing is mirrored, and nothing is deleted either.
    const before = await mirrored();

    repo.sha = "c2";
    repo.truncatedTree = true;
    const outcome = await serviceFor(f).syncOnce(source.id);
    expect(outcome?.status).toBe("ok");
    expect(await mirrored()).toHaveLength(before.length);
  });

  it("keeps the mirrored row when the file stops parsing, and says why", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    };
    const f = serve(repo);
    const id = await teamSource();
    await serviceFor(f).syncOnce(id);

    repo.sha = "c2";
    repo.files[".valet/workflows/nightly.yaml"] = "valet: workflow/v1\nname: [unclosed\n";
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("warning");

    const rows = await mirrored();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Nightly");
    expect(outcome?.warnings.join(" ")).toContain(".valet/workflows/nightly.yaml");
  });

  it("ignores an unlabeled file under workflows/ and reports one under .valet/workflows/", async () => {
    const f = serve({
      sha: "c1",
      files: {
        "workflows/ci.yml": "name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu\n",
        ".valet/workflows/oops.yaml": "name: forgot the label\nsteps: []\n",
      },
    });
    const id = await teamSource();
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("warning");
    expect(await mirrored()).toHaveLength(0);

    const said = (outcome?.warnings ?? []).join(" ");
    expect(said).toContain(".valet/workflows/oops.yaml");
    expect(said).not.toContain("workflows/ci.yml");
  });

  it("mirrors nothing from a user source and says where workflows do sync", async () => {
    const f = serve({
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    });
    const source = await createContentSource(db, { userId: "u1", orgId: ORG }, { repo: "tkhq/mine" });
    await db.update(contentSources).set({ kinds: ["workflows"] }).where(eq(contentSources.id, source.id));

    const outcome = await serviceFor(f).syncOnce(source.id);
    expect(outcome?.status).toBe("warning");
    expect(await mirrored()).toHaveLength(0);
    expect(outcome?.notice).toContain("team source");
  });

  it("mirrors a team workflow with tool nodes and a schedule, and warns that the trigger is off", async () => {
    const file = [
      "valet: workflow/v1",
      "name: Nightly report",
      "schedule:",
      "  cron: 0 3 * * *",
      "  timezone: UTC",
      "definition:",
      "  version: dag/v1",
      "  nodes:",
      "    - id: trigger",
      "      type: trigger",
      "    - id: fetch",
      "      type: tool",
      "      service: github",
      "      action: list_issues",
      "      params: {}",
      "    - id: stop",
      "      type: stop",
      "  edges:",
      "    - from: trigger",
      "      to: fetch",
      "    - from: fetch",
      "      to: stop",
      "",
    ].join("\n");
    const f = serve({ sha: "c1", files: { ".valet/workflows/report.yaml": file } });
    const id = await teamSource();

    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("warning");

    const rows = await mirrored();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Nightly report");
    // Nothing arms a trigger from a file yet, and a team could not run this
    // one on a schedule in any case. The warning is what says so.
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
    expect(outcome?.warnings.join(" ")).toContain("left the trigger off");
  });

  it("never touches a local workflow, including one of the same name", async () => {
    const f = serve({
      sha: "c1",
      files: { ".valet/workflows/nightly.yaml": workflowYaml("Nightly") },
    });
    const id = await teamSource();
    const now = Date.now();
    await db.insert(workflowDefinitions).values({
      id: "wf_local",
      orgId: ORG,
      ownerType: "user",
      ownerId: "u1",
      name: "Nightly",
      definition: GRAPH,
      origin: "local",
      createdAt: now,
      updatedAt: now,
    });

    await serviceFor(f).syncOnce(id);
    const local = await db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, "wf_local"), eq(workflowDefinitions.origin, "local")));
    expect(local).toHaveLength(1);
    expect(await mirrored()).toHaveLength(2);
  });
});
