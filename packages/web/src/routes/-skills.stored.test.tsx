// @vitest-environment jsdom
/**
 * `/skills` — what a stored skill adds to the catalog page: an origin badge,
 * a shadow warning, and the form that writes one. Mocks `~/api/skills` the
 * same way `-skills.index.test.tsx` does, so the assertions stay on the
 * rendering, not on TanStack Query.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListSkillsResponse } from "@valet/api/wire";

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

let currentData: ListSkillsResponse = data;
let currentState = { isLoading: false, error: null as Error | null };
const createMutate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  createFileRoute: () => (config: unknown) => config,
}));

const updateMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock("~/api/skills", () => ({
  useSkills: () => ({ data: currentData, ...currentState }),
  useStoredSkill: (id: string | null) => ({
    data:
      id === "skill_1"
        ? {
            name: "deploy",
            description: "How to deploy the service.",
            origin: "local" as const,
            id: "skill_1",
            ownerType: "user" as const,
            ownerId: "u1",
            shadowed: false,
            takesArgs: false,
            updatedAt: 1_700_000_000_000,
            content: "# Deploy\n",
          }
        : undefined,
    isLoading: false,
    error: null,
  }),
  useCreateSkill: () => ({ mutate: createMutate, isPending: false, error: null }),
  useUpdateSkill: () => ({ mutate: updateMutate, isPending: false, error: null }),
  useDeleteSkill: () => ({ mutate: deleteMutate, isPending: false, error: null }),
}));

import { SkillsIndexPage } from "./skills.index";

describe("SkillsIndexPage with stored skills", () => {
  beforeEach(() => {
    currentData = data;
    currentState = { isLoading: false, error: null };
    createMutate.mockReset();
    updateMutate.mockReset();
    deleteMutate.mockReset();
  });

  it("badges each skill with where it came from", () => {
    render(<SkillsIndexPage />);
    expect(screen.getAllByText("Plugin").length).toBe(1);
    expect(screen.getAllByText("Yours").length).toBe(2);
  });

  it("says why a shadowed skill never reaches a session", () => {
    render(<SkillsIndexPage />);
    expect(screen.getByText(/Shadowed by another skill of the same name/)).toBeTruthy();
  });

  it("opens a form and writes a new skill", () => {
    render(<SkillsIndexPage />);

    fireEvent.click(screen.getByRole("button", { name: /New skill/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "release" } });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "How to cut a release." },
    });
    fireEvent.change(screen.getByLabelText("Playbook"), { target: { value: "# Release\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0]?.[0]).toMatchObject({
      name: "release",
      description: "How to cut a release.",
      content: "# Release\n",
    });
  });

  it("opens a stored skill in the editor and saves an edit", () => {
    render(<SkillsIndexPage />);

    // A stored card opens the editor by row id; only a plugin card links to
    // the read-only detail page.
    fireEvent.click(screen.getByText("Deploy"));
    const content = screen.getByLabelText("Playbook");
    expect((content as HTMLTextAreaElement).value).toBe("# Deploy\n");

    fireEvent.change(content, { target: { value: "# Deploy\n\nRun `make deploy`.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save skill" }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]?.[0]).toMatchObject({
      id: "skill_1",
      body: { name: "deploy", content: "# Deploy\n\nRun `make deploy`.\n" },
    });
  });

  it("deletes a stored skill from the editor", () => {
    render(<SkillsIndexPage />);

    fireEvent.click(screen.getByText("Deploy"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0]?.[0]).toBe("skill_1");
  });

  it("offers the form when nothing is installed", () => {
    currentData = { skills: [] };
    render(<SkillsIndexPage />);
    expect(screen.getByRole("button", { name: /New skill/ })).toBeTruthy();
  });
});
