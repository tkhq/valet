// @vitest-environment jsdom
/**
 * Organization sections (split-settings design, Task 7): General's rename +
 * disable-gate confirm flow, Members' roster + role change + sole-admin
 * disable + footer copy, and Teams' create/duplicate-409/delete/add-member
 * flows over the (extended) `/api/teams` router. Mocks `~/api/settings` the
 * same way `-settings.sections.test.tsx` mocks it for the You sections —
 * these tests only care what each section renders and which mutation it
 * fires, not that TanStack Query or the router themselves resolve anything.
 */
import type { ReactElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "~/api/client";
import { TooltipProvider } from "~/components/primitives";

function renderWithTooltip(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const patchOrgMutate = vi.fn();
const patchOrgMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const setOrgMemberRoleMutate = vi.fn();
const navigateMock = vi.fn();

const createTeamMutate = vi.fn();
const deleteTeamMutate = vi.fn();
const addTeamMemberMutate = vi.fn();
const setTeamMemberRoleMutate = vi.fn();
const removeTeamMemberMutate = vi.fn();

let orgData: {
  id: string;
  name: string;
  createdAt: number;
  callerRole: "admin" | "member";
  features: { organizations: boolean };
} = {
  id: "org_1",
  name: "Acme",
  createdAt: 0,
  callerRole: "admin",
  features: { organizations: true },
};

let orgMembersData: {
  members: Array<{
    userId: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    role: "admin" | "member";
    joinedAt: number;
  }>;
} = {
  members: [
    { userId: "u1", email: "ada@x.test", name: "Ada", avatarUrl: null, role: "admin", joinedAt: 0 },
    { userId: "u2", email: "grace@x.test", name: "Grace", avatarUrl: null, role: "member", joinedAt: 0 },
  ],
};

let teamsData: { teams: Array<{ id: string; orgId: string; name: string; createdAt: number; memberCount: number }> } = {
  teams: [{ id: "team_1", orgId: "org_1", name: "Platform", createdAt: 0, memberCount: 1 }],
};

let teamMembersData: { members: Array<{ userId: string; role: "admin" | "member" }> } = {
  members: [{ userId: "u1", role: "admin" }],
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => navigateMock,
}));

vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
  usePatchOrg: () => ({
    mutate: patchOrgMutate,
    mutateAsync: patchOrgMutateAsync,
    isPending: false,
    error: null,
  }),
  useOrgMembers: () => ({ data: orgMembersData, isLoading: false, error: null }),
  useSetOrgMemberRole: () => ({ mutate: setOrgMemberRoleMutate, isPending: false, error: null }),
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useTeamMembers: () => ({ data: teamMembersData, isLoading: false, error: null }),
  useCreateTeam: () => ({ mutate: createTeamMutate, isPending: false, error: null }),
  useDeleteTeam: () => ({ mutate: deleteTeamMutate, isPending: false, error: null }),
  useAddTeamMember: () => ({ mutate: addTeamMemberMutate, isPending: false, error: null }),
  useSetTeamMemberRole: () => ({ mutate: setTeamMemberRoleMutate, isPending: false, error: null }),
  useRemoveTeamMember: () => ({ mutate: removeTeamMemberMutate, isPending: false, error: null }),
}));

import { OrganizationGeneralPage } from "./settings.organization.index";
import { OrganizationMembersPage } from "./settings.organization.members";
import { OrganizationTeamsPage } from "./settings.organization.teams";

beforeEach(() => {
  vi.clearAllMocks();
  orgData = {
    id: "org_1",
    name: "Acme",
    createdAt: 0,
    callerRole: "admin",
    features: { organizations: true },
  };
  orgMembersData = {
    members: [
      { userId: "u1", email: "ada@x.test", name: "Ada", avatarUrl: null, role: "admin", joinedAt: 0 },
      { userId: "u2", email: "grace@x.test", name: "Grace", avatarUrl: null, role: "member", joinedAt: 0 },
    ],
  };
  teamsData = {
    teams: [{ id: "team_1", orgId: "org_1", name: "Platform", createdAt: 0, memberCount: 1 }],
  };
  teamMembersData = { members: [{ userId: "u1", role: "admin" }] };
});

describe("OrganizationGeneralPage", () => {
  it("renames the org on Save", () => {
    render(<OrganizationGeneralPage />);
    const nameInput = screen.getByLabelText("Organization name");
    fireEvent.change(nameInput, { target: { value: "Acme Corp" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(patchOrgMutate).toHaveBeenCalledWith({ name: "Acme Corp" });
  });

  it("shows read-only id and created rows", () => {
    render(<OrganizationGeneralPage />);
    expect(screen.getByLabelText("Organization ID")).toHaveProperty("value", "org_1");
  });

  it("confirming the disable-gate dialog PATCHes the gate off and navigates to profile", async () => {
    render(<OrganizationGeneralPage />);
    fireEvent.click(screen.getByRole("button", { name: "Turn off organization features" }));
    expect(
      screen.getByText(/Nothing is deleted/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));

    await waitFor(() =>
      expect(patchOrgMutateAsync).toHaveBeenCalledWith({ features: { organizations: false } }),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/settings/profile" }));
  });
});

describe("OrganizationMembersPage", () => {
  it("renders member rows with name, email, and joined date", () => {
    renderWithTooltip(<OrganizationMembersPage />);
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("ada@x.test")).toBeTruthy();
    expect(screen.getByText("Grace")).toBeTruthy();
    expect(screen.getByText("grace@x.test")).toBeTruthy();
  });

  it("shows the spec-verbatim footer note", () => {
    renderWithTooltip(<OrganizationMembersPage />);
    expect(screen.getByText("Invites arrive with real login.")).toBeTruthy();
  });

  it("disables the sole admin's role control with the last-admin tooltip", () => {
    renderWithTooltip(<OrganizationMembersPage />);
    const adminButtons = screen.getAllByRole("button", { name: /Admin/ });
    // Ada is the sole admin — her role button must be disabled.
    const adaButton = adminButtons.find((b) => (b as HTMLButtonElement).disabled);
    expect(adaButton).toBeDefined();
  });

  it("changing a non-sole-admin member's role fires the PATCH mutation", async () => {
    const user = userEvent.setup();
    renderWithTooltip(<OrganizationMembersPage />);
    const memberButton = screen.getByRole("button", { name: /Member/ });
    await user.click(memberButton);
    await user.click(await screen.findByRole("menuitem", { name: "Admin" }));
    expect(setOrgMemberRoleMutate).toHaveBeenCalledWith({
      userId: "u2",
      body: { role: "admin" },
    });
  });

  it("does not disable the role control when there are two admins", () => {
    orgMembersData = {
      members: [
        { userId: "u1", email: "ada@x.test", name: "Ada", avatarUrl: null, role: "admin", joinedAt: 0 },
        { userId: "u2", email: "grace@x.test", name: "Grace", avatarUrl: null, role: "admin", joinedAt: 0 },
      ],
    };
    renderWithTooltip(<OrganizationMembersPage />);
    const adminButtons = screen.getAllByRole("button", { name: /Admin/ });
    for (const b of adminButtons) expect((b as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("OrganizationTeamsPage", () => {
  it("renders the team list with member counts", () => {
    render(<OrganizationTeamsPage />);
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.getByText("1 member")).toBeTruthy();
  });

  it("creating a team fires the create mutation", () => {
    render(<OrganizationTeamsPage />);
    fireEvent.change(screen.getByLabelText("New team name"), { target: { value: "Design" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createTeamMutate).toHaveBeenCalledWith(
      { name: "Design" },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it("shows a duplicate-name error under the field on a 409", () => {
    createTeamMutate.mockImplementation((_body, opts) => {
      opts.onError(new ApiError(409, "POST /teams → 409"));
    });
    render(<OrganizationTeamsPage />);
    fireEvent.change(screen.getByLabelText("New team name"), { target: { value: "Platform" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByText("A team with that name already exists.")).toBeTruthy();
  });

  it("expanding a team and adding a member fires the add-member mutation", async () => {
    const user = userEvent.setup();
    render(<OrganizationTeamsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Platform" }));
    await user.click(screen.getByRole("button", { name: "Add member" }));
    await user.click(await screen.findByText("Grace"));
    expect(addTeamMemberMutate).toHaveBeenCalledWith({
      teamId: "team_1",
      body: { userId: "u2", role: "member" },
    });
  });

  it("deleting a team via the overflow menu confirms, then fires the delete mutation", async () => {
    const user = userEvent.setup();
    render(<OrganizationTeamsPage />);
    await user.click(screen.getByRole("button", { name: "Platform actions" }));
    await user.click(await screen.findByText("Delete team"));
    expect(screen.getByText("Delete Platform?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete team" }));
    expect(deleteTeamMutate).toHaveBeenCalledWith("team_1", expect.objectContaining({
      onSuccess: expect.any(Function),
    }));
  });
});
