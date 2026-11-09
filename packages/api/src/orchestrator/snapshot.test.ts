/**
 * Snapshot assembly (Phase 4 decision 18): the Principles section, pinned
 * files and the memory index, own-scope only, budget truncation with a
 * note.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { writeFile, type MemoryScope } from "../services/memory.js";
import { memoryUsageRecorder, readMemoryUsage } from "../services/memory-usage.js";
import { teamMembers, teams } from "../schema/index.js";
import { assembleMemorySnapshot, DEFAULT_SNAPSHOT_BUDGET_CHARS, memoryIndexLines } from "./snapshot.js";
import type { MemoryFileSummary } from "../services/memory.js";
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

  it("indexes every file with its description and collapses journals to one line", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    for (const day of ["01", "02", "03"]) {
      await writeFile(db, scope, { path: `journal/2026-07-${day}.md`, content: `# ${day}\n\nEntry ${day}.\n`, type: "journal-entry" });
    }
    await writeFile(db, scope, { path: "projects/valet/overview.md", content: "# Overview\n\nBody text.\n", description: "What Valet is and who works on it" });
    await writeFile(db, scope, { path: "people/ada.md", content: "# Ada\n" });
    await writeFile(db, scope, { path: "notes/old-plan.md", content: "# Old\n", description: "A plan that ended", expires: 1 });

    const snapshot = await assembleMemorySnapshot(db, scope);

    expect(snapshot).toContain("## Memory index");
    expect(snapshot).toContain("- projects/valet/overview.md: What Valet is and who works on it");
    expect(snapshot).toContain("- people/ada.md");
    expect(snapshot).toContain("- journal/ (3 files: journal/2026-07-01.md … journal/2026-07-03.md). Find them with mem_search.");
    // Bodies stay out: the model reads a file with mem_read.
    expect(snapshot).not.toContain("Entry 03.");
    expect(snapshot).not.toContain("Body text.");
    // An expired file is stale.
    expect(snapshot).not.toContain("notes/old-plan.md");
  });

  it("is own-scope only: a team file the user can read is not injected into their snapshot", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const teamScope: MemoryScope = { owner: { type: "team", id: "eng" }, actorUserId: "local-user" };
    await writeFile(db, teamScope, { path: "notes/team-secret.md", content: "# Team secret\n\nTeam-only content.\n", pinned: true });

    const snapshot = await assembleMemorySnapshot(db, scope);
    expect(snapshot).not.toContain("Team-only content.");
  });

  it("drops the oldest pinned file first and appends a truncation note when over budget", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const big = "x".repeat(2000);
    await writeFile(db, scope, { path: "preferences/a.md", content: `# Old\n\n${big} OLDEST\n`, pinned: true });
    await writeFile(db, scope, { path: "preferences/b.md", content: `# Mid\n\n${big} MIDDLE\n`, pinned: true });
    await writeFile(db, scope, { path: "preferences/c.md", content: `# New\n\n${big} NEWEST\n`, pinned: true });

    // The Principles section is never dropped, so the budget carries it on top.
    const budgetChars = 5000 + renderPrinciplesSection([]).length;
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
    // An index line is not the file, so it counts as no injection.
    expect(own.has("journal/2026-10-30.md")).toBe(false);
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

describe("memoryIndexLines", () => {
  const file = (path: string, updatedAt: number, extra: Partial<MemoryFileSummary> = {}): MemoryFileSummary => ({
    path, updatedAt, title: path, description: `About ${path}`, type: "note", pinned: false, expires: null,
    key: { ownerType: "user", ownerId: "u", namespace: "", path },
    ...extra,
  });

  it("keeps the newest files under the cap, lists them in path order, and counts the rest", () => {
    const files = [file("b.md", 3), file("a.md", 2), file("c.md", 1), file("principles/rule.md", 9), file("pinned.md", 9, { pinned: true })];
    expect(memoryIndexLines(files, { now: 10, maxLines: 2 })).toEqual([
      "- a.md: About a.md",
      "- b.md: About b.md",
      "- 1 older file not listed. Find them with mem_search.",
    ]);
  });

  it("shortens a long description", () => {
    const [line] = memoryIndexLines([file("long.md", 1, { description: "word ".repeat(60) })], { now: 10 });
    expect(line.length).toBeLessThan(160);
    expect(line.endsWith("…")).toBe(true);
  });
});
