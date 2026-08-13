// @vitest-environment jsdom
/**
 * `/skills` — the skill catalog in one grid. Mocks `~/api/skills` the same
 * way `-integrations.test.tsx` mocks its api module: this suite cares that
 * the page renders from query data and links to the right detail route, not
 * that TanStack Query works.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListSkillsResponse } from "@valet/api/wire";

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
};

let currentData: ListSkillsResponse = skillsData;
let currentState = { isLoading: false, error: null as Error | null };

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/skills", () => ({
  useSkills: () => ({ data: currentData, ...currentState }),
}));

// The repositories panel has its own suite
// (`components/skills/-skill-sources-panel.test.tsx`); here it only has to
// render, so its hooks return an empty, settled list.
vi.mock("~/api/skill-sources", () => ({
  useSkillSources: () => ({ data: { sources: [] }, isLoading: false, error: null }),
  useAddSkillSource: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useSyncSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { SkillsIndexPage } from "./skills.index";

describe("SkillsIndexPage", () => {
  beforeEach(() => {
    currentData = skillsData;
    currentState = { isLoading: false, error: null };
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

  it("counts the skills, the plugins that ship them, and the caller's own", () => {
    render(<SkillsIndexPage />);
    expect(screen.getByText("5 skills · 3 plugins · 1 yours")).toBeTruthy();
  });

  it("links each card to its detail route", () => {
    render(<SkillsIndexPage />);
    const link = screen.getByText("Slack tools").closest("a");
    expect(link?.getAttribute("to")).toBe("/skills/$skillName");
  });

  it("marks a skill that needs arguments", () => {
    render(<SkillsIndexPage />);
    expect(screen.getByText(/takes arguments/)).toBeTruthy();
  });

  it("shows an empty state when nothing is installed and nothing is stored", () => {
    currentData = { skills: [] };
    render(<SkillsIndexPage />);
    expect(screen.getByText(/No skills yet/)).toBeTruthy();
    // No counter when there is nothing to count.
    expect(screen.queryByText(/\d+ skills? · \d+ plugins?/)).toBeNull();
  });

  it("reports a load failure with a corrective action", () => {
    currentState = { isLoading: false, error: new Error("boom") };
    render(<SkillsIndexPage />);
    expect(screen.getByText(/Check that the server is running/)).toBeTruthy();
  });

  it("filters to prompts when the Prompts chip is picked", () => {
    const { container } = render(<SkillsIndexPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Prompts" }));
    // Only the one prompt-invocation skill stays in the grid.
    expect(container.querySelectorAll(".grid a").length).toBe(1);
    expect(screen.getByText("Standup")).toBeTruthy();
  });

  it("hides the prompt when the Skills chip is picked", () => {
    const { container } = render(<SkillsIndexPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    // The four plugin skills stay; the one prompt drops out.
    expect(container.querySelectorAll(".grid a").length).toBe(4);
    expect(screen.queryByText("Standup")).toBeNull();
  });

  it("offers the GitHub import above the grid", () => {
    render(<SkillsIndexPage />);
    expect(screen.getByRole("button", { name: /import from github/i })).toBeTruthy();
  });
});
