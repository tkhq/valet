// @vitest-environment jsdom
/**
 * Organization · Library — the org skills panel below the sources panel, and
 * the owner a new skill takes when this page opens the editor. Mocks the api
 * modules the same way `-settings.organization.test.tsx` does: these tests
 * care what the page renders and which owner a new skill takes, not that
 * TanStack Query or the router resolve anything.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ListSkillsResponse, ListTeamsResponse, OrgResponse } from "@valet/api/wire";

const skillsData: ListSkillsResponse = {
  skills: [
    { name: "github", origin: "plugin", plugin: "github", takesArgs: false },
    {
      name: "mine",
      description: "A personal skill.",
      origin: "local",
      id: "skill_p",
      ownerType: "user",
      ownerId: "u1",
      shadowed: false,
      takesArgs: false,
      updatedAt: 0,
    },
    {
      name: "org-playbook",
      description: "The org playbook.",
      origin: "local",
      id: "skill_o",
      ownerType: "org",
      ownerId: "org_1",
      shadowed: false,
      takesArgs: false,
      updatedAt: 0,
    },
  ],
};

const teams: ListTeamsResponse = { teams: [] };

let orgData: OrgResponse = {
  id: "org_1",
  name: "Acme",
  createdAt: 0,
  callerRole: "admin",
  features: { organizations: true },
};

const createSkill = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => vi.fn(),
}));

vi.mock("~/api/skills", () => ({
  useSkills: () => ({ data: skillsData, isLoading: false, error: null }),
  useStoredSkill: () => ({ data: undefined, isLoading: false, error: null }),
  useCreateSkill: () => ({ mutate: createSkill, isPending: false, error: null }),
  useUpdateSkill: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDeleteSkill: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
  useTeams: () => ({ data: teams, isLoading: false, error: null }),
}));

vi.mock("~/api/skill-sources", () => ({
  useSkillSources: () => ({ data: { sources: [] }, isLoading: false, error: null }),
  useAddSkillSource: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useSyncSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { OrganizationLibraryPage } from "./settings.organization.library";
import { SkillEditor } from "~/components/skills/skill-editor";

describe("OrganizationLibraryPage — org skills panel", () => {
  beforeEach(() => {
    orgData = { id: "org_1", name: "Acme", createdAt: 0, callerRole: "admin", features: { organizations: true } };
    createSkill.mockClear();
  });

  it("lists only the org rows, not personal or plugin skills", () => {
    const { container } = render(<OrganizationLibraryPage />);
    expect(screen.getByText("Org playbook")).toBeTruthy();
    // The personal and plugin skills stay out of the org grid.
    expect(screen.queryByText("Mine")).toBeNull();
    // One card in the org grid.
    const grid = container.querySelector(".grid");
    expect(grid?.querySelectorAll("a").length).toBe(1);
  });

  it("gives an admin the New org skill button pointed at the org scope", () => {
    render(<OrganizationLibraryPage />);
    const link = screen.getByText("New org skill").closest("a");
    expect(link).toBeTruthy();
  });

  it("hides the New org skill button from a member", () => {
    orgData = { ...orgData, callerRole: "member" };
    render(<OrganizationLibraryPage />);
    expect(screen.queryByText("New org skill")).toBeNull();
    // The org cards still render read-only.
    expect(screen.getByText("Org playbook")).toBeTruthy();
  });
});

/**
 * The editor asks nobody who owns a new skill: the page that opened it says
 * so. `defaultScope="org"` is what the org Library page's "New org skill"
 * button sets, through `/skills/new?scope=org`.
 */
describe("SkillEditor — the org scope", () => {
  beforeEach(() => {
    orgData = { id: "org_1", name: "Acme", createdAt: 0, callerRole: "admin", features: { organizations: true } };
    createSkill.mockClear();
  });

  async function writeAndCreate(): Promise<void> {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Name"), "org-thing");
    await user.type(screen.getByLabelText("Description"), "An org skill.");
    await user.type(screen.getByRole("textbox", { name: "Playbook" }), "Do it.");
    await user.click(screen.getByRole("button", { name: "Create skill" }));
  }

  it("sends ownerType org for an admin, with no Owner field to pick", async () => {
    render(<SkillEditor defaultScope="org" onSaved={() => undefined} onCancel={() => undefined} />);

    // The workspace and the opening page answer ownership, so the form has
    // no Owner select to disagree with them.
    expect(screen.queryByLabelText("Owner")).toBeNull();

    await writeAndCreate();

    expect(createSkill).toHaveBeenCalledTimes(1);
    const [body] = createSkill.mock.calls[0] as [{ ownerType?: string }];
    expect(body.ownerType).toBe("org");
  });

  it("files a personal skill when a member lands on the org scope", async () => {
    orgData = { ...orgData, callerRole: "member" };
    render(<SkillEditor defaultScope="org" onSaved={() => undefined} onCancel={() => undefined} />);

    await writeAndCreate();

    // A member may not write the org library, so `?scope=org` falls back to
    // the caller's own workspace rather than sending a request the create
    // route rejects.
    expect(createSkill).toHaveBeenCalledTimes(1);
    const [body] = createSkill.mock.calls[0] as [{ ownerType?: string; teamId?: string }];
    expect(body.ownerType).toBeUndefined();
    expect(body.teamId).toBeUndefined();
  });
});
