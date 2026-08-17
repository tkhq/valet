// @vitest-environment jsdom
/**
 * `/skills` — the skill catalog in one grid, with the tracked-repository
 * panel above it. Mocks `~/api/skills` the same way `-integrations.test.tsx`
 * mocks its api module: this suite cares that the page renders from query
 * data, asks the server the right question, and links to the right detail
 * route, not that TanStack Query works.
 *
 * The repository cases came from the retired `/settings/library-sources`
 * suite together with the panel they cover.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListSkillsResponse, ListSkillSourcesResponse } from "@valet/api/wire";

const skillsData: ListSkillsResponse = {
  skills: [
    {
      name: "github",
      description: "How to use the GitHub tools.",
      origin: "plugin",
      plugin: "github",
      takesArgs: false,
    },
    {
      name: "google-docs",
      description: "Edit a document.",
      origin: "plugin",
      plugin: "google-workspace",
      takesArgs: false,
    },
    { name: "google-sheets", origin: "plugin", plugin: "google-workspace", takesArgs: true },
    {
      name: "slack-tools",
      description: "Read and post in Slack.",
      origin: "plugin",
      plugin: "slack",
      takesArgs: false,
    },
    {
      name: "standup",
      description: "Summarize the standup.",
      origin: "local",
      id: "skill_1",
      ownerType: "user",
      ownerId: "u1",
      shadowed: false,
      takesArgs: false,
      updatedAt: 0,
      invocation: "prompt",
      argHint: "<topic>",
    },
  ],
  nextCursor: null,
};

let currentData: ListSkillsResponse = skillsData;
let currentState = { isLoading: false, error: null as Error | null };
let sourcesData: ListSkillSourcesResponse = { sources: [], nextCursor: null };
/** The search params the page is rendered with, and where it navigates. The
 * filters and both cursor stacks live here, never in component state. */
let searchParams: Record<string, string> = {};
const navigate = vi.fn();
const skillsQuery = vi.fn();
const addSource = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  createFileRoute: () => (config: unknown) => config,
  useSearch: () => searchParams,
  useNavigate: () => navigate,
}));

vi.mock("~/api/skills", () => ({
  useSkills: (query: unknown) => {
    skillsQuery(query);
    return { data: currentData, ...currentState };
  },
}));

vi.mock("~/api/skill-sources", () => ({
  useSkillSources: () => ({ data: sourcesData, isLoading: false, error: null }),
  useAddSkillSource: () => ({ mutate: addSource, isPending: false, error: null }),
  useSyncSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
}));

// A team card carries an `OwnerBadge`, which reads the teams list. No fixture
// below is team-owned, so the badge never mounts — the mock is here so that
// adding a team-owned fixture does not need a query client as well.
vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: { teams: [] }, isLoading: false, error: null }),
  useOrg: () => ({ data: { features: { organizations: true } }, isLoading: false, error: null }),
}));

import { SkillsIndexPage } from "./skills.index";

/** The last query the page sent to `GET /api/skills`. */
function lastSkillsQuery(): Record<string, unknown> {
  const call = skillsQuery.mock.calls[skillsQuery.mock.calls.length - 1];
  const [query] = (call ?? [{}]) as [Record<string, unknown>];
  return query;
}

/** The search params of the page's last navigation. */
function lastNavigationSearch(): Record<string, unknown> {
  const call = navigate.mock.calls[navigate.mock.calls.length - 1];
  const [options] = (call ?? [{}]) as [{ search?: Record<string, unknown> }];
  return options.search ?? {};
}

describe("SkillsIndexPage", () => {
  beforeEach(() => {
    currentData = skillsData;
    currentState = { isLoading: false, error: null };
    sourcesData = { sources: [], nextCursor: null };
    searchParams = {};
    navigate.mockReset();
    skillsQuery.mockReset();
    addSource.mockReset();
  });

  it("lists every skill in one grid, with no per-plugin sections", () => {
    const { container } = render(<SkillsIndexPage />);

    // Most plugins ship exactly one skill, so a section per plugin left a
    // lone card under each heading. The plugin moved onto the card instead.
    expect(screen.queryByRole("heading", { name: "Google Workspace" })).toBeNull();
    // Router `Link`s render `to`, not `href`, so they carry no link role.
    // Counted inside the grid: the header carries links of its own.
    expect(container.querySelectorAll(".grid a").length).toBe(5);
  });

  it("offers a New skill action", () => {
    render(<SkillsIndexPage />);
    const link = screen.getByText("New skill").closest("a");
    expect(link?.getAttribute("to")).toBe("/skills/new");
  });

  it("shows a friendly name, the description, and the raw skill id on each card", () => {
    render(<SkillsIndexPage />);

    expect(screen.getByText("Google docs")).toBeTruthy();
    expect(screen.getByText("Edit a document.")).toBeTruthy();
    // The exact id the agent passes to the skill tool, plus the owning
    // plugin — shown because "Google Workspace" differs from the skill name.
    expect(screen.getByText("google-docs · Google Workspace")).toBeTruthy();
  });

  it("omits the plugin when it repeats the skill name", () => {
    render(<SkillsIndexPage />);
    // The GitHub plugin ships one skill also called `github`, so printing
    // the plugin would just repeat the card title.
    expect(screen.getByText("github")).toBeTruthy();
  });

  it("links each card to its detail route", () => {
    const { container } = render(<SkillsIndexPage />);
    // The card's link covers the card instead of wrapping it — a team card's
    // owner badge in the title row is a link of its own — so it is addressed
    // by the name it carries for a reader, not through the title text.
    const link = container.querySelector('a[aria-label="Read Slack tools"]');
    expect(link?.getAttribute("to")).toBe("/skills/$skillName");
  });

  it("marks a skill that needs arguments", () => {
    render(<SkillsIndexPage />);
    expect(screen.getByText(/takes arguments/)).toBeTruthy();
  });

  it("shows an empty state when nothing is installed and nothing is stored", () => {
    currentData = { skills: [], nextCursor: null };
    render(<SkillsIndexPage />);
    expect(screen.getByText(/No skills yet/)).toBeTruthy();
    // The header carries no counter at all now: the grid's own chips and
    // search say what is in the list, so a running total said it twice.
    expect(screen.queryByText(/\d+ skills? · \d+ plugins?/)).toBeNull();
  });

  it("reports a load failure with a corrective action", () => {
    currentState = { isLoading: false, error: new Error("boom") };
    render(<SkillsIndexPage />);
    expect(screen.getByText(/Check that the server is running/)).toBeTruthy();
  });

  it("shows a scope badge on every card", () => {
    const { container } = render(<SkillsIndexPage />);
    // Query inside the grid so the scope-filter dropdown's <option>s do not
    // count. Four plugin skills → four Plugin badges; one personal stored.
    const grid = container.querySelector(".grid");
    const badges = (label: string) =>
      Array.from(grid?.querySelectorAll("span") ?? []).filter((el) => el.textContent === label);
    expect(badges("Plugin").length).toBe(4);
    expect(badges("Personal").length).toBe(1);
  });
});

/**
 * The chips, the scope select, and the search box narrow the CATALOG, so
 * they travel to the server through the URL. Filtering the page in hand
 * would report "No skills match your search" for a skill sitting on the next
 * page.
 */
describe("SkillsIndexPage — the filters go to the URL and to the server", () => {
  beforeEach(() => {
    currentData = skillsData;
    currentState = { isLoading: false, error: null };
    sourcesData = { sources: [], nextCursor: null };
    searchParams = {};
    navigate.mockReset();
    skillsQuery.mockReset();
  });

  it("asks the plainest question with no filter set", () => {
    render(<SkillsIndexPage />);
    expect(lastSkillsQuery()).toEqual({});
  });

  it("writes the Prompts chip to the URL as the kind it means", () => {
    render(<SkillsIndexPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Prompts" }));

    expect(lastNavigationSearch()).toMatchObject({ filter: "prompts" });
  });

  it("sends the chip on to the server as a kind", () => {
    searchParams = { filter: "prompts" };
    render(<SkillsIndexPage />);

    expect(lastSkillsQuery()).toEqual({ kind: "prompt" });
    expect(screen.getByRole("tab", { name: "Prompts" }).getAttribute("aria-selected")).toBe("true");
  });

  it("sends the search box on as a catalog-wide query", () => {
    render(<SkillsIndexPage />);
    fireEvent.change(screen.getByLabelText("Search skills"), { target: { value: "SLACK" } });

    expect(lastNavigationSearch()).toMatchObject({ q: "SLACK" });

    searchParams = { q: "SLACK" };
    render(<SkillsIndexPage />);
    expect(lastSkillsQuery()).toEqual({ q: "SLACK" });
  });

  it("sends the scope select on as a scope", () => {
    searchParams = { scope: "personal" };
    render(<SkillsIndexPage />);
    expect(lastSkillsQuery()).toEqual({ scope: "personal" });
  });

  it("returns to the first page when a filter changes", () => {
    searchParams = { page: "cursor_1" };
    render(<SkillsIndexPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Prompts" }));

    // A different question has a different first page, so the old cursor
    // names a row that the new question may not even list.
    expect(lastNavigationSearch()).toMatchObject({ page: undefined });
  });

  it("keeps the search box up when a search matches nothing", () => {
    searchParams = { q: "nothing-matches-this" };
    currentData = { skills: [], nextCursor: null };
    render(<SkillsIndexPage />);

    expect(screen.getByText("No skills match your search.")).toBeTruthy();
    // Hiding the box on an empty page would leave no way to clear the search.
    expect(screen.getByLabelText("Search skills")).toBeTruthy();
  });
});

describe("SkillsIndexPage — paging", () => {
  beforeEach(() => {
    currentData = skillsData;
    currentState = { isLoading: false, error: null };
    sourcesData = { sources: [], nextCursor: null };
    searchParams = {};
    navigate.mockReset();
    skillsQuery.mockReset();
  });

  it("pushes the cursor it was handed onto the stack in the URL", () => {
    currentData = { ...skillsData, nextCursor: "cursor_2" };
    render(<SkillsIndexPage />);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // In the URL, not in `useState`: a page is then a history entry, so Back
    // pages back instead of leaving Skills.
    expect(lastNavigationSearch()).toMatchObject({ page: "cursor_2" });
  });

  it("reads the page its stack names and pops back off it", () => {
    searchParams = { page: "cursor_1~cursor_2" };
    currentData = { ...skillsData, nextCursor: null };
    render(<SkillsIndexPage />);

    expect(lastSkillsQuery()).toEqual({ cursor: "cursor_2" });
    expect(screen.getByText("Page 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(lastNavigationSearch()).toMatchObject({ page: "cursor_1" });
  });

  it("shows no pager while the whole catalog fits on one page", () => {
    render(<SkillsIndexPage />);
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });
});

/**
 * The repositories panel sits on this page now, over the skills it produces.
 * It used to be a link to `/settings/library-sources`, which is retired: a
 * row's scope is a badge, so a page per scope bought nothing.
 */
describe("SkillsIndexPage — the repositories panel", () => {
  beforeEach(() => {
    currentData = skillsData;
    currentState = { isLoading: false, error: null };
    sourcesData = { sources: [], nextCursor: null };
    searchParams = {};
    navigate.mockReset();
    addSource.mockReset();
  });

  it("holds the import panel inline, and no link out to Settings", () => {
    render(<SkillsIndexPage />);

    expect(screen.getByRole("button", { name: /import from github/i })).toBeTruthy();
    expect(screen.queryByText(/Manage sync sources in Settings/)).toBeNull();
  });

  it("adds a source under the reader's own workspace, with no org scope", () => {
    render(<SkillsIndexPage />);
    fireEvent.click(screen.getByRole("button", { name: /import from github/i }));
    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), {
      target: { value: "tkhq/skills" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /import a skill repository/i }));

    expect(addSource).toHaveBeenCalledWith({ repo: "tkhq/skills" });
  });

  it("keeps its own cursor stack, apart from the grid's", () => {
    sourcesData = { sources: [], nextCursor: "src_2" };
    render(<SkillsIndexPage />);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // Two lists on one page, so two params: paging the repositories must not
    // move the grid.
    expect(lastNavigationSearch()).toMatchObject({ sourcePage: "src_2", page: undefined });
  });
});
