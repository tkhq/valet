/**
 * Snapshot assembly (Phase 4 decision 18): the Principles section, pinned
 * files + 3 most recent journal files + the virtual root index, own-scope
 * only, budget truncation with a note.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { writeFile, type MemoryScope } from "../services/memory.js";
import { assembleMemorySnapshot, DEFAULT_SNAPSHOT_BUDGET_CHARS } from "./snapshot.js";
import { renderPrinciplesSection } from "./principles.js";

let api: TestApi;

afterEach(async () => {
  await api?.cleanup();
});

const scope: MemoryScope = { owner: { type: "user", id: "local-user" }, actorUserId: "local-user" };

describe("assembleMemorySnapshot", () => {
  it("returns a minimal snapshot (header + empty index) for empty memory", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const snapshot = await assembleMemorySnapshot(db, scope);
    expect(snapshot).toContain("Memory snapshot");
    expect(snapshot).toMatch(/snapshot built \d{4}-\d{2}-\d{2} UTC \(the date the snapshot was built, not the current date\)/);
    expect(snapshot).toContain("user:local-user");
    expect(snapshot.length).toBeLessThan(DEFAULT_SNAPSHOT_BUDGET_CHARS);
  });

  it("includes full rendered pinned files, in path order", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await writeFile(db, scope, { path: "preferences/z-style.md", content: "# Z style\n\nZ body.\n", pinned: true });
    await writeFile(db, scope, { path: "preferences/a-style.md", content: "# A style\n\nA body.\n", pinned: true });
    await writeFile(db, scope, { path: "notes/unpinned.md", content: "# Unpinned\n\nShould not appear.\n" });

    const snapshot = await assembleMemorySnapshot(db, scope);

    expect(snapshot).toContain("A body.");
    expect(snapshot).toContain("Z body.");
    expect(snapshot).not.toContain("Should not appear.");
    expect(snapshot.indexOf("preferences/a-style.md")).toBeLessThan(snapshot.indexOf("preferences/z-style.md"));
  });

  it("includes only the 3 most recent journal files", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    for (const day of ["01", "02", "03", "04", "05"]) {
      await writeFile(db, scope, { path: `journal/2026-07-${day}.md`, content: `# ${day}\n\nEntry ${day}.\n`, type: "journal-entry" });
    }

    const snapshot = await assembleMemorySnapshot(db, scope);

    expect(snapshot).toContain("Entry 05.");
    expect(snapshot).toContain("Entry 04.");
    expect(snapshot).toContain("Entry 03.");
    expect(snapshot).not.toContain("Entry 02.");
    expect(snapshot).not.toContain("Entry 01.");
  });

  it("includes the virtual root index", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await writeFile(db, scope, { path: "projects/valet/overview.md", content: "# Overview\n" });

    const snapshot = await assembleMemorySnapshot(db, scope);
    expect(snapshot).toContain("projects");
  });

  it("is own-scope only: a team file the user can read is not injected into their snapshot", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const teamScope: MemoryScope = { owner: { type: "team", id: "eng" }, actorUserId: "local-user" };
    await writeFile(db, teamScope, { path: "notes/team-secret.md", content: "# Team secret\n\nTeam-only content.\n", pinned: true });

    const snapshot = await assembleMemorySnapshot(db, scope);
    expect(snapshot).not.toContain("Team-only content.");
  });

  it("truncates oldest-first and appends a truncation note when over budget", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const big = "x".repeat(2000);
    await writeFile(db, scope, { path: "journal/2026-07-01.md", content: `# Old\n\n${big} OLDEST\n`, type: "journal-entry" });
    await writeFile(db, scope, { path: "journal/2026-07-02.md", content: `# Mid\n\n${big} MIDDLE\n`, type: "journal-entry" });
    await writeFile(db, scope, { path: "journal/2026-07-03.md", content: `# New\n\n${big} NEWEST\n`, type: "journal-entry" });

    // The Principles section is never dropped, so the budget carries it on top.
    const budgetChars = 3000 + renderPrinciplesSection([]).length;
    const snapshot = await assembleMemorySnapshot(db, scope, { budgetChars });

    expect(snapshot.length).toBeLessThanOrEqual(budgetChars + 500); // note itself adds a little over budget, bounded
    expect(snapshot).toContain("NEWEST");
    expect(snapshot).not.toContain("OLDEST");
    expect(snapshot).toContain("truncated");
  });

  it("always carries the Principles section: the base principle, then the principle index", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const empty = await assembleMemorySnapshot(db, scope);
    expect(empty).toContain("## Principles");
    expect(empty).toContain("learn-from-the-org (built in)");
    expect(empty).toContain("No principles yet.");

    await writeFile(db, scope, {
      path: "principles/prove-it-works.md",
      content: "# Prove it works\n\nRun the real app before you say done.\n",
      description: "Before you report a change as done",
    });
    await writeFile(db, scope, { path: "notes/other.md", content: "# Other\n\nNot a principle.\n" });

    const snapshot = await assembleMemorySnapshot(db, scope);
    expect(snapshot).toMatch(/- principles\/prove-it-works\.md — .*: Before you report a change as done/);
    expect(snapshot).not.toContain("No principles yet.");
    // The index carries no bodies; the model reads one with mem_read.
    expect(snapshot).not.toContain("Run the real app before you say done.");
  });

  it("keeps the Principles section when the budget drops pinned files", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await writeFile(db, scope, { path: "preferences/big.md", content: `# Big\n\n${"x".repeat(5_000)}\n`, pinned: true });
    const snapshot = await assembleMemorySnapshot(db, scope, { budgetChars: 3_000 });
    expect(snapshot).toContain("truncated");
    expect(snapshot).toContain("learn-from-the-org (built in)");
  });
});
