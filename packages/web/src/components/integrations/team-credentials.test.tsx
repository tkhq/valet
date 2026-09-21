// @vitest-environment jsdom
/**
 * A team's Google Workspace row carries a Drive folder scope like a personal
 * one does. Who may change it follows who owns the connection: a team admin
 * on the team's own connection, nobody on one a member shared (the scope is
 * the member's), and a plain member only sees it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CredentialSummary, OrgDirectoryUserWire, TeamSummary } from "@valet/api/wire";

let rows: CredentialSummary[] = [];
let savedFolderIds: string[] | null = null;
const scopeTeams: Array<string | undefined> = [];

vi.mock("~/api/integrations", () => ({
  useCredentials: () => ({ data: { credentials: rows }, isLoading: false, error: null }),
  useDisconnectCredential: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
  useDriveFolderScope: (_service: string, opts?: { teamId?: string }) => {
    scopeTeams.push(opts?.teamId);
    return { data: { folderIds: savedFolderIds }, isLoading: false, error: null };
  },
  useDriveFolders: () => ({ data: { parentId: "root", folders: [] }, isLoading: false, error: null }),
  useSetDriveFolderScope: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));

import { TeamCredentials } from "./team-credentials";

const TEAM: TeamSummary = {
  id: "team-1",
  orgId: "org-1",
  name: "Platform",
  origin: "local",
  externalId: null,
  createdAt: 0,
  memberCount: 2,
  callerRole: "admin",
  defaultModel: null,
  defaultReasoning: null,
};

const MEMBERS = [{ userId: "u-alice", name: "Alice", email: "alice@example.com" }] as OrgDirectoryUserWire[];

function row(over: Partial<CredentialSummary> = {}): CredentialSummary {
  return { service: "google_workspace", type: "oauth2", connectedAt: "2026-09-21T00:00:00.000Z", ...over };
}

describe("TeamCredentials — Drive folders", () => {
  beforeEach(() => {
    rows = [];
    savedFolderIds = null;
    scopeTeams.length = 0;
  });

  it("offers the folder picker on the team's own connection to a team admin", () => {
    rows = [row()];
    render(<TeamCredentials team={TEAM} orgMembers={MEMBERS} canMutate />);

    expect(screen.getByRole("button", { name: "Choose which Drive folders Google Workspace may use" })).toBeTruthy();
    // It reads the team's scope, not the signed-in admin's own.
    expect(scopeTeams).toContain("team-1");
  });

  it("shows a shared connection's scope as a line and offers no control", () => {
    rows = [row({ delegatedFrom: "u-alice" })];
    savedFolderIds = ["f1"];
    render(<TeamCredentials team={TEAM} orgMembers={MEMBERS} canMutate />);

    expect(screen.getByText("Limited to 1 folder by Alice.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Choose which Drive folders/ })).toBeNull();
  });

  it("shows a plain member the scope without a control", () => {
    rows = [row()];
    savedFolderIds = ["f1", "f2"];
    render(<TeamCredentials team={TEAM} orgMembers={MEMBERS} canMutate={false} />);

    expect(screen.getByText("Limited to 2 folders.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Choose which Drive folders/ })).toBeNull();
  });

  it("adds nothing to other services", () => {
    rows = [row({ service: "linear" })];
    render(<TeamCredentials team={TEAM} orgMembers={MEMBERS} canMutate />);

    expect(screen.queryByRole("button", { name: /Choose which Drive folders/ })).toBeNull();
    expect(scopeTeams).toHaveLength(0);
  });
});
