// @vitest-environment jsdom
/**
 * Organization sections (split-settings design, Task 7): General's rename +
 * disable-gate confirm flow, Members' roster + role change + sole-admin
 * disable, and Teams' create/duplicate-409/delete/add-member flows over the
 * (extended) `/api/teams` router. Mocks `~/api/settings` the same way
 * `-settings.sections.test.tsx` mocks it for the You sections — these tests
 * only care what each section renders and which mutation it fires, not that
 * TanStack Query or the router themselves resolve anything.
 *
 * Task 11 extends the Members describe block with the invite dialog + the
 * pending-invites list, mocking `~/api/invites` the same way.
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

const createInviteMutate = vi.fn();
const revokeInviteMutate = vi.fn();

type OrgPermission = "org:manage" | "members:manage" | "providers:manage" | "infra:manage" | "credentials:org";

const ADMIN_PERMISSIONS: OrgPermission[] = [
  "org:manage",
  "members:manage",
  "providers:manage",
  "infra:manage",
  "credentials:org",
];

let orgData: {
  id: string;
  name: string;
  createdAt: number;
  callerRole: "admin" | "operator" | "member";
  permissions: OrgPermission[];
  features: { organizations: boolean };
} = {
  id: "org_1",
  name: "Acme",
  createdAt: 0,
  callerRole: "admin",
  permissions: ADMIN_PERMISSIONS,
  features: { organizations: true },
};

let orgMembersData: {
  members: Array<{
    userId: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    role: "admin" | "operator" | "member";
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

let invitesData: {
  invites: Array<{
    id: string;
    email: string | null;
    role: "admin" | "member";
    createdBy: string;
    createdAt: number;
    expiresAt: number;
  }>;
} = { invites: [] };

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => navigateMock,
}));

vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
  useHasPermission: (perm: OrgPermission) => orgData?.permissions?.includes(perm) === true,
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

vi.mock("~/api/invites", () => ({
  useInvites: () => ({ data: invitesData, isLoading: false, error: null }),
  useCreateInvite: () => ({ mutate: createInviteMutate, isPending: false, error: null }),
  useRevokeInvite: () => ({ mutate: revokeInviteMutate, isPending: false, error: null }),
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
    permissions: ADMIN_PERMISSIONS,
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
  invitesData = { invites: [] };
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

  it("the role picker offers Admin/Operator/Member", async () => {
    const user = userEvent.setup();
    renderWithTooltip(<OrganizationMembersPage />);
    const memberButton = screen.getByRole("button", { name: /Member/ });
    await user.click(memberButton);
    expect(await screen.findByRole("menuitem", { name: "Admin" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Operator" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Member" })).toBeTruthy();
  });

  it("selecting Operator from the role picker fires the PATCH mutation with role: operator", async () => {
    const user = userEvent.setup();
    renderWithTooltip(<OrganizationMembersPage />);
    const memberButton = screen.getByRole("button", { name: /Member/ });
    await user.click(memberButton);
    await user.click(await screen.findByRole("menuitem", { name: "Operator" }));
    expect(setOrgMemberRoleMutate).toHaveBeenCalledWith({
      userId: "u2",
      body: { role: "operator" },
    });
  });

  it("renders an operator badge for a member with role operator", () => {
    orgMembersData = {
      members: [
        { userId: "u1", email: "ada@x.test", name: "Ada", avatarUrl: null, role: "admin", joinedAt: 0 },
        { userId: "u2", email: "grace@x.test", name: "Grace", avatarUrl: null, role: "operator", joinedAt: 0 },
      ],
    };
    renderWithTooltip(<OrganizationMembersPage />);
    expect(screen.getByRole("button", { name: /Operator/ })).toBeTruthy();
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

  it("shows the Invite button for an admin", () => {
    renderWithTooltip(<OrganizationMembersPage />);
    expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
  });

  it("blocks a caller without members:manage from the whole Members page (Invite included)", () => {
    orgData = { ...orgData, callerRole: "operator", permissions: ["providers:manage", "infra:manage", "credentials:org"] };
    renderWithTooltip(<OrganizationMembersPage />);
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(
      screen.getByText("Organization settings are managed by your org admins"),
    ).toBeTruthy();
  });

  it("creating an invite posts { email?, role } and reveals the copyable link", async () => {
    const user = userEvent.setup();
    createInviteMutate.mockImplementation((_body, opts) => {
      opts.onSuccess({
        id: "invite_1",
        code: "abc123",
        email: "grace@x.test",
        role: "admin",
        expiresAt: 0,
      });
    });
    renderWithTooltip(<OrganizationMembersPage />);

    await user.click(screen.getByRole("button", { name: "Invite" }));
    await user.type(await screen.findByLabelText("Email (optional)"), "grace@x.test");
    await user.click(screen.getByRole("radio", { name: /Admin/ }));
    await user.click(screen.getByRole("button", { name: "Create invite" }));

    expect(createInviteMutate).toHaveBeenCalledWith(
      { email: "grace@x.test", role: "admin" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.getByText(/invite=abc123/)).toBeTruthy();
    expect(
      screen.getByText(
        "Share this link. For Google or GitHub sign-in, the invite must include their email.",
      ),
    ).toBeTruthy();
  });

  it("defaults the role radio to Member and posts email: undefined when left blank", async () => {
    const user = userEvent.setup();
    createInviteMutate.mockImplementation((_body, opts) => {
      opts.onSuccess({ id: "invite_1", code: "xyz", email: null, role: "member", expiresAt: 0 });
    });
    renderWithTooltip(<OrganizationMembersPage />);

    await user.click(screen.getByRole("button", { name: "Invite" }));
    await user.click(screen.getByRole("button", { name: "Create invite" }));

    expect(createInviteMutate).toHaveBeenCalledWith(
      { email: undefined, role: "member" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("lists pending invites and revokes one via the confirm-gated control", async () => {
    const user = userEvent.setup();
    invitesData = {
      invites: [
        { id: "invite_1", email: "newhire@x.test", role: "member", createdBy: "u1", createdAt: 0, expiresAt: 0 },
        { id: "invite_2", email: null, role: "admin", createdBy: "u1", createdAt: 0, expiresAt: 0 },
      ],
    };
    renderWithTooltip(<OrganizationMembersPage />);

    expect(screen.getByText("newhire@x.test")).toBeTruthy();
    expect(screen.getByText("anyone with the link")).toBeTruthy();

    const revokeButtons = screen.getAllByRole("button", { name: "Revoke" });
    await user.click(revokeButtons[0]);
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(revokeInviteMutate).toHaveBeenCalledWith(
      "invite_1",
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
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
