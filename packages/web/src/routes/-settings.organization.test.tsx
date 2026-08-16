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
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TeamSummary } from "@valet/api/wire";
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

/** Renders a real anchor so `getByRole("link")` and href assertions work
 * without mounting a router. */
function RouterLinkStub({
  to,
  search,
  children,
  className,
}: {
  to: string;
  search?: Record<string, string | undefined>;
  children: ReactNode;
  className?: string;
}) {
  const params = Object.entries(search ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const qs = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  return (
    <a href={`${to}${qs}`} className={className}>
      {children}
    </a>
  );
}

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

// Typed as the real wire shape, not a local literal: a field added to
// `TeamSummary` then breaks this fixture at compile time instead of letting
// the panel render against a shape the API no longer sends.
let teamsData: { teams: TeamSummary[] } = {
  teams: [
    { id: "team_1", orgId: "org_1", name: "Platform", origin: "local", externalId: null, createdAt: 0, memberCount: 1, callerRole: "admin" },
  ],
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
  // `RouterLinkStub` over a bare anchor: it renders a real `href` from `to`
  // and `search`, which the link assertions below need.
  Link: RouterLinkStub,
}));

// The teams panel links to each team's DEFAULT assistant, whose id only the
// assistants list carries.
vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({
      data: {
        assistants: [
          {
            id: "asst_team_1",
            owner: { type: "team" as const, id: "team_1" },
            sessionId: "assistant:asst_team_1",
            isDefault: true,
            createdAt: 1,
          },
        ],
      },
      isLoading: false,
      error: null,
    }),
  };
});

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
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
    useMe: () => ({ data: { orgRole: "admin" }, isLoading: false, error: null }),
    useTeamMembers: () => ({ data: teamMembersData, isLoading: false, error: null }),
    useCreateTeam: () => ({ mutate: createTeamMutate, isPending: false, error: null }),
    useDeleteTeam: () => ({ mutate: deleteTeamMutate, isPending: false, error: null }),
    useAddTeamMember: () => ({ mutate: addTeamMemberMutate, isPending: false, error: null }),
    useSetTeamMemberRole: () => ({ mutate: setTeamMemberRoleMutate, isPending: false, error: null }),
    useRemoveTeamMember: () => ({ mutate: removeTeamMemberMutate, isPending: false, error: null }),
  };
});

vi.mock("~/api/invites", () => ({
  useInvites: () => ({ data: invitesData, isLoading: false, error: null }),
  useCreateInvite: () => ({ mutate: createInviteMutate, isPending: false, error: null }),
  useRevokeInvite: () => ({ mutate: revokeInviteMutate, isPending: false, error: null }),
}));

const addSourceMutate = vi.fn();
let orgSourcesData: {
  sources: Array<{
    id: string;
    repo: string;
    ref: string;
    subpath: string;
    ownerType: "user" | "team" | "org";
    ownerId: string;
    enabled: boolean;
    status: "pending" | "ok" | "warning" | "error";
    skillCount: number;
    lastSyncedAt: number | null;
    lastSha: string | null;
    lastMessage: string | null;
  }>;
} = { sources: [] };

vi.mock("~/api/skill-sources", () => ({
  useSkillSources: () => ({ data: orgSourcesData, isLoading: false, error: null }),
  useAddSkillSource: () => ({ mutate: addSourceMutate, isPending: false, error: null }),
  useSyncSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveSkillSource: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The Library page's org skills panel reads the shared skills catalog.
vi.mock("~/api/skills", () => ({
  useSkills: () => ({ data: { skills: [] }, isLoading: false, error: null }),
}));

import { OrganizationGeneralPage } from "./settings.organization.index";
import { OrganizationMembersPage } from "./settings.organization.members";
import { OrganizationTeamsPage } from "./settings.organization.teams";
import { OrganizationLibraryPage } from "./settings.organization.library";

function orgSource(over: Record<string, unknown> = {}) {
  return {
    id: "s_org",
    repo: "tkhq/org-skills",
    ref: "",
    subpath: "",
    ownerType: "org" as const,
    ownerId: "org_1",
    enabled: true,
    status: "ok" as const,
    skillCount: 2,
    lastSyncedAt: null,
    lastSha: null,
    lastMessage: null,
    ...over,
  };
}

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
    teams: [
      { id: "team_1", orgId: "org_1", name: "Platform", origin: "local", externalId: null, createdAt: 0, memberCount: 1, callerRole: "admin" },
    ],
  };
  teamMembersData = { members: [{ userId: "u1", role: "admin" }] };
  invitesData = { invites: [] };
  orgSourcesData = { sources: [] };
});

describe("OrganizationGeneralPage", () => {
  it("renames the org on Save", () => {
    render(<OrganizationGeneralPage />);
    const nameInput = screen.getByLabelText("Organization name");
    fireEvent.change(nameInput, { target: { value: "Acme Corp" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(patchOrgMutate).toHaveBeenCalledWith({ name: "Acme Corp" });
  });

  it("shows the read-only id row", () => {
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

  it("hides the Invite button for a non-admin", () => {
    orgData = { ...orgData, callerRole: "member" };
    renderWithTooltip(<OrganizationMembersPage />);
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
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

  describe("identity-provider-managed teams", () => {
    // Admin on purpose: the controls below are gated on authorization AND
    // on origin, so a member fixture would pass for the wrong reason. This
    // one proves the origin gate holds even for somebody allowed to mutate.
    const mirrored: TeamSummary = {
      id: "team_2",
      orgId: "org_1",
      name: "platform",
      origin: "idp",
      externalId: "/platform",
      createdAt: 0,
      memberCount: 1,
      callerRole: "admin",
    };

    it("marks the team and offers no actions menu", () => {
      teamsData = { teams: [mirrored] };
      render(<OrganizationTeamsPage />);

      expect(screen.getByText("Identity provider")).toBeTruthy();
      // The menu holds Delete only, and the API refuses it. An empty menu
      // would be a control the reader cannot use.
      expect(screen.queryByRole("button", { name: "platform actions" })).toBeNull();
    });

    it("offers no membership controls, and says why, naming the group", async () => {
      teamsData = { teams: [mirrored] };
      render(<OrganizationTeamsPage />);
      fireEvent.click(screen.getByRole("button", { name: "Expand platform" }));

      // The reason sits with the roster, where the controls would be.
      expect(
        screen.getByText(/Membership comes from identity provider group \/platform\./),
      ).toBeTruthy();
      expect(screen.getByText(/sign in again/)).toBeTruthy();

      expect(screen.queryByRole("button", { name: "Add member" })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
      // The role still shows, as a fact rather than a menu.
      expect(screen.getByText("Admin")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Admin/ })).toBeNull();
    });

    it("leaves a local team beside it fully editable", async () => {
      const user = userEvent.setup();
      teamsData = { teams: [teamsData.teams[0], mirrored] };
      render(<OrganizationTeamsPage />);

      expect(screen.getByRole("button", { name: "Platform actions" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Expand Platform" }));
      await user.click(screen.getByRole("button", { name: "Add member" }));
      await user.click(await screen.findByText("Grace"));
      expect(addTeamMemberMutate).toHaveBeenCalledWith({
        teamId: "team_1",
        body: { userId: "u2", role: "member" },
      });
    });
  });
});

describe("OrganizationLibraryPage", () => {
  it("shows only org sources with a scope badge", () => {
    orgSourcesData = {
      sources: [
        orgSource(),
        {
          ...orgSource({ id: "s_personal", repo: "me/mine", ownerType: "user", ownerId: "u1" }),
        },
      ],
    };
    render(<OrganizationLibraryPage />);
    expect(screen.getByText("tkhq/org-skills")).toBeTruthy();
    expect(screen.queryByText("me/mine")).toBeNull();
    expect(screen.getByText("Org")).toBeTruthy();
  });

  it("an admin adds an org-scoped source", () => {
    render(<OrganizationLibraryPage />);
    fireEvent.click(screen.getByRole("button", { name: /import/i }));
    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), {
      target: { value: "tkhq/org-skills" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /import a skill repository/i }));
    expect(addSourceMutate).toHaveBeenCalledWith({ repo: "tkhq/org-skills", ownerType: "org" });
  });

  it("a member sees status but no Sync, Remove, or import controls", () => {
    orgData = { ...orgData, callerRole: "member" };
    orgSourcesData = { sources: [orgSource()] };
    render(<OrganizationLibraryPage />);
    expect(screen.getByText("tkhq/org-skills")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^sync$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /import/i })).toBeNull();
  });
});
