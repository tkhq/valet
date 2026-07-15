import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ValidationError } from "@valet/shared";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { orgMembers, orgs, users } from "../schema/index.js";
import { addMember, createTeam, removeMember } from "./teams.js";
import { parseConcept } from "../lib/okf.js";
import { listFiles, patchFile, readFile, removeFile, searchFiles, writeFile, type MemoryScope } from "./memory.js";

function seedUser(db: AppDb, id: string, orgId: string) {
  db.insert(users)
    .values({ id, email: `${id}@x.test`, name: id, role: "member" })
    .run();
  db.insert(orgMembers).values({ orgId, userId: id, role: "member" }).run();
}

describe("memory service", () => {
  let sqlite: Database.Database;
  let db: AppDb;
  const orgId = "org1";

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    applyAppMigrations(sqlite);
    db = buildAppDb(sqlite);
    db.insert(orgs).values({ id: orgId, name: "Org", createdAt: Date.now() }).run();
    seedUser(db, "u1", orgId);
    seedUser(db, "u2", orgId);
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

    it("rejects a malformed FTS5 query (unbalanced quote) with ValidationError instead of throwing raw SqliteError", async () => {
      const scope = scopeFor("u1");
      await expect(searchFiles(db, scope, { query: '"foo' })).rejects.toThrow(ValidationError);
    });
  });
});
