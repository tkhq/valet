/**
 * Snapshot assembly (Phase 4 decision 18): the Principles section, pinned
 * files + 3 most recent journal files + the virtual root index, own-scope
 * only, budget truncation with a note.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { writeFile, type MemoryScope } from "../services/memory.js";
import { memoryUsageRecorder, readMemoryUsage } from "../services/memory-usage.js";
import { teamMembers, teams } from "../schema/index.js";
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
    // An empty brain starts with the built-in principles.
    expect(empty).toContain("- principles/prove-it-works.md — Show evidence before you say work is done (built in)");

    await writeFile(db, scope, {
      path: "principles/prove-it-works.md",
      content: "# Prove it works\n\nRun the real app before you say done.\n",
      description: "Before you report a change as done",
    });
    await writeFile(db, scope, { path: "notes/other.md", content: "# Other\n\nNot a principle.\n" });

    const snapshot = await assembleMemorySnapshot(db, scope);
    expect(snapshot).toMatch(/- principles\/prove-it-works\.md — .*: Before you report a change as done/);
    // The own file replaces the built-in principle at the same path.
    expect(snapshot).not.toContain("Show evidence before you say work is done (built in)");
    // The index carries no bodies; the model reads one with mem_read.
    expect(snapshot).not.toContain("Run the real app before you say done.");
  });

  it("records an injection for each file and principle line it puts in the prompt", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await db.insert(teams).values({ id: "t1", orgId: "local-org", name: "T1", createdAt: Date.now() });
    await db.insert(teamMembers).values({ teamId: "t1", userId: "local-user", role: "member" });
    const teamScope: MemoryScope = { owner: { type: "team", id: "t1" }, actorUserId: "local-user" };
    await writeFile(db, scope, { path: "preferences/style.md", content: "# Style\n", pinned: true });
    await writeFile(db, scope, { path: "journal/2026-10-30.md", content: "# Today\n", type: "journal-entry" });
    await writeFile(db, scope, { path: "principles/prove-it-works.md", content: "# Prove it works\n" });
    await writeFile(db, scope, { path: "notes/unused.md", content: "# Unused\n" });
    await writeFile(db, teamScope, { path: "principles/ship-small.md", content: "# Ship small\n" });

    await assembleMemorySnapshot(db, scope);
    await memoryUsageRecorder(db).flush();

    const own = await readMemoryUsage(db, scope);
    expect(own.get("preferences/style.md")).toMatchObject({ injectCount: 1, readCount: 0 });
    expect(own.get("journal/2026-10-30.md")).toMatchObject({ injectCount: 1 });
    expect(own.get("principles/prove-it-works.md")).toMatchObject({ injectCount: 1 });
    expect(own.has("notes/unused.md")).toBe(false);
    // A team principle in the index counts against the team's file.
    const team = await readMemoryUsage(db, teamScope);
    expect(team.get("principles/ship-small.md")).toMatchObject({ injectCount: 1 });
  });

  it("records no injection for a pinned file the budget drops", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await writeFile(db, scope, { path: "preferences/big.md", content: `# Big\n\n${"x".repeat(5_000)}\n`, pinned: true });

    await assembleMemorySnapshot(db, scope, { budgetChars: 3_000 });
    await memoryUsageRecorder(db).flush();

    expect((await readMemoryUsage(db, scope)).has("preferences/big.md")).toBe(false);
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
