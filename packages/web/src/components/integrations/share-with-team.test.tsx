// @vitest-environment jsdom
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

describe("ShareWithTeam", () => {
  beforeEach(() => {
    teams = [TEAM];
    teamCreds = [];
    delegateMutate.mockReset();
    revokeMutate.mockReset();
  });

  it("shares the caller's credential with a team they belong to", async () => {
    render(<ShareWithTeam service="linear" title="Linear" />);
    fireEvent.click(screen.getByRole("button", { name: "Share Linear with a team" }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() =>
      expect(delegateMutate).toHaveBeenCalledWith({ service: "linear", body: { teamId: "team_1" } }),
    );
  });

  it("revokes a share the caller already made", async () => {
    teamCreds = [
      {
        service: "linear",
        type: "oauth2",
        connectedAt: "2026-09-01T00:00:00Z",
        delegatedFrom: "u1",
      },
    ];
    render(<ShareWithTeam service="linear" title="Linear" />);
    fireEvent.click(screen.getByRole("button", { name: "Share Linear with a team" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(revokeMutate).toHaveBeenCalledWith({ service: "linear", teamId: "team_1" }),
    );
  });
});
