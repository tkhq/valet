// @vitest-environment jsdom
/**
 * Team Integrations → the accounts a team can act as. A connection whose
 * token refresh failed keeps its row, so the row must say so and name the
 * repair, or the team keeps a dead account that looks healthy.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CredentialSummary, OrgDirectoryUserWire, TeamSummary } from "@valet/api/wire";

let teamCreds: CredentialSummary[] = [];

vi.mock("~/api/integrations", () => {
  const mutation = () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null });
  return {
    useCredentials: () => ({ data: { credentials: teamCreds }, isLoading: false, error: null }),
    useDisconnectCredential: mutation,
    useRevokeDelegation: mutation,
    useConnectCredential: mutation,
  };
});

const submitRequest = vi.fn();
vi.mock("~/api/team-deletion-requests", () => ({
  useSubmitTeamDeletionRequest: () => ({ mutate: submitRequest, reset: vi.fn(), isPending: false, error: null }),
}));

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

  it("marks a dead team connection and lets any member reconnect it", async () => {
    teamCreds = [cred({ refreshFailedAt: 1, expiresAt: 1, dead: true }), cred({ delegatedFrom: "u2" })];
    renderRows(false);
    expect(screen.getAllByText("Refresh failed")).toHaveLength(1);
    expect(screen.getByText("The last token refresh failed. Select Reconnect to sign in again.")).toBeTruthy();
    const location = { href: "" };
    vi.stubGlobal("location", location);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reconnect Greenhouse for Recruiting" }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Continue to Greenhouse" }));
    expect(location.href).toBe("/api/credentials/greenhouse/connect?scope=team&teamId=t1&reconnect=1");
    vi.unstubAllGlobals();
  });

  it("shows the provider's answer under a failed refresh", () => {
    teamCreds = [cred({ refreshFailedAt: 1, expiresAt: 1, dead: true, refreshError: "400 Refresh token has been invalidated" })];
    renderRows(false);
    expect(screen.getByText("Greenhouse replied: 400 Refresh token has been invalidated")).toBeTruthy();
  });

  it("sends an admin to disconnect a broken team connection that is not dead yet", () => {
    teamCreds = [cred({ refreshFailedAt: 1, expiresAt: Date.now() + 3_600_000 })];
    renderRows(true);
    expect(screen.getByText("The last token refresh failed. Disconnect it, then connect Greenhouse again under Available.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Reconnect/ })).toBeNull();
  });

  it("sends a member to a team admin, and a shared account to its owner", () => {
    teamCreds = [cred({ refreshFailedAt: 1 }), cred({ delegatedFrom: "u2", identityOnly: true })];
    renderRows(false);
    expect(screen.getByText("The last token refresh failed. Ask a team admin to connect Greenhouse again.")).toBeTruthy();
    expect(screen.getByText("Sign-in only")).toBeTruthy();
    expect(screen.getByText("This connection gives sign-in only. Alice must reconnect Greenhouse in their own Integrations.")).toBeTruthy();
  });

  it("lets a member ask a team admin to remove the team connection", async () => {
    teamCreds = [cred(), cred({ delegatedFrom: "u2" })];
    renderRows(false);
    const user = userEvent.setup();
    expect(screen.queryByRole("button", { name: /Stop sharing/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Request removal of Greenhouse from Recruiting" }));
    await user.click(screen.getByRole("button", { name: "Request removal" }));
    expect(submitRequest).toHaveBeenCalledWith({ resourceType: "credential", resourceId: "greenhouse" }, expect.anything());
  });

  // The delegate route refuses a share beside the team's own connection, so
  // the note promises a new share only when the team has none.
  it("promises a member can share again only when the team has no own connection", async () => {
    const user = userEvent.setup();
    const stopSharing = async () => {
      await user.click(screen.getByRole("button", { name: "Stop sharing Alice's Greenhouse with Recruiting" }));
      return screen.getByRole("dialog");
    };
    teamCreds = [cred(), cred({ delegatedFrom: "u2" })];
    renderRows(true);
    expect((await stopSharing()).textContent).toContain(
      "While Recruiting has its own Greenhouse connection, they cannot share theirs again.",
    );
    cleanup();

    teamCreds = [cred({ delegatedFrom: "u2" })];
    renderRows(true);
    expect((await stopSharing()).textContent).toContain("They can share it with the team again from Integrations.");
  });

  it("shows no health badge on working rows", () => {
    teamCreds = [cred({ expiresAt: 1 }), cred({ delegatedFrom: "u2" })];
    renderRows(true);
    expect(screen.queryByText("Refresh failed")).toBeNull();
    expect(screen.queryByText("Expired")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reconnect/ })).toBeNull();
  });
});
