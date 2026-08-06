// @vitest-environment jsdom
/**
 * `/skills` — the skill catalog, grouped by the plugin that ships each
 * skill. Mocks `~/api/skills` the same way `-integrations.test.tsx` mocks
 * its api module: this suite cares that the page renders from query data
 * and links to the right detail route, not that TanStack Query works.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListSkillsResponse } from "@valet/api/wire";

const skillsData: ListSkillsResponse = {
  skills: [
    {
      name: "github",
      description: "How to use the GitHub tools.",
      plugin: "github",
      takesArgs: false,
    },
    { name: "google-docs", description: "Edit a document.", plugin: "google-workspace", takesArgs: false },
    { name: "google-sheets", plugin: "google-workspace", takesArgs: true },
    { name: "slack-tools", description: "Read and post in Slack.", plugin: "slack", takesArgs: false },
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

import { SkillsIndexPage } from "./skills.index";

describe("SkillsIndexPage", () => {
  beforeEach(() => {
    currentData = skillsData;
    currentState = { isLoading: false, error: null };
  });

  it("lists every skill in one grid, with no per-plugin sections", () => {
    render(<SkillsIndexPage />);

    // Most plugins ship exactly one skill, so a section per plugin left a
    // lone card under each heading. The plugin moved onto the card instead.
    expect(screen.queryByRole("heading", { name: "Google Workspace" })).toBeNull();
    // Router `Link`s render `to`, not `href`, so they carry no link role.
    expect(document.querySelectorAll("a").length).toBe(4);
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

  it("counts the skills and the plugins that ship them", () => {
    render(<SkillsIndexPage />);
    expect(screen.getByText("4 skills in 3 plugins")).toBeTruthy();
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

  it("shows an empty state when no plugin ships a skill", () => {
    currentData = { skills: [] };
    render(<SkillsIndexPage />);
    expect(screen.getByText(/No skills installed/)).toBeTruthy();
    // No counter when there is nothing to count.
    expect(screen.queryByText(/\d+ skills? in \d+ plugins?/)).toBeNull();
  });

  it("reports a load failure with a corrective action", () => {
    currentState = { isLoading: false, error: new Error("boom") };
    render(<SkillsIndexPage />);
    expect(screen.getByText(/Check that the server is running/)).toBeTruthy();
  });
});
