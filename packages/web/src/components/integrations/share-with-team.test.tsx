// @vitest-environment jsdom
/**
 * Two rules this popover has to keep.
 *
 * 1. One verb per action. Dropping a share the caller made cuts the team's
 *    link and leaves the caller's own connection alone, so it is called
 *    "Stop sharing" here AND in the team credentials panel
 *    (`settings/teams-panel.test.tsx`, "TeamsPanel — removing a team
 *    credential"). "Disconnect" is reserved for deleting a secret the team
 *    itself stores, which this popover never does.
 * 2. Only teams the caller is on. `POST /api/credentials/:service/delegate`
 *    calls `isTeamMember` and answers 404 for every other team, so a row for
 *    a team the caller is not on can only fail.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { CredentialSummary, TeamSummary } from "@valet/api/wire";

const delegateMutate = vi.fn();
const revokeMutate = vi.fn();
let teams: TeamSummary[] = [];
let teamCreds: CredentialSummary[] = [];

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u1" } }),
  useTeams: () => ({ data: { teams }, isLoading: false, error: null }),
}));

vi.mock("~/api/integrations", () => ({
  useCredentials: () => ({ data: { credentials: teamCreds }, isLoading: false, error: null }),
  useDelegateCredential: () => ({ mutateAsync: delegateMutate, isPending: false, error: null }),
  useRevokeDelegation: () => ({ mutateAsync: revokeMutate, isPending: false, error: null }),
}));

import { ShareWithTeam } from "./share-with-team";

const TEAM: TeamSummary = {
  id: "team_1",
  orgId: "org_1",
  name: "Engineering",
  origin: "local",
  externalId: null,
  createdAt: 1,
  memberCount: 2,
  callerRole: "member",
  defaultModel: null,
  defaultReasoning: null,
};

/** Only an org admin is ever sent a team they are not on: the list route
 * gives a plain member `listTeamsForUser`, whose rows all carry a role. */
const NOT_MY_TEAM: TeamSummary = { ...TEAM, id: "team_2", name: "Platform", callerRole: null };

function openMenu() {
  render(<ShareWithTeam service="linear" title="Linear" />);
  fireEvent.click(screen.getByRole("button", { name: "Share Linear with a team" }));
}

describe("ShareWithTeam", () => {
  beforeEach(() => {
    teams = [TEAM];
    teamCreds = [];
    delegateMutate.mockReset();
    revokeMutate.mockReset();
  });

  it("shares the caller's credential with a team they belong to", async () => {
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Share Linear with Engineering" }));
    await waitFor(() =>
      expect(delegateMutate).toHaveBeenCalledWith({ service: "linear", body: { teamId: "team_1" } }),
    );
  });

  it("stops a share the caller already made", async () => {
    teamCreds = [
      {
        service: "linear",
        type: "oauth2",
        connectedAt: "2026-09-01T00:00:00Z",
        delegatedFrom: "u1",
      },
    ];
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing Linear with Engineering" }));
    await waitFor(() =>
      expect(revokeMutate).toHaveBeenCalledWith({ service: "linear", teamId: "team_1" }),
    );
  });

  it("calls the removal Stop sharing, the label the team credentials panel uses", () => {
    // The button dropped the team's link before this change too, but called
    // it "Revoke" while the settings panel called the same action
    // "Disconnect". Neither word may come back.
    teamCreds = [
      {
        service: "linear",
        type: "oauth2",
        connectedAt: "2026-09-01T00:00:00Z",
        delegatedFrom: "u1",
      },
    ];
    openMenu();
    expect(screen.getByRole("button", { name: /^Stop sharing/ }).textContent).toBe("Stop sharing");
    expect(screen.queryByRole("button", { name: /Revoke/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Disconnect/ })).toBeNull();
  });

  it("leaves out a team the caller is not on", () => {
    // The delegate route answers 404 for a non-member, so this row could
    // only ever fail. An org admin is the only caller who is sent one.
    teams = [TEAM, NOT_MY_TEAM];
    openMenu();
    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(screen.queryByText("Platform")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share Linear with Platform" })).toBeNull();
  });

  it("tells an org admin why the org's other teams are missing", () => {
    teams = [TEAM, NOT_MY_TEAM];
    openMenu();
    expect(
      screen.getByText(
        "Teams you are not on are not listed. Add yourself to a team in Settings → Organization → Teams to share with it.",
      ),
    ).toBeTruthy();
  });

  it("says nothing about hidden teams to a member, who is sent none", () => {
    teams = [TEAM];
    openMenu();
    expect(screen.queryByText(/are not listed/)).toBeNull();
  });

  it("tells a member with no team who can add them", () => {
    teams = [];
    openMenu();
    expect(
      screen.getByText(
        "You are not on a team yet. Ask a team admin to add you, then share your Linear connection.",
      ),
    ).toBeTruthy();
  });

  it("tells an org admin on no team where to add themselves", () => {
    // Every team was filtered out, so the hidden-team note is the whole
    // answer: it names the page where an org admin joins one.
    teams = [NOT_MY_TEAM];
    openMenu();
    expect(screen.queryByText(/Ask a team admin to add you/)).toBeNull();
    expect(screen.getByText(/Add yourself to a team in Settings → Organization → Teams/)).toBeTruthy();
  });
});
