// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { OwnerFilter } from "~/api/client";
import type { ArtifactListItem, MemoryTreeEntry, SkillSummary, WorkflowDefinitionSummary } from "@valet/api/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: Record<string, string> }) =>
    <a href={params ? to.replace(/\$(\w*)/g, (_, key: string) => params[key || "_splat"] ?? "") : to}>{children}</a>,
}));
vi.mock("~/components/owner-badge", () => ({ OwnerBadge: ({ ownerType }: { ownerType: string }) => ownerType === "team" ? <span>Team</span> : null }));

const ok = <T,>(data: T) => ({ data, isPending: false, isError: false, refetch: vi.fn() });
let artifacts: ArtifactListItem[] = [];
let workflows: WorkflowDefinitionSummary[] = [];
let skills: Record<string, SkillSummary[]> = {};
let memory: MemoryTreeEntry[] = [];
let owner: OwnerFilter | undefined;
let failedSkillScope: string | undefined;
const retrySkills = vi.fn();
const memoryQuery = vi.fn((_selected?: OwnerFilter) => ok({ entries: memory }));
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));
vi.mock("~/api/artifacts", () => ({ useArtifacts: () => ok({ artifacts }) }));
vi.mock("~/api/workflows", () => ({ useWorkflows: () => ok({ workflows }) }));
vi.mock("~/api/skills", () => ({ useSkills: (q: { scope: string }) => ({ ...ok({ skills: skills[q.scope] ?? [], nextCursor: null }),
  isError: q.scope === failedSkillScope, refetch: retrySkills }) }));
vi.mock("~/api/memory", () => ({ useMemoryTree: (selected?: OwnerFilter) => memoryQuery(selected) }));

import { MakePanel, newestFiles, recentMemory, workflowsForMake } from "./make-panel";

function artifact(id: string, updatedAt: number, extra: Partial<ArtifactListItem> = {}): ArtifactListItem {
  return { id, path: `${id}.md`, title: `File ${id}`, format: "markdown", icon: "", version: 1, sharedVersion: null, token: `tok-${id}`,
    url: `https://x/a/tok-${id}`, visibility: "org", actorUserId: "u1", revoked: false, createdAt: 1, updatedAt, ownerType: "user", ...extra } as ArtifactListItem;
}
function workflow(id: string, extra: Partial<WorkflowDefinitionSummary> = {}): WorkflowDefinitionSummary {
  return { id, name: `Workflow ${id}`, definition: {}, createdAt: 1, updatedAt: 10, ownerType: "user", ownerId: "u1", ...extra };
}
function run(createdAt: number, extra: Partial<NonNullable<WorkflowDefinitionSummary["latestRun"]>> = {}): NonNullable<WorkflowDefinitionSummary["latestRun"]> {
  return { runId: `r${createdAt}`, workflowId: "w", status: "settled", outcome: "completed", createdAt, updatedAt: createdAt, ...extra };
}
function note(path: string, updatedAt: number, extra: Partial<MemoryTreeEntry> = {}): MemoryTreeEntry {
  return { path, title: path, type: "note", pinned: false, updatedAt, dir: false, sizeBytes: 10, ...extra };
}

describe("MakePanel", () => {
  beforeEach(() => {
    artifacts = []; workflows = []; skills = {}; memory = []; owner = undefined; failedSkillScope = undefined;
    retrySkills.mockClear(); memoryQuery.mockClear();
  });

  it("loads memory for the workspace whose notes its links open", () => {
    owner = { ownerType: "team", ownerId: "team-ops" };
    render(<MakePanel />);
    expect(memoryQuery).toHaveBeenCalledWith(owner);
  });

  it.each(["personal", "team"])("shows Retry when only %s skills fail", (scope) => {
    failedSkillScope = scope;
    render(<MakePanel />);
    expect(screen.getByText("Could not load skills.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retrySkills).toHaveBeenCalledTimes(2);
  });

  it("says what each section will hold when it is empty, and links to every full page", () => {
    render(<MakePanel />);
    expect(screen.getByText("Docs, decks and reports Valet makes for you show here.")).toBeTruthy();
    expect(screen.getByText(/on a schedule, or each time something happens/)).toBeTruthy();
    expect(screen.getByText(/save a way of working as a skill/)).toBeTruthy();
    expect(screen.getByText(/saves what it learns/)).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map(link => [link.textContent, link.getAttribute("href")]);
    expect(hrefs).toEqual([
      ["All files", "/artifacts"], ["All workflows", "/workflows"], ["All skills", "/skills"], ["All memory", "/memory"],
      ["Presence", "/presence"], ["Connected apps", "/integrations"],
    ]);
  });

  it("opens files on their share page, workflows, stored and plugin skills, and memory notes", () => {
    artifacts = [artifact("a", 5)];
    workflows = [workflow("w1", { latestRun: run(50, { status: "running", outcome: undefined }) })];
    skills = { personal: [{ origin: "local", id: "s1", name: "weekly-report", description: "How I write the weekly report", takesArgs: false,
      ownerType: "user", ownerId: "u1", shadowed: false, updatedAt: 1 } as SkillSummary], team: [] };
    memory = [note("people/ada.md", 9, { title: "Ada" })];
    render(<MakePanel />);
    expect(screen.getByRole("link", { name: /File a/ }).getAttribute("href")).toBe("/a/tok-a");
    const flows = screen.getByRole("region", { name: "Workflows" });
    expect(within(flows).getByRole("link", { name: "Workflow w1" }).getAttribute("href")).toBe("/workflows/w1");
    expect(within(flows).getByText("Running")).toBeTruthy();
    expect(screen.getByRole("link", { name: "weekly-report" }).getAttribute("href")).toBe("/skills/stored/s1");
    expect(screen.getByText("How I write the weekly report")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ada" }).getAttribute("href")).toBe("/memory/people/ada.md");
  });

  it("marks a workflow that needs approval or failed", () => {
    workflows = [workflow("ok", { latestRun: run(30) }), workflow("bad", { latestRun: run(20, { outcome: "failed" }) }),
      workflow("wait", { latestRun: run(10, { status: "parked", outcome: undefined, needsApproval: true }) })];
    render(<MakePanel />);
    const flows = screen.getByRole("region", { name: "Workflows" });
    expect(within(flows).getByText("Needs approval")).toBeTruthy();
    expect(within(flows).getByText("Failed")).toBeTruthy();
    expect(within(flows).getByText(/Last run finished/)).toBeTruthy();
  });
});

describe("Make ordering", () => {
  it("shows the four newest files that are still shared", () => {
    const files = newestFiles([artifact("a", 1), artifact("b", 5), artifact("c", 3, { revoked: true }), artifact("d", 4), artifact("e", 2), artifact("f", 6)]);
    expect(files.map(f => f.id)).toEqual(["f", "b", "d", "e"]);
  });

  it("puts workflows that need the person, then running ones, ahead of the most recently run", () => {
    const sorted = workflowsForMake([
      workflow("old", { latestRun: run(1) }), workflow("never", { updatedAt: 5 }), workflow("recent", { latestRun: run(9) }),
      workflow("running", { latestRun: run(2, { status: "running", outcome: undefined }) }),
      workflow("approve", { latestRun: run(0, { status: "parked", outcome: undefined, needsApproval: true }) }),
    ]);
    expect(sorted.map(w => w.id)).toEqual(["approve", "running", "recent", "never", "old"]);
  });

  it("lists pinned notes first, then the most recently changed, and skips folders", () => {
    const notes = recentMemory([note("a", 1), note("dir", 99, { dir: true }), note("b", 5), note("pinned", 0, { pinned: true })]);
    expect(notes.map(n => n.path)).toEqual(["pinned", "b", "a"]);
  });
});
