/**
 * The memory collector, driven through `syncOnce`.
 *
 * The case that carries the design is the last one: a mirrored memory is
 * read-only because it lands under `lib/`, which `assertWritablePath` already
 * reserves. If that stops being true, the mirror becomes a store the agent can
 * overwrite and the next sync silently reverts.
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
import { contentSources, memoryFiles, orgMembers, orgs, users } from "../../schema/index.js";
import { createContentSource } from "../content-sources.js";
import { GitHubSkillRepoReader } from "../skill-repo-reader.js";
import { writeFile } from "../memory.js";
import { ContentSyncService } from "./service.js";
import { MemoryCollector } from "./memory-collector.js";

const ORG = "org1";

function doc(title: string, body = "The fact."): string {
  return ["---", "type: note", `title: ${title}`, "---", "", body, ""].join("\n");
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

describe("memory collector", () => {
  let db: AppDb;

  beforeEach(async () => {
    const { appDb } = await freshTestPgDb();
    db = appDb;
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await db.insert(users).values({ id: "u1", email: "u1@x.test", name: "u1", role: "member" });
    await db.insert(orgMembers).values({ orgId: ORG, userId: "u1", role: "member" });
  });

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  function serviceFor(f: GithubFixture): ContentSyncService {
    return new ContentSyncService({
      db,
      reader: new GitHubSkillRepoReader({ apiUrl: f.url }),
      collectors: [new MemoryCollector()],
    });
  }

  /** A PERSONAL source: memories are the one kind a user source collects. */
  async function userSource(repo = "tkhq/notes"): Promise<string> {
    const source = await createContentSource(db, { userId: "u1", orgId: ORG }, { repo });
    await db
      .update(contentSources)
      .set({ kinds: ["memories"] })
      .where(eq(contentSources.id, source.id));
    return source.id;
  }

  const mirrored = () => db.select().from(memoryFiles).orderBy(memoryFiles.path);

  it("mounts a repository's memory files under lib/, owned by the source", async () => {
    const f = serve({
      sha: "c1",
      files: {
        ".valet/memory/handbook/oncall.md": doc("On-call"),
        ".valet/memory/glossary.md": doc("Glossary"),
        "README.md": "# repo\n",
      },
    });
    const id = await userSource();
    const outcome = await serviceFor(f).syncOnce(id);
    expect(outcome?.status).toBe("ok");

    const rows = await mirrored();
    expect(rows.map((r) => r.path)).toEqual(["lib/glossary.md", "lib/handbook/oncall.md"]);
    for (const row of rows) {
      expect(row.sourceId).toBe(id);
      expect(row.ownerType).toBe("user");
      expect(row.ownerId).toBe("u1");
    }
    // The document's own frontmatter survives the mount.
    expect(rows.find((r) => r.path === "lib/glossary.md")?.title).toBe("Glossary");
    expect(rows.find((r) => r.path === "lib/glossary.md")?.type).toBe("note");
  });

  it("updates on a content change and removes on a delete", async () => {
    const repo: FakeRepo = {
      sha: "c1",
      files: {
        ".valet/memory/a.md": doc("A"),
        ".valet/memory/b.md": doc("B"),
      },
    };
    const f = serve(repo);
    const id = await userSource();
    await serviceFor(f).syncOnce(id);

    repo.sha = "c2";
    repo.files[".valet/memory/a.md"] = doc("A", "The fact, revised.");
    delete repo.files[".valet/memory/b.md"];
    await serviceFor(f).syncOnce(id);

    const rows = await mirrored();
    expect(rows.map((r) => r.path)).toEqual(["lib/a.md"]);
    expect(rows[0].content).toContain("revised");
    expect(rows[0].version).toBe(2);
  });

  it("never removes a memory file the product wrote", async () => {
    const repo: FakeRepo = { sha: "c1", files: { ".valet/memory/a.md": doc("A") } };
    const f = serve(repo);
    const id = await userSource();
    await serviceFor(f).syncOnce(id);

    await writeFile(db, { owner: { type: "user", id: "u1" }, actorUserId: "u1" }, {
      path: "notes/mine.md",
      content: "# Mine\n\nWritten here.\n",
    });

    repo.sha = "c2";
    repo.files = { "README.md": "# repo\n" };
    await serviceFor(f).syncOnce(id);

    expect((await mirrored()).map((r) => r.path)).toEqual(["notes/mine.md"]);
  });

  // The whole read-only design rests on this. `lib/` is the memory
  // subsystem's own reserved namespace, so the mirror needs no guard of its
  // own, and the refusal already names what to do instead.
  it("refuses a product write to a mounted path, naming where to write instead", async () => {
    const f = serve({ sha: "c1", files: { ".valet/memory/a.md": doc("A") } });
    const id = await userSource();
    await serviceFor(f).syncOnce(id);
    expect((await mirrored()).map((r) => r.path)).toEqual(["lib/a.md"]);

    await expect(
      writeFile(db, { owner: { type: "user", id: "u1" }, actorUserId: "u1" }, {
        path: "lib/a.md",
        content: "# Overwritten\n",
      }),
    ).rejects.toThrow(/lib\/ is reserved/);

    // Unchanged, and still the repository's.
    const rows = await mirrored();
    expect(rows[0].content).toContain("The fact.");
    expect(rows[0].sourceId).toBe(id);
  });

  it("refuses a second source that mounts a path another already holds", async () => {
    const first = serve({ sha: "c1", files: { ".valet/memory/a.md": doc("A") } });
    const idOne = await userSource("tkhq/notes");
    await serviceFor(first).syncOnce(idOne);
    await fixture?.close();

    const second = serve({ sha: "d1", files: { ".valet/memory/a.md": doc("A from elsewhere") } });
    const idTwo = await userSource("tkhq/other-notes");
    const outcome = await serviceFor(second).syncOnce(idTwo);

    const rows = await mirrored();
    expect(rows).toHaveLength(1);
    // The first source keeps the path; the second reports rather than taking it.
    expect(rows[0].sourceId).toBe(idOne);
    expect(outcome?.warnings.join(" ")).toContain("another tracked repository already holds");
  });

  it("removes what it mirrored when the source goes", async () => {
    const f = serve({ sha: "c1", files: { ".valet/memory/a.md": doc("A") } });
    const id = await userSource();
    await serviceFor(f).syncOnce(id);
    await writeFile(db, { owner: { type: "user", id: "u1" }, actorUserId: "u1" }, {
      path: "notes/mine.md",
      content: "# Mine\n",
    });
    expect(await mirrored()).toHaveLength(2);

    const { deleteContentSource } = await import("../content-sources.js");
    expect(await deleteContentSource(db, { userId: "u1", orgId: ORG }, id)).toBe(true);

    // A mounted row that outlived its source could never be removed: the
    // product refuses to write `lib/`, and the sweep that owned it is gone.
    expect((await mirrored()).map((r) => r.path)).toEqual(["notes/mine.md"]);
  });
});
