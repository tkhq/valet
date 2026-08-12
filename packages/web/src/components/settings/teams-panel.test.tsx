// @vitest-environment jsdom
/**
 * TeamsPanel role gating: mutation controls (team actions menu, role
 * dropdown, remove, add-member) render only for a team admin or an org
 * admin. The API enforces the same gate (`canMutateTeam`); this suite pins
 * that the UI stops offering controls that would 404.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { OrgMemberWire } from "@valet/api/wire";

const navigate = vi.fn();
const ensureOrchestrator = vi.fn();
let ensureOrchestratorState: { isPending: boolean; error: Error | null } = {
  isPending: false,
  error: null,
};

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

let callerRole: "admin" | "member" | null = "member";
let orgRole: "admin" | "member" = "member";

const teamsData = () => ({
  teams: [
    {
      id: "team_1",
      orgId: "org_1",
      name: "Platform",
      createdAt: 1,
      memberCount: 2,
      callerRole,
    },
  ],
});

vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData(), isLoading: false, error: null }),
  useMe: () => ({ data: { orgRole }, isLoading: false, error: null }),
  useTeamMembers: () => ({
    data: {
      members: [
        { userId: "u1", role: "admin" },
        { userId: "u2", role: "member" },
      ],
    },
    isLoading: false,
    error: null,
  }),
  useCreateTeam: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteTeam: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useEnsureTeamOrchestrator: () => ({ mutate: ensureOrchestrator, ...ensureOrchestratorState }),
  useAddTeamMember: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveTeamMember: () => ({ mutate: vi.fn(), isPending: false }),
  useSetTeamMemberRole: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { TeamsPanel } from "./teams-panel";

const orgMembers: OrgMemberWire[] = [
  { userId: "u1", name: "One", email: "one@dev", role: "member", avatarUrl: null, joinedAt: 1 },
  { userId: "u2", name: "Two", email: "two@dev", role: "member", avatarUrl: null, joinedAt: 1 },
  { userId: "u3", name: "Three", email: "three@dev", role: "member", avatarUrl: null, joinedAt: 1 },
];

function openTeam() {
  render(<TeamsPanel orgMembers={orgMembers} />);
  fireEvent.click(screen.getByRole("button", { name: "Expand Platform" }));
}

describe("TeamsPanel role gating", () => {
  it("hides mutation controls from a plain team member", () => {
    callerRole = "member";
    orgRole = "member";
    openTeam();
    expect(screen.queryByRole("button", { name: "Platform actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add member/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove One/ })).toBeNull();
  });

  it("shows mutation controls to a team admin", () => {
    callerRole = "admin";
    orgRole = "member";
    openTeam();
    expect(screen.getByRole("button", { name: "Platform actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add member/ })).toBeTruthy();
  });

  it("shows mutation controls to an org admin who is not on the team", () => {
    callerRole = null;
    orgRole = "admin";
    openTeam();
    expect(screen.getByRole("button", { name: "Platform actions" })).toBeTruthy();
  });
});

describe("TeamsPanel — team orchestrator", () => {
  beforeEach(() => {
    callerRole = "member";
    orgRole = "member";
    navigate.mockClear();
    ensureOrchestrator.mockClear();
    ensureOrchestratorState = { isPending: false, error: null };
  });

  it("shows the Assistant button to a plain member, not just admins", () => {
    render(<TeamsPanel orgMembers={orgMembers} />);
    expect(screen.getByRole("button", { name: /Assistant/ })).toBeTruthy();
  });

  it("ensures the team's orchestrator and navigates to its session on success", () => {
    render(<TeamsPanel orgMembers={orgMembers} />);
    fireEvent.click(screen.getByRole("button", { name: /Assistant/ }));

    expect(ensureOrchestrator).toHaveBeenCalledWith("team_1", expect.anything());
    const [, opts] = ensureOrchestrator.mock.calls[0] as [string, { onSuccess: (r: { sessionId: string }) => void }];
    opts.onSuccess({ sessionId: "orchestrator:team:team_1" });

    expect(navigate).toHaveBeenCalledWith({
      to: "/sessions/$sessionId",
      params: { sessionId: "orchestrator:team:team_1" },
    });
  });

  it("shows the server's error inline when opening the assistant fails", () => {
    ensureOrchestratorState = { isPending: false, error: new Error("failed to open") };
    render(<TeamsPanel orgMembers={orgMembers} />);
    expect(screen.getByText(/failed to open/)).toBeTruthy();
  });
});
