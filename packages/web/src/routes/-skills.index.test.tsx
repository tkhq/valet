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

  it("groups skills under a section per owning plugin", () => {
    render(<SkillsIndexPage />);

    expect(screen.getByRole("heading", { name: "GitHub" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Google Workspace" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Slack" })).toBeTruthy();
  });

  it("shows a friendly name, the description, and the raw skill id on each card", () => {
    render(<SkillsIndexPage />);

    expect(screen.getByText("Google docs")).toBeTruthy();
    expect(screen.getByText("Edit a document.")).toBeTruthy();
    // The exact id the agent passes to the skill tool.
    expect(screen.getByText("google-docs")).toBeTruthy();
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
