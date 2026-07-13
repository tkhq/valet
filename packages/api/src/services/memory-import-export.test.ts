import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyAppMigrations, buildAppDb, type AppDb } from "../lib/drizzle.js";
import { orgs, users } from "../schema/index.js";
import { exportFiles, importFiles, readFile, searchFiles, writeFile, type MemoryScope } from "./memory.js";

function seedUser(db: AppDb, id: string, orgId: string) {
  db.insert(users)
    .values({ id, email: `${id}@x.test`, name: id, role: "member", createdAt: Date.now() })
    .run();
}

describe("memory import/export", () => {
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

  it("export→import→export identity: a trusted round-trip into a fresh scope reproduces the manifest", async () => {
    const source = scopeFor("u1");
    await writeFile(db, source, {
      path: "preferences/style.md",
      content: "# Style\n\nUse tabs.\n",
      description: "coding style prefs",
      tags: ["style", "prefs"],
      sensitivity: "shareable",
      origin: "user-stated",
    });
    await writeFile(db, source, {
      path: "projects/valet/overview.md",
      content: "# Valet\n\nAn overview.\n",
    });
    await writeFile(db, source, {
      path: "journal/2026-07-10.md",
      content: "# Journal\n\nDid stuff.\n",
    });

    const manifestA = await exportFiles(db, source);

    const target = scopeFor("u2");
    const importFilesInput: Record<string, string> = {};
    for (const [path, entry] of Object.entries(manifestA)) {
      if (path.endsWith("index.md")) continue; // index.md is regenerated, never imported
      importFilesInput[path] = entry.content;
    }
    const importResult = await importFiles(db, target, { files: importFilesInput, trusted: true });
    expect(importResult.skipped).toHaveLength(0);

    const manifestB = await exportFiles(db, target);

    // Same set of concept files (ignoring generated index.md entries, whose
    // content is scope/path-independent anyway and thus trivially equal).
    const conceptsA = Object.keys(manifestA).filter((p) => !p.endsWith("index.md"));
    for (const path of conceptsA) {
      expect(manifestB[path]).toBeDefined();
      expect(manifestB[path].hash).toBe(manifestA[path].hash);
      expect(manifestB[path].content).toBe(manifestA[path].content);
    }
  });

  it("collisions: two source paths normalizing to the same stored path are skipped after the first", async () => {
    const scope = scopeFor("u1");
    const result = await importFiles(db, scope, {
      files: {
        "notes/a.md": "# A\n\nfirst\n",
        "notes//a.md": "# A2\n\nsecond\n",
      },
      trusted: true,
    });
    expect(result.imported).toEqual(["notes/a.md"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/collision/);
  });

  it("index.md entries are skipped on import", async () => {
    const scope = scopeFor("u1");
    const result = await importFiles(db, scope, {
      files: {
        "index.md": "# Root index\n\n* [a](/a.md)\n",
        "notes/index.md": "# Notes index\n",
        "notes/real.md": "# Real\n\nbody\n",
      },
      trusted: true,
    });
    expect(result.imported).toEqual(["notes/real.md"]);
    expect(result.skipped.map((s) => s.path)).toEqual(["index.md", "notes/index.md"]);
  });

  it("preserves unknown extras keys through import→export", async () => {
    const scope = scopeFor("u1");
    const doc = [
      "---",
      'type: "note"',
      'confidence: "0.90"',
      'flag: "NO"',
      "---",
      "",
      "body content",
      "",
    ].join("\n");
    await importFiles(db, scope, { files: { "notes/extras.md": doc }, trusted: true });

    const read = await readFile(db, scope, "notes/extras.md");
    if (read.kind !== "file") throw new Error("expected file");
    expect(read.rendered).toContain('confidence: "0.90"');
    expect(read.rendered).toContain('flag: "NO"');

    const manifest = await exportFiles(db, scope);
    expect(manifest["notes/extras.md"].content).toContain('confidence: "0.90"');
    expect(manifest["notes/extras.md"].content).toContain('flag: "NO"');
  });

  it("untrusted (foreign) import forces sensitivity: private and origin: imported", async () => {
    const scope = scopeFor("u1");
    const doc = ["---", 'type: "note"', "valet:", '  sensitivity: "shareable"', '  origin: "user-stated"', "---", "", "b"].join(
      "\n",
    );
    await importFiles(db, scope, { files: { "notes/foreign.md": doc }, trusted: false });
    const read = await readFile(db, scope, "notes/foreign.md");
    if (read.kind !== "file") throw new Error("expected file");
    expect(read.file.sensitivity).toBe("private");
    expect(read.file.origin).toBe("imported");
  });

  it("untrusted import ignores an embedded valet.expires (even in the past) and leaves expires NULL", async () => {
    const scope = scopeFor("u1");
    const doc = [
      "---",
      'type: "note"',
      "valet:",
      '  expires: "2000-01-01T00:00:00.000Z"',
      "---",
      "",
      "content that should never expire since the import is untrusted",
    ].join("\n");
    await importFiles(db, scope, { files: { "notes/untrusted-expires.md": doc }, trusted: false });

    const read = await readFile(db, scope, "notes/untrusted-expires.md");
    if (read.kind !== "file") throw new Error("expected file");
    expect(read.file.expires).toBeNull();

    const results = await searchFiles(db, scope, { query: "untrusted" });
    expect(results.map((r) => r.path)).toContain("notes/untrusted-expires.md");
  });

  it("remaps lib/ and reserved basenames instead of rejecting, and reports the remap", async () => {
    const scope = scopeFor("u1");
    const result = await importFiles(db, scope, {
      files: {
        "lib/shared.md": "# Shared\n\nbody\n",
        "notes/log.md": "# Log\n\nentries\n",
      },
      trusted: true,
    });
    expect(result.imported.sort()).toEqual(["imported-lib/shared.md", "notes/log-imported.md"]);
    expect(result.remapped).toEqual(
      expect.arrayContaining([
        { from: "lib/shared.md", to: "imported-lib/shared.md" },
        { from: "notes/log.md", to: "notes/log-imported.md" },
      ]),
    );
  });
});
