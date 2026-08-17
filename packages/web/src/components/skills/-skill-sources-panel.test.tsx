// @vitest-environment jsdom
/**
 * The tracked-repository panel on `/skills`. Mocks `~/api/skill-sources` the
 * same way the route suites mock their api modules: this cares that the panel
 * renders sync state and calls the right mutation, not that TanStack Query
 * works.
 *
 * A team row's `OwnerBadge` links to that team's assistant and carries a
 * tooltip, so the panel needs a router stub (as the route suites use) and a
 * tooltip provider (as `session-header.test.tsx` uses).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListSkillSourcesResponse, SkillSourceSummary } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

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
let teamsData = { teams: [{ id: "team_1", orgId: "org_1", name: "Platform", createdAt: 1, memberCount: 2, callerRole: "member" as const }] };

vi.mock("~/api/skill-sources", () => ({
  useSkillSources: () => ({ data: currentData, ...currentState }),
  useAddSkillSource: () => ({ mutate: add, ...addState }),
  useSyncSkillSource: () => ({ mutate: sync, isPending: false }),
  useRemoveSkillSource: () => ({ mutate: remove, isPending: false }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  // The workspace scope reads `?assistant=` so an open assistant can override
  // the stored workspace. This panel is never rendered with one.
  useSearch: () => ({}),
}));

vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useOrg: () => ({ data: { features: { organizations: true } }, isLoading: false, error: null }),
}));

// The badge links by assistant id, so it reads the assistants list to find
// the team's default one.
vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({
      data: {
        assistants: [
          {
            id: "asst_team_1",
            owner: { type: "team" as const, id: "team_1" },
            sessionId: "assistant:asst_team_1",
            isDefault: true,
            createdAt: 1,
          },
        ],
      },
      isLoading: false,
      error: null,
    }),
  };
});

import { SkillSourcesPanel } from "./skill-sources-panel";
import { PERSONAL, WorkspaceScopeProvider } from "~/lib/workspace-scope";

/** `workspace` selects the workspace the panel is being read in — the same
 * thing the nav's switcher sets. It is seeded through localStorage because
 * that is where the real scope lives, so these cases exercise the actual
 * persistence rather than a value handed straight to the component. */
function renderPanel(workspace = PERSONAL) {
  window.localStorage.setItem("valet:workspace", workspace);
  return render(
    <TooltipProvider>
      <WorkspaceScopeProvider>
        <SkillSourcesPanel />
      </WorkspaceScopeProvider>
    </TooltipProvider>,
  );
}

describe("SkillSourcesPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    currentData = { sources: [] };
    currentState = { isLoading: false, error: null };
    addState = { isPending: false, error: null };
    add.mockReset();
    sync.mockReset();
    remove.mockReset();
  });

  it("states that only public repositories can be imported", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    expect(screen.getByText(/public repositories only/i)).toBeTruthy();
  });

  it("imports what was typed into the box", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), {
      target: { value: "https://github.com/tkhq/skills" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /import a skill repository/i }));

    expect(add).toHaveBeenCalledWith({ repo: "https://github.com/tkhq/skills" });
  });

  it("files the import under the workspace being read, with no second question", () => {
    // There was an Owner select in this form. It asked again what the nav's
    // workspace switcher had already answered, and the two could disagree —
    // the panel could list one workspace's repositories while the form filed
    // a new one under another.
    renderPanel("team_1");
    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), {
      target: { value: "tkhq/skills" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /import a skill repository/i }));

    expect(add).toHaveBeenCalledWith({ repo: "tkhq/skills", teamId: "team_1" });
    expect(screen.queryByLabelText("Owner")).toBeNull();
  });

  it("sends no teamId in your own workspace", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), {
      target: { value: "tkhq/skills" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /import a skill repository/i }));

    expect(add).toHaveBeenCalledWith({ repo: "tkhq/skills" });
  });

  it("shows the owning team's name on a team-tracked repository", () => {
    currentData = { sources: [source({ ownerType: "team", ownerId: "team_1" })] };
    renderPanel();

    expect(screen.getByText("Platform")).toBeTruthy();
  });

  it("shows no ownership badge on a personal repository", () => {
    currentData = { sources: [source({ ownerType: "user", ownerId: "u1" })] };
    renderPanel();

    expect(screen.queryByText("Platform")).toBeNull();
  });

  it("shows what the server said about a repository it refused", () => {
    addState = { isPending: false, error: new Error("Valet reads GitHub repositories only") };
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /import/i }));

    expect(screen.getByText(/Valet reads GitHub repositories only/)).toBeTruthy();
  });

  it("lists a tracked repository with its skill count and sync time", () => {
    currentData = { sources: [source()] };
    renderPanel();

    expect(screen.getByText("tkhq/skills")).toBeTruthy();
    expect(screen.getByText(/3 skills/)).toBeTruthy();
    expect(screen.getByText(/ago/)).toBeTruthy();
  });

  it("names the ref and the subdirectory when a source pins them", () => {
    currentData = { sources: [source({ ref: "main", subpath: "agent/skills" })] };
    renderPanel();

    expect(screen.getByText(/main/)).toBeTruthy();
    expect(screen.getByText(/agent\/skills/)).toBeTruthy();
  });

  it("shows the message from a failed sync", () => {
    currentData = {
      sources: [source({ status: "error", lastMessage: "tkhq/x was not found on GitHub." })],
    };
    renderPanel();

    expect(screen.getByText(/was not found on GitHub/)).toBeTruthy();
  });

  it("shows the skipped skills from a sync that warned", () => {
    currentData = {
      sources: [source({ status: "warning", lastMessage: "broken: name is required." })],
    };
    renderPanel();

    expect(screen.getByText(/broken: name is required/)).toBeTruthy();
  });

  it("syncs and removes the source the buttons belong to", () => {
    currentData = { sources: [source()] };
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));
    expect(sync).toHaveBeenCalledWith("skillsrc_1");

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(remove).toHaveBeenCalledWith("skillsrc_1");
  });

  it("says a source has never synced", () => {
    currentData = { sources: [source({ status: "pending", lastSyncedAt: null, skillCount: 0 })] };
    renderPanel();

    expect(screen.getByText(/never synced/i)).toBeTruthy();
  });
});
