// @vitest-environment jsdom
/**
 * Team Integrations → the accounts a team can act as. A connection whose
 * token refresh failed keeps its row, so the row must say so and name the
 * repair, or the team keeps a dead account that looks healthy.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CredentialSummary, OrgDirectoryUserWire, TeamSummary } from "@valet/api/wire";

let teamCreds: CredentialSummary[] = [];

vi.mock("~/api/integrations", () => {
  const mutation = () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null });
  return {
    useCredentials: () => ({ data: { credentials: teamCreds }, isLoading: false, error: null }),
    useDisconnectCredential: mutation,
    useRevokeDelegation: mutation,
  };
});

import { TeamCredentials } from "./team-credentials";

const team: TeamSummary = {
  id: "t1", orgId: "o1", name: "Recruiting", origin: "local", externalId: null, createdAt: 0,
  memberCount: 2, callerRole: "admin", defaultModel: null,
};
const member: OrgDirectoryUserWire = { userId: "u2", email: "alice@example.com", name: "Alice", avatarUrl: null };
const cred = (over: Partial<CredentialSummary> = {}): CredentialSummary => ({
  service: "greenhouse",
  type: "oauth2",
  connectedAt: "2026-09-01T00:00:00Z",
  ...over,
});

function renderRows(canMutate: boolean) {
  render(
    <TeamCredentials cards team={team} orgMembers={[member]} canMutate={canMutate} />,
  );
}

describe("TeamCredentials", () => {
  beforeEach(() => {
    teamCreds = [];
  });

  it("marks the team connection whose refresh failed and names the repair", () => {
    teamCreds = [cred({ refreshFailedAt: 1, expiresAt: 1 }), cred({ delegatedFrom: "u2" })];
    renderRows(true);
    expect(screen.getAllByText("Refresh failed")).toHaveLength(1);
    expect(screen.getByText("The last token refresh failed. Disconnect it, then connect Greenhouse again under Available.")).toBeTruthy();
  });

  it("sends a member to a team admin, and a shared account to its owner", () => {
    teamCreds = [cred({ refreshFailedAt: 1 }), cred({ delegatedFrom: "u2", identityOnly: true })];
    renderRows(false);
    expect(screen.getByText("The last token refresh failed. Ask a team admin to connect Greenhouse again.")).toBeTruthy();
    expect(screen.getByText("Sign-in only")).toBeTruthy();
    expect(screen.getByText("This connection gives sign-in only. Alice must reconnect Greenhouse in their own Integrations.")).toBeTruthy();
  });

  it("shows no health badge on working rows", () => {
    teamCreds = [cred({ expiresAt: 1 }), cred({ delegatedFrom: "u2" })];
    renderRows(true);
    expect(screen.queryByText("Refresh failed")).toBeNull();
    expect(screen.queryByText("Expired")).toBeNull();
  });
});
