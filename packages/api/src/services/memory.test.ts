import { describe, expect, it, beforeEach } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { addMember, createTeam, removeMember } from "./teams.js";
import { parseConcept } from "../lib/okf.js";
import {
  importFiles,
  linksForFile,
  listFiles,
  moveFile,
  patchFile,
  readFile,
  removeFile,
  searchFiles,
  writeFile,
  type MemoryScope,
} from "./memory.js";

async function seedUser(db: AppDb, id: string, orgId: string) {
  await db.insert(users).values({ id, email: `${id}@x.test`, name: id, role: "member" });
  await db.insert(orgMembers).values({ orgId, userId: id, role: "member" });
}

describe("memory service", () => {
  let db: AppDb;
  const orgId = "org1";

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    await db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() });
    await seedUser(db, "u1", orgId);
    await seedUser(db, "u2", orgId);
  });

  function scopeFor(userId: string): MemoryScope {
    return { owner: { type: "user", id: userId }, actorUserId: userId };
  }

  describe("write / read", () => {
    it("creates a file and reads it back rendered", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/a.md", content: "# Alpha\n\nSome content.\n" });

      const result = await readFile(db, scope, "notes/a.md");
      expect(result.kind).toBe("file");
      if (result.kind !== "file") throw new Error("expected file");
      expect(result.file.title).toBe("Alpha");
      expect(result.rendered).toContain("Some content.");
      expect(result.rendered).toContain('type: "note"');
    });

    it("rejects create without content", async () => {
      const scope = scopeFor("u1");
      await expect(writeFile(db, scope, { path: "notes/a.md" })).rejects.toThrow(/does not exist/);
    });

    it("rejects an explicit empty-string content", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/a.md", content: "body\n" });
      await expect(writeFile(db, scope, { path: "notes/a.md", content: "" })).rejects.toThrow(/removeFile/);
    });

    it("metadata-only update (omitted content) leaves the body unchanged", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/a.md", content: "original body\n" });
      const { file } = await writeFile(db, scope, { path: "notes/a.md", description: "now described" });
      expect(file.content).toBe("original body\n");
      expect(file.description).toBe("now described");
      expect(file.version).toBe(2);
    });

    it("agent round-trip law: write(read(x)) is a no-op", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, {
        path: "notes/roundtrip.md",
        content: "# Roundtrip\n\nBody content here.\n",
        description: "a description",
        tags: ["a", "b"],
      });
      const first = await readFile(db, scope, "notes/roundtrip.md");
      if (first.kind !== "file") throw new Error("expected file");

      // Simulate the agent reading the rendered doc and writing it back
      // verbatim (echoing the frontmatter it just read). A write always
      // bumps updated_at/version (no dedup-on-identical-write this phase —
      // that's an import-only semantic), so we compare content/metadata,
      // not raw bytes including the timestamp.
      const second = await writeFile(db, scope, { path: "notes/roundtrip.md", content: first.rendered });
      const after = await readFile(db, scope, "notes/roundtrip.md");
      if (after.kind !== "file") throw new Error("expected file");

      expect(after.file.content).toBe(first.file.content);
      expect(after.file.title).toBe(first.file.title);
      expect(after.file.description).toBe(first.file.description);
      expect(after.file.tags).toBe(first.file.tags);
      expect(second.file.version).toBe(first.file.version + 1);

      const beforeParsed = parseConcept(first.rendered);
      const afterParsed = parseConcept(after.rendered);
      expect(afterParsed.type).toBe(beforeParsed.type);
      expect(afterParsed.title).toBe(beforeParsed.title);
      expect(afterParsed.description).toBe(beforeParsed.description);
      expect(afterParsed.tags).toEqual(beforeParsed.tags);
      expect(afterParsed.body).toBe(beforeParsed.body);
    });
  });

  describe("patchFile", () => {
    it("replaces an exact substring in the body", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/p.md", content: "hello world\n" });
      await patchFile(db, scope, { path: "notes/p.md", oldString: "world", newString: "there" });
      const result = await readFile(db, scope, "notes/p.md");
      if (result.kind !== "file") throw new Error("expected file");
      expect(result.file.content).toBe("hello there\n");
    });

    it("creates a patch-created file when oldString is empty and the file doesn't exist", async () => {
      const scope = scopeFor("u1");
      await patchFile(db, scope, { path: "journal/2026-07-13.md", oldString: "", newString: "new entry\n" });
      const result = await readFile(db, scope, "journal/2026-07-13.md");
      if (result.kind !== "file") throw new Error("expected file");
      expect(result.file.content).toBe("new entry\n");
      expect(result.file.type).toBe("journal-entry");
    });

    it("rejects when oldString isn't found", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/p.md", content: "hello world\n" });
      await expect(
        patchFile(db, scope, { path: "notes/p.md", oldString: "nope", newString: "x" }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("removeFile", () => {
    it("deletes the file and its FTS row", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/gone.md", content: "searchable content\n" });
      await removeFile(db, scope, "notes/gone.md");
      await expect(readFile(db, scope, "notes/gone.md")).rejects.toThrow(/not found/i);
      const results = await searchFiles(db, scope, { query: "searchable" });
      expect(results).toHaveLength(0);
    });
  });

  describe("owner-tuple isolation", () => {
    it("two owners can write the same path without colliding", async () => {
      const s1 = scopeFor("u1");
      const s2 = scopeFor("u2");
      await writeFile(db, s1, { path: "notes/shared-name.md", content: "u1 content\n" });
      await writeFile(db, s2, { path: "notes/shared-name.md", content: "u2 content\n" });

      const r1 = await readFile(db, s1, "notes/shared-name.md");
      const r2 = await readFile(db, s2, "notes/shared-name.md");
      if (r1.kind !== "file" || r2.kind !== "file") throw new Error("expected files");
      expect(r1.file.content).toBe("u1 content\n");
      expect(r2.file.content).toBe("u2 content\n");
    });
  });

  describe("read-union (team scoping, decision 14)", () => {
    it("a user sees their own files plus team files under a team:{id}/ virtual prefix", async () => {
      const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u2" });
      await addMember(db, { teamId: team.id, userId: "u1", role: "member" });

      const teamScope: MemoryScope = { owner: { type: "team", id: team.id }, actorUserId: "u2" };
      await writeFile(db, teamScope, { path: "notes/team-doc.md", content: "team content\n" });

      const userScope = scopeFor("u1");
      await writeFile(db, userScope, { path: "notes/mine.md", content: "personal content\n" });

      const files = await listFiles(db, userScope);
      const paths = files.map((f) => f.path);
      expect(paths).toContain("notes/mine.md");
      expect(paths).toContain(`team:${team.id}/notes/team-doc.md`);

      const readBack = await readFile(db, userScope, `team:${team.id}/notes/team-doc.md`);
      if (readBack.kind !== "file") throw new Error("expected file");
      expect(readBack.file.content).toBe("team content\n");
    });

    it("loses team read access immediately after removal from the team", async () => {
      const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u2" });
      await addMember(db, { teamId: team.id, userId: "u1", role: "member" });

      const teamScope: MemoryScope = { owner: { type: "team", id: team.id }, actorUserId: "u2" };
      await writeFile(db, teamScope, { path: "notes/team-doc.md", content: "team content\n" });

      const userScope = scopeFor("u1");
      expect((await listFiles(db, userScope)).map((f) => f.path)).toContain(`team:${team.id}/notes/team-doc.md`);

      await removeMember(db, { teamId: team.id, userId: "u1" });

      expect((await listFiles(db, userScope)).map((f) => f.path)).not.toContain(
        `team:${team.id}/notes/team-doc.md`,
      );
      await expect(readFile(db, userScope, `team:${team.id}/notes/team-doc.md`)).rejects.toThrow(/not found/i);
    });

    it("a team scope never reads a member's personal scope", async () => {
      const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u1" });
      await writeFile(db, scopeFor("u1"), { path: "notes/personal.md", content: "personal\n" });

      const teamScope: MemoryScope = { owner: { type: "team", id: team.id }, actorUserId: "u1" };
      const files = await listFiles(db, teamScope);
      expect(files.map((f) => f.path)).not.toContain("notes/personal.md");
      await expect(readFile(db, teamScope, "notes/personal.md")).rejects.toThrow(/not found/i);
    });

    it("writes never cross scope — a user cannot write under a team: virtual path", async () => {
      const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u2" });
      await addMember(db, { teamId: team.id, userId: "u1", role: "member" });
      const userScope = scopeFor("u1");
      await expect(
        writeFile(db, userScope, { path: `team:${team.id}/notes/x.md`, content: "nope\n" }),
      ).rejects.toThrow();
    });
  });

  describe("FTS search", () => {
    it("ranks title/description matches above body-only matches per bm25 weights", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, {
        path: "notes/exact-title.md",
        content: "# Kubernetes\n\nUnrelated body text about other things.\n",
      });
      await writeFile(db, scope, {
        path: "notes/body-mention.md",
        content: "# Something Else\n\nThis mentions kubernetes once, in passing.\n",
      });

      const results = await searchFiles(db, scope, { query: "kubernetes" });
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].path).toBe("notes/exact-title.md");
    });

    it("excludes expired rows", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, {
        path: "notes/fresh.md",
        content: "widget documentation\n",
      });
      await writeFile(db, scope, {
        path: "notes/stale.md",
        content: "widget documentation but expired\n",
        expires: Date.now() - 1000,
      });

      const results = await searchFiles(db, scope, { query: "widget" });
      expect(results.map((r) => r.path)).toContain("notes/fresh.md");
      expect(results.map((r) => r.path)).not.toContain("notes/stale.md");
    });

    it("search results from team scopes carry the virtual team:{id}/ prefix", async () => {
      const team = await createTeam(db, { orgId, name: "Platform", creatorUserId: "u2" });
      await addMember(db, { teamId: team.id, userId: "u1", role: "member" });
      const teamScope: MemoryScope = { owner: { type: "team", id: team.id }, actorUserId: "u2" };
      await writeFile(db, teamScope, { path: "notes/findme.md", content: "uniquesearchterm content\n" });

      const results = await searchFiles(db, scopeFor("u1"), { query: "uniquesearchterm" });
      expect(results.map((r) => r.path)).toContain(`team:${team.id}/notes/findme.md`);
    });

    it("tolerates syntactically odd input (unbalanced quote) instead of throwing — websearch_to_tsquery parses it as a literal term", async () => {
      // Under fts5, an unbalanced quote raised a raw SqliteError that this
      // service mapped to ValidationError. Postgres's websearch_to_tsquery
      // is deliberately forgiving of "web search" syntax (spec decision 9)
      // and never raises a syntax error for input like this — it just
      // degrades to treating it as a literal search term. The
      // invalid-query -> ValidationError path stays in the implementation as
      // a defensive backstop, but this specific input no longer exercises it.
      const scope = scopeFor("u1");
      await expect(searchFiles(db, scope, { query: '"foo' })).resolves.not.toThrow();
    });
  });

  describe("moveFile", () => {
    it("moves a file and rewrites inbound links in referencing files", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "people/alice.md", content: "# Alice\n\nFacts about Alice.\n" });
      await writeFile(db, scope, {
        path: "journal/2026-08-19.md",
        content: "Met [Alice](/people/alice.md) and [Alice again](../people/alice.md).\n",
      });
      await writeFile(db, scope, { path: "notes/unrelated.md", content: "No links here.\n" });

      const result = await moveFile(db, scope, { from: "people/alice.md", to: "people/alice-smith.md" });
      expect(result.file.path).toBe("people/alice-smith.md");
      expect(result.referencersUpdated).toEqual(["journal/2026-08-19.md"]);

      const journal = await readFile(db, scope, "journal/2026-08-19.md");
      if (journal.kind !== "file") throw new Error("expected file");
      expect(journal.file.content).toBe(
        "Met [Alice](/people/alice-smith.md) and [Alice again](/people/alice-smith.md).\n",
      );
      // Referencer version bumped by the rewrite.
      expect(journal.file.version).toBe(2);

      await expect(readFile(db, scope, "people/alice.md")).rejects.toThrow(/not found|memory file/i);
    });

    it("keeps type and pin state, bumps version, and warns when the new directory implies a different type", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "people/carol.md", content: "# Carol\n", pinned: true });

      const result = await moveFile(db, scope, { from: "people/carol.md", to: "workflows/carol.md" });
      expect(result.file.type).toBe("person");
      expect(result.file.pinned).toBe(true);
      expect(result.file.version).toBe(2);
      expect(result.warnings.join(" ")).toContain("type remains 'person'");
    });

    it("recomputes a basename-derived title for the new path", async () => {
      const scope = scopeFor("u1");
      // No H1: title falls back to the basename, so it must follow the move.
      await writeFile(db, scope, { path: "notes/old-name.md", content: "plain body, no heading\n" });
      const result = await moveFile(db, scope, { from: "notes/old-name.md", to: "notes/new-name.md" });
      expect(result.file.title).toBe("new-name");
    });

    it("roots the moved file's own relative links so they still resolve after a cross-directory move", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "projects/valet/bar.md", content: "# Bar\n" });
      await writeFile(db, scope, {
        path: "projects/valet/hub.md",
        content: "# Hub\n\nsee [bar](bar.md) and [rooted](/projects/valet/bar.md)\n",
      });

      const result = await moveFile(db, scope, { from: "projects/valet/hub.md", to: "notes/hub.md" });
      expect(result.ownLinksRewritten).toBe(true);
      expect(result.file.content).toBe("# Hub\n\nsee [bar](/projects/valet/bar.md) and [rooted](/projects/valet/bar.md)\n");

      // The rooted links still resolve to the original target.
      const links = await linksForFile(db, scope, "notes/hub.md");
      expect(links.outbound).toEqual([{ path: "projects/valet/bar.md", title: "Bar", type: "project-note" }]);
    });

    it("does not warn on a same-directory rename of an explicitly-typed file", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/x.md", content: "# X\n", type: "workflow" });
      const result = await moveFile(db, scope, { from: "notes/x.md", to: "notes/y.md" });
      expect(result.warnings).toEqual([]);
      expect(result.file.type).toBe("workflow");
    });

    it("keeps a curated title that the content cannot reproduce", async () => {
      const scope = scopeFor("u1");
      await importFiles(db, scope, {
        files: { "notes/q3.md": "---\ntitle: Quarterly Planning Notes\n---\nplain body, no heading\n" },
        trusted: false,
      });
      const before = await readFile(db, scope, "notes/q3.md");
      if (before.kind !== "file") throw new Error("expected file");
      expect(before.file.title).toBe("Quarterly Planning Notes");

      const result = await moveFile(db, scope, { from: "notes/q3.md", to: "projects/planning/q3.md" });
      expect(result.file.title).toBe("Quarterly Planning Notes");
    });

    it("refuses a missing source, an occupied destination, and a same-path move", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/a.md", content: "a\n" });
      await writeFile(db, scope, { path: "notes/b.md", content: "b\n" });

      await expect(moveFile(db, scope, { from: "notes/missing.md", to: "notes/x.md" })).rejects.toThrow(/not found/i);
      await expect(moveFile(db, scope, { from: "notes/a.md", to: "notes/b.md" })).rejects.toThrow(/already exists/);
      await expect(moveFile(db, scope, { from: "notes/a.md", to: "notes/a.md" })).rejects.toThrow(/same path/);
    });

    it("never rewrites links in another scope's files", async () => {
      await writeFile(db, scopeFor("u1"), { path: "notes/target.md", content: "# Target\n" });
      await writeFile(db, scopeFor("u2"), {
        path: "notes/ref.md",
        content: "[t](/notes/target.md)\n",
      });

      await moveFile(db, scopeFor("u1"), { from: "notes/target.md", to: "notes/moved.md" });
      const other = await readFile(db, scopeFor("u2"), "notes/ref.md");
      if (other.kind !== "file") throw new Error("expected file");
      expect(other.file.content).toBe("[t](/notes/target.md)\n");
    });
  });

  describe("linksForFile", () => {
    it("reports outbound edges (phantoms included) and inbound edges", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, {
        path: "projects/valet/overview.md",
        content: "# Overview\n\nSee [Alice](/people/alice.md) and [missing](/notes/missing.md).\n",
      });
      await writeFile(db, scope, { path: "people/alice.md", content: "# Alice\n" });
      await writeFile(db, scope, {
        path: "journal/2026-08-19.md",
        content: "Worked on [overview](/projects/valet/overview.md).\n",
      });

      const result = await linksForFile(db, scope, "projects/valet/overview.md");
      expect(result.outbound).toEqual([
        { path: "people/alice.md", title: "Alice", type: "person" },
        { path: "notes/missing.md", title: "", type: "", phantom: true },
      ]);
      expect(result.inbound).toEqual([
        { path: "journal/2026-08-19.md", title: "2026-08-19", type: "journal-entry" },
      ]);
    });

    it("tolerates extension drift on both directions", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/a.md", content: "[b](/notes/b)\n" });
      await writeFile(db, scope, { path: "notes/b.md", content: "# B\n" });

      const a = await linksForFile(db, scope, "notes/a.md");
      expect(a.outbound.map((e) => e.path)).toEqual(["notes/b.md"]);
      const b = await linksForFile(db, scope, "notes/b.md");
      expect(b.inbound.map((e) => e.path)).toEqual(["notes/a.md"]);
    });

    it("throws NotFound for a path with no file behind it", async () => {
      await expect(linksForFile(db, scopeFor("u1"), "notes/nope.md")).rejects.toThrow(/not found/i);
    });

    it("dedups outbound edges when two spellings resolve to the same file", async () => {
      const scope = scopeFor("u1");
      await writeFile(db, scope, { path: "notes/foo.md", content: "# Foo\n" });
      await writeFile(db, scope, { path: "notes/hub.md", content: "[a](/notes/foo) and [b](/notes/foo.md)\n" });

      const result = await linksForFile(db, scope, "notes/hub.md");
      expect(result.outbound).toEqual([{ path: "notes/foo.md", title: "Foo", type: "note" }]);
    });

    it("rejects a team: virtual path with a message that names the reason", async () => {
      await expect(linksForFile(db, scopeFor("u1"), "team:t1/notes/x.md")).rejects.toThrow(/own files only/);
    });
  });
});
