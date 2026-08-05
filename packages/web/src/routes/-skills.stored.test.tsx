// @vitest-environment jsdom
/**
 * `/skills` — what a stored skill adds to the catalog page: an origin badge,
 * a shadow warning, and a link to the row-id page that reads its body. The
 * page writes nothing: a skill is authored in its repository or by an agent
 * (docs/specs/2026-08-05-agent-skills-design.md).
 *
 * Mocks `~/api/skills` the same way `-skills.index.test.tsx` does, so the
 * assertions stay on the rendering, not on TanStack Query.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListSkillsResponse, SkillResponse } from "@valet/api/wire";

const data: ListSkillsResponse = {
  skills: [
    {
      name: "github",
      description: "How to use the GitHub tools.",
      origin: "plugin",
      plugin: "github",
      takesArgs: false,
    },
    {
      name: "deploy",
      description: "How to deploy the service.",
      origin: "local",
      id: "skill_1",
      ownerType: "user",
      ownerId: "u1",
      shadowed: false,
      takesArgs: false,
      updatedAt: 1_700_000_000_000,
    },
    {
      name: "github",
      description: "My own GitHub notes, kept out by the plugin skill.",
      origin: "local",
      id: "skill_2",
      ownerType: "user",
      ownerId: "u1",
      shadowed: true,
      takesArgs: false,
      updatedAt: 1_700_000_000_000,
    },
  ],
};

const stored: SkillResponse = {
  name: "deploy",
  description: "How to deploy the service.",
  origin: "local",
  id: "skill_1",
  ownerType: "user",
  ownerId: "u1",
  shadowed: false,
  takesArgs: false,
  updatedAt: 1_700_000_000_000,
  content: "Ship the service from main.\n",
};

let currentData: ListSkillsResponse = data;
let currentState = { isLoading: false, error: null as Error | null };
let currentStored: SkillResponse = stored;

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  // The real `createFileRoute` returns a route object; the detail page reads
  // its params off it, so the stub supplies those too.
  createFileRoute: () => (config: object) => ({
    ...config,
    useParams: () => ({ skillId: "skill_1" }),
  }),
}));

vi.mock("~/api/skills", () => ({
  useSkills: () => ({ data: currentData, ...currentState }),
  useStoredSkill: () => ({ data: currentStored, isLoading: false, error: null }),
}));

import { SkillsIndexPage } from "./skills.index";
import { StoredSkillPage } from "./skills.stored.$skillId";

describe("SkillsIndexPage with stored skills", () => {
  beforeEach(() => {
    currentData = data;
    currentState = { isLoading: false, error: null };
  });

  it("badges each skill with where it came from", () => {
    render(<SkillsIndexPage />);
    expect(screen.getAllByText("Plugin").length).toBe(1);
    expect(screen.getAllByText("Yours").length).toBe(2);
  });

  it("says why a shadowed skill never reaches a session, and who can rename it", () => {
    render(<SkillsIndexPage />);
    expect(screen.getByText(/Shadowed by another skill of the same name/)).toBeTruthy();
    expect(screen.getByText(/Ask the assistant to rename it/)).toBeTruthy();
  });

  it("links a stored skill to its row-id page, not to the name route", () => {
    render(<SkillsIndexPage />);
    const link = screen.getByText("Deploy").closest("a");
    expect(link?.getAttribute("to")).toBe("/skills/stored/$skillId");
  });

  it("offers no way to write a skill from the page", () => {
    render(<SkillsIndexPage />);
    expect(screen.queryByRole("button", { name: /New skill/ })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says so when the owner has no skills", () => {
    currentData = { skills: [] };
    render(<SkillsIndexPage />);
    expect(screen.getByText("No skills yet.")).toBeTruthy();
  });
});

describe("StoredSkillPage", () => {
  beforeEach(() => {
    currentStored = stored;
  });

  it("reads the body of the skill the row id names, with no field to edit it", () => {
    render(<StoredSkillPage />);
    expect(screen.getByRole("heading", { name: "Deploy", level: 1 })).toBeTruthy();
    expect(screen.getByText("Ship the service from main.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("repeats the shadow warning on the skill that is kept out", () => {
    currentStored = { ...stored, shadowed: true };
    render(<StoredSkillPage />);
    expect(screen.getByText(/Shadowed by another skill of the same name/)).toBeTruthy();
  });
});
