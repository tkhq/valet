// @vitest-environment jsdom
/**
 * TeamsPanel role gating: mutation controls (team actions menu, role
 * dropdown, remove, add-member) render only for a team admin or an org
 * admin. The API enforces the same gate (`canMutateTeam`); this suite pins
 * that the UI stops offering controls that would 404.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { OrgMemberWire } from "@valet/api/wire";

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

vi.mock("@tanstack/react-router", () => ({
  Link: RouterLinkStub,
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

/**
 * The Assistant control is a plain cross-link into `/chat`, which owns the
 * get-or-create. Settings is no longer the door to a team's assistant — it
 * is one entrance among several (the chat rail, the dashboard card, the
 * owner badges), so this row creates nothing and needs no pending or error
 * state of its own.
 */
describe("TeamsPanel — team assistant link", () => {
  beforeEach(() => {
    callerRole = "member";
    orgRole = "member";
  });

  it("shows the Assistant link to a plain member, not just admins", () => {
    render(<TeamsPanel orgMembers={orgMembers} />);
    expect(screen.getByRole("link", { name: /Assistant/ })).toBeTruthy();
  });

  it("points at the team's assistant on /chat", () => {
    render(<TeamsPanel orgMembers={orgMembers} />);
    const link = screen.getByRole("link", { name: /Assistant/ });
    expect(link.getAttribute("href")).toBe("/chat?team=team_1");
  });
});
