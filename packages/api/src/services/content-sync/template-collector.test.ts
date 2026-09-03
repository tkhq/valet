/**
 * The template collector, driven through `syncOnce` against the same GitHub
 * fixture the other two collectors use.
 *
 * The cases that matter are the boundaries: which folder each collector
 * claims, what a rename does when a second unique key is in play, and what a
 * mirrored id that collides with one Valet ships reports.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
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
  workflowTemplates,
} from "../../schema/index.js";
import { createContentSource } from "../content-sources.js";
import { GitHubSkillRepoReader } from "../skill-repo-reader.js";
import { ContentSyncService } from "./service.js";
import { TemplateCollector } from "./template-collector.js";
import { WorkflowCollector } from "./workflow-collector.js";

const ORG = "org1";
const TEAM = "team_1";

/** A template file in the envelope form the design documents. */
function templateYaml(id: string, name = "Nightly digest"): string {
  return [
    "valet: workflow-template/v1",
    `id: ${id}`,
    `name: ${name}`,
    "description: Sends a digest every night.",
    "category: Daily digest",
    "apps: []",
    "steps:",
    "  - Reads the day",
    "definition:",
    "  version: dag/v1",
    "  nodes:",
    "    - id: trigger",
    "      type: trigger",
    "    - id: stop",
    "      type: stop",
    "  edges:",
    "    - from: trigger",
    "      to: stop",
    "",
  ].join("\n");
}

function workflowYaml(name: string): string {
  return [
    "valet: workflow/v1",
    `name: ${name}`,
    "definition:",
    "  version: dag/v1",
    "  nodes:",
    "    - id: trigger",
    "      type: trigger",
    "    - id: stop",
    "      type: stop",
    "  edges:",
    "    - from: trigger",
    "      to: stop",
    "",
  ].join("\n");
}

let fixture: GithubFixture | undefined;

function blobShaOf(content: string): string {
  return `blob-${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12)}`;
}

interface FakeRepo {
  sha: string;
  files: Record<string, string>;
}

function serve(repo: FakeRepo): GithubFixture {
  fixture = startGithubFixture({
    getCommit: () => ({ body: commitBody(repo.sha) }),
    getTree: () => ({
      body: {
        sha: `tree-${repo.sha}`,
        truncated: false,
        tree: Object.entries(repo.files).map(([path, content]) =>
          treeEntry(path, { sha: blobShaOf(content) }),
        ),
      },
    }),
    getContents: (_owner, _name, path) => {
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

describe("template collector", () => {
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

  function serviceFor(f: GithubFixture, shipped: string[] = []): ContentSyncService {
    return new ContentSyncService({
      db,
      reader: new GitHubSkillRepoReader({ apiUrl: f.url }),
      collectors: [
        new WorkflowCollector(),
        new TemplateCollector({
          reserved: () => new Map(shipped.map((id) => [id, "plugin-github"])),
        }),
      ],
    });
  }

  async function teamSource(kinds: ("skills" | "workflows" | "templates")[]): Promise<string> {
    const source = await createContentSource(
      db,
      { userId: "u1", orgId: ORG },
      { repo: "tkhq/automation", teamId: TEAM },
    );
    await db.update(contentSources).set({ kinds }).where(eq(contentSources.id, source.id));
    return source.id;
  }

  const mirrored = () => db.select().from(workflowTemplates).orderBy(workflowTemplates.upstreamPath);

  it("mirrors a template file, owned by the source's team", async () => {
    const f = serve({
      sha: "c1",
      files: { ".valet/templates/digest.yaml": templateYaml("nightly-digest") },
    });
    const id = await teamSource(["templates"]);
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("ok");

    const rows = await mirrored();
    expect(rows).toHaveLength(1);
    expect(rows[0].templateId).toBe("nightly-digest");
    expect(rows[0].ownerType).toBe("team");
    expect(rows[0].ownerId).toBe(TEAM);
    expect(rows[0].origin).toBe("repo");
  });

  // The second unique key is `(org_id, owner_type, owner_id, template_id)`.
  // A rename that keeps the id would insert the new path against a row the
  // old path still holds, so the stale delete has to run first.
  it("survives a rename that keeps the declared id", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: { ".valet/templates/a.yaml": templateYaml("nightly-digest") },
    };
    const f = serve(repo);
    const id = await teamSource(["templates"]);
    await serviceFor(f).syncOnce(id);

    repo.sha = "c2";
    delete repo.files[".valet/templates/a.yaml"];
    repo.files[".valet/templates/b.yaml"] = templateYaml("nightly-digest");
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("ok");

    const rows = await mirrored();
    expect(rows).toHaveLength(1);
    expect(rows[0].upstreamPath).toBe(".valet/templates/b.yaml");
    expect(rows[0].templateId).toBe("nightly-digest");
  });

  it("refuses an id Valet already ships, naming both", async () => {
    const f = serve({
      sha: "c1",
      files: { ".valet/templates/digest.yaml": templateYaml("github-daily-dev-digest") },
    });
    const id = await teamSource(["templates"]);
    const outcome = await serviceFor(f, ["github-daily-dev-digest"]).syncOnce(id);

    expect(await mirrored()).toHaveLength(0);
    const said = outcome?.warnings.join(" ") ?? "";
    expect(said).toContain("github-daily-dev-digest");
    expect(said).toContain("plugin-github");
  });

  it("refuses a second file in one repository claiming the same id", async () => {
    const f = serve({
      sha: "c1",
      files: {
        ".valet/templates/a.yaml": templateYaml("digest"),
        ".valet/templates/b.yaml": templateYaml("digest", "Another"),
      },
    });
    const id = await teamSource(["templates"]);
    const outcome = await serviceFor(f).syncOnce(id);

    // The first wins; the second reports rather than racing the unique index.
    expect(await mirrored()).toHaveLength(1);
    expect(outcome?.warnings.join(" ")).toContain(".valet/templates/b.yaml");
  });

  // The two collectors partition by folder, so neither can delete the
  // other's rows and a misplaced file is reported by exactly one of them.
  it("claims only .valet/templates, and the workflow collector claims only its own", async () => {
    const f = serve({
      sha: "c1",
      files: {
        ".valet/templates/digest.yaml": templateYaml("nightly-digest"),
        ".valet/workflows/nightly.yaml": workflowYaml("Nightly"),
        // Wrong folder each way.
        ".valet/workflows/stray-template.yaml": templateYaml("stray"),
        ".valet/templates/stray-workflow.yaml": workflowYaml("Stray"),
      },
    });
    const id = await teamSource(["workflows", "templates"]);
    const outcome = await serviceFor(f).syncOnce(id);

    expect((await mirrored()).map((r) => r.upstreamPath)).toEqual([
      ".valet/templates/digest.yaml",
    ]);
    const defs = await db.select().from(workflowDefinitions);
    expect(defs.map((r) => r.upstreamPath)).toEqual([".valet/workflows/nightly.yaml"]);

    // Each misplaced file is named once, by the collector whose folder holds
    // it, with the move to make.
    const said = outcome?.warnings.join("\n") ?? "";
    expect(said).toContain(".valet/workflows/stray-template.yaml");
    expect(said).toContain(".valet/templates/stray-workflow.yaml");
  });

  it("mirrors nothing from a user source and says where templates go", async () => {
    const f = serve({
      sha: "c1",
      files: { ".valet/templates/digest.yaml": templateYaml("nightly-digest") },
    });
    const source = await createContentSource(db, { userId: "u1", orgId: ORG }, { repo: "tkhq/mine" });
    await db
      .update(contentSources)
      .set({ kinds: ["templates"] })
      .where(eq(contentSources.id, source.id));

    const outcome = await serviceFor(f).syncOnce(source.id);
    expect(await mirrored()).toHaveLength(0);
    expect(outcome?.notice).toContain("team source");
  });

  it("removes a template when its file goes", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: {
        ".valet/templates/a.yaml": templateYaml("a"),
        ".valet/templates/b.yaml": templateYaml("b"),
      },
    };
    const f = serve(repo);
    const id = await teamSource(["templates"]);
    await serviceFor(f).syncOnce(id);
    expect(await mirrored()).toHaveLength(2);

    repo.sha = "c2";
    delete repo.files[".valet/templates/a.yaml"];
    await serviceFor(f).syncOnce(id);
    expect((await mirrored()).map((r) => r.templateId)).toEqual(["b"]);
  });
});
