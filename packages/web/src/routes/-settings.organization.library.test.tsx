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

/** The org rows the server sends back for this page. Both lists are pinned to
 * the org server-side, so the fixture holds what an org-pinned read returns
 * and not the whole catalog. */
const skillsData: ListSkillsResponse = {
  skills: [
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
  nextCursor: null,
};

const teams: ListTeamsResponse = { teams: [] };

let orgData: OrgResponse = {
  id: "org_1",
  name: "Acme",
  createdAt: 0,
  callerRole: "admin",
  allowPublicArtifacts: false,
  features: { organizations: true, ssoTeamSync: false },
  ssoTeamGroups: [],
};

const createSkill = vi.fn();
const skillsQuery = vi.fn();
const sourcesQuery = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));

vi.mock("~/api/skills", () => ({
  useSkills: (query: unknown) => {
    skillsQuery(query);
    return { data: skillsData, isLoading: false, error: null };
  },
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
  useSkillSources: (query: unknown) => {
    sourcesQuery(query);
    return { data: { sources: [], nextCursor: null }, isLoading: false, error: null };
  },
  useAddSkillSource: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useSyncSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { OrganizationLibraryPage } from "./settings.organization.library";
import { SkillEditor } from "~/components/skills/skill-editor";

describe("OrganizationLibraryPage — org skills panel", () => {
  beforeEach(() => {
    orgData = { id: "org_1", name: "Acme", createdAt: 0, callerRole: "admin", features: { organizations: true, ssoTeamSync: false }, ssoTeamGroups: [], allowPublicArtifacts: false };
    createSkill.mockClear();
    skillsQuery.mockClear();
    sourcesQuery.mockClear();
  });

  it("lists the org rows the server sent", () => {
    const { container } = render(<OrganizationLibraryPage />);
    expect(screen.getByText("Org playbook")).toBeTruthy();
    // One card in the org grid.
    const grid = container.querySelector(".grid");
    expect(grid?.querySelectorAll("a").length).toBe(1);
  });

  it("pins BOTH lists to the org, server-side", () => {
    render(<OrganizationLibraryPage />);

    // The two lists used to filter a whole-catalog array in the browser. That
    // is honest only while the whole catalog is in the array: with pages, an
    // org row on page two would never reach this page at all.
    expect(skillsQuery).toHaveBeenCalledWith({ ownerType: "org", ownerId: "org_1" });
    expect(sourcesQuery).toHaveBeenCalledWith({ ownerType: "org", ownerId: "org_1" });
  });

  it("offers no scope select, because the page already fixes the scope", () => {
    render(<OrganizationLibraryPage />);
    expect(screen.queryByLabelText("Filter by scope")).toBeNull();
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

  it("names that an admin adds, removes, and syncs, and that a private repo uses the GitHub App", () => {
    render(<OrganizationLibraryPage />);

    expect(screen.getByText(/An admin adds, removes, and syncs a repository/)).toBeTruthy();
    expect(screen.getAllByText(/GitHub App installed for this organization/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Any member can press Sync/)).toBeNull();
  });
});

/**
 * The editor asks nobody who owns a new skill: the page that opened it says
 * so. `defaultScope="org"` is what the org Library page's "New org skill"
 * button sets, through `/skills/new?scope=org`.
 */
describe("SkillEditor — the org scope", () => {
  beforeEach(() => {
    orgData = { id: "org_1", name: "Acme", createdAt: 0, callerRole: "admin", features: { organizations: true, ssoTeamSync: false }, ssoTeamGroups: [], allowPublicArtifacts: false };
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
