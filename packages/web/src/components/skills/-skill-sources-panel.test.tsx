// @vitest-environment jsdom
/**
 * The tracked-repository panel on `/skills`. Mocks `~/api/skill-sources` the
 * same way the route suites mock their api modules: this cares that the panel
 * renders sync state and calls the right mutation, not that TanStack Query
 * works.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ListSkillSourcesResponse, SkillSourceSummary } from "@valet/api/wire";

function source(over: Partial<SkillSourceSummary> = {}): SkillSourceSummary {
  return {
    id: "skillsrc_1",
    repo: "tkhq/skills",
    ref: "",
    subpath: "",
    ownerType: "user",
    ownerId: "u1",
    enabled: true,
    status: "ok",
    skillCount: 3,
    lastSyncedAt: Date.now() - 60_000,
    lastSha: "abc123",
    lastMessage: null,
    ...over,
  };
}

let currentData: ListSkillSourcesResponse = { sources: [] };
let currentState = { isLoading: false, error: null as Error | null };
const add = vi.fn();
const sync = vi.fn();
const remove = vi.fn();
let addState = { isPending: false, error: null as Error | null };

vi.mock("~/api/skill-sources", () => ({
  useSkillSources: () => ({ data: currentData, ...currentState }),
  useAddSkillSource: () => ({ mutate: add, ...addState }),
  useSyncSkillSource: () => ({ mutate: sync, isPending: false }),
  useRemoveSkillSource: () => ({ mutate: remove, isPending: false }),
}));

import { SkillSourcesPanel } from "./skill-sources-panel";

describe("SkillSourcesPanel", () => {
  beforeEach(() => {
    currentData = { sources: [] };
    currentState = { isLoading: false, error: null };
    addState = { isPending: false, error: null };
    add.mockReset();
    sync.mockReset();
    remove.mockReset();
  });

  it("states that only public repositories can be imported", () => {
    render(<SkillSourcesPanel />);

    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    expect(screen.getByText(/public repositories only/i)).toBeTruthy();
  });

  it("imports what was typed into the box", () => {
    render(<SkillSourcesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), {
      target: { value: "https://github.com/tkhq/skills" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /import a skill repository/i }));

    expect(add).toHaveBeenCalledWith({ repo: "https://github.com/tkhq/skills" });
  });

  it("shows what the server said about a repository it refused", () => {
    addState = { isPending: false, error: new Error("Valet reads GitHub repositories only") };
    render(<SkillSourcesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    expect(screen.getByText(/Valet reads GitHub repositories only/)).toBeTruthy();
  });

  it("lists a tracked repository with its skill count and sync time", () => {
    currentData = { sources: [source()] };
    render(<SkillSourcesPanel />);

    expect(screen.getByText("tkhq/skills")).toBeTruthy();
    expect(screen.getByText(/3 skills/)).toBeTruthy();
    expect(screen.getByText(/ago/)).toBeTruthy();
  });

  it("names the ref and the subdirectory when a source pins them", () => {
    currentData = { sources: [source({ ref: "main", subpath: "agent/skills" })] };
    render(<SkillSourcesPanel />);

    expect(screen.getByText(/main/)).toBeTruthy();
    expect(screen.getByText(/agent\/skills/)).toBeTruthy();
  });

  it("shows the message from a failed sync", () => {
    currentData = {
      sources: [source({ status: "error", lastMessage: "tkhq/x was not found on GitHub." })],
    };
    render(<SkillSourcesPanel />);

    expect(screen.getByText(/was not found on GitHub/)).toBeTruthy();
  });

  it("shows the skipped skills from a sync that warned", () => {
    currentData = {
      sources: [source({ status: "warning", lastMessage: "broken: name is required." })],
    };
    render(<SkillSourcesPanel />);

    expect(screen.getByText(/broken: name is required/)).toBeTruthy();
  });

  it("syncs and removes the source the buttons belong to", () => {
    currentData = { sources: [source()] };
    render(<SkillSourcesPanel />);

    fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));
    expect(sync).toHaveBeenCalledWith("skillsrc_1");

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(remove).toHaveBeenCalledWith("skillsrc_1");
  });

  it("says a source has never synced", () => {
    currentData = { sources: [source({ status: "pending", lastSyncedAt: null, skillCount: 0 })] };
    render(<SkillSourcesPanel />);

    expect(screen.getByText(/never synced/i)).toBeTruthy();
  });
});
