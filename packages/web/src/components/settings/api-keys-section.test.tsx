// @vitest-environment jsdom
/**
 * Team workspace API keys follow the switcher. Create states the place.
 * There is no owner picker.
 *
 * A team key row also names the member who created it: the whole team sees
 * the key, so "who minted this" is not answerable from the row without it.
 * A personal key has exactly one possible creator, so that row omits the
 * field.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { OrgDirectoryResponse, TeamApiKeySummary } from "@valet/api/wire";

const createTeamKeyMutate = vi.fn();

/** The fields `PersonalApiKeyRow` reads off a better-auth key summary. */
type PersonalKeyStub = {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: Date;
  lastRequest: Date | null;
};

let scope: { key: string; teamId: string | undefined } = { key: "team_1", teamId: "team_1" };
let teamKeys: TeamApiKeySummary[] = [];
let personalKeys: PersonalKeyStub[] = [];
let directory: OrgDirectoryResponse | undefined = { users: [] };

vi.mock("~/lib/workspace-scope", () => ({
  PERSONAL: "user",
  useWorkspaceScope: () => ({
    key: scope.key,
    teamId: scope.teamId,
    available: ["user", "team_1"],
    setKey: () => {},
  }),
}));

vi.mock("~/api/settings", () => ({
  useTeams: () => ({
    data: {
      teams: [
        {
          id: "team_1",
          orgId: "org_1",
          name: "Platform",
          origin: "local",
          externalId: null,
          createdAt: 1,
          memberCount: 2,
          callerRole: "admin",
          defaultModel: null,
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
  useOrg: () => ({
    data: { callerRole: "admin", features: { organizations: true } },
    isLoading: false,
    error: null,
  }),
  useOrgDirectory: () => ({ data: directory, isLoading: false, error: null }),
}));

vi.mock("~/api/api-keys", () => ({
  useApiKeys: () => ({ data: personalKeys, isLoading: false, error: null }),
  useCreateApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useRevokeApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useTeamApiKeys: () => ({ data: teamKeys, isLoading: false, error: null }),
  useCreateTeamApiKey: () => ({ mutate: createTeamKeyMutate, isPending: false, error: null }),
  useRevokeTeamApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

vi.mock("~/lib/use-copy", () => ({
  useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }),
}));

import { ApiKeysSection } from "./api-keys-section";

function Wrapper({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}

function teamKey(overrides: Partial<TeamApiKeySummary> = {}): TeamApiKeySummary {
  return {
    id: "key_1",
    name: "CI pipeline",
    start: "vlt_abcd",
    createdAt: Date.UTC(2026, 8, 1),
    lastRequest: null,
    createdBy: "user_dana",
    ...overrides,
  };
}

describe("ApiKeysSection — team workspace", () => {
  beforeEach(() => {
    createTeamKeyMutate.mockClear();
    scope = { key: "team_1", teamId: "team_1" };
    teamKeys = [];
    personalKeys = [];
    directory = { users: [] };
  });

  it("states the workspace and has no owner picker", () => {
    render(
      <Wrapper>
        <ApiKeysSection />
      </Wrapper>,
    );
    expect(screen.getByText(/belongs to/)).toBeTruthy();
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByLabelText(/owner/i)).toBeNull();
    expect(screen.getByText(/No API keys in Platform yet/)).toBeTruthy();
  });

  it("creates against the active team, not a picked owner", () => {
    render(<ApiKeysSection />);
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "CI" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createTeamKeyMutate).toHaveBeenCalledWith("CI", expect.objectContaining({ onSuccess: expect.any(Function) }));
  });

  it("names the member who created a team key", () => {
    teamKeys = [teamKey()];
    directory = {
      users: [
        { userId: "user_dana", email: "dana@example.com", name: "Dana Rivera", avatarUrl: null },
        { userId: "user_kit", email: "kit@example.com", name: "Kit Alvarez", avatarUrl: null },
      ],
    };
    render(<ApiKeysSection />);
    expect(screen.getByText("Created by Dana Rivera")).toBeTruthy();
  });

  it("falls back to the email when the directory carries no name", () => {
    teamKeys = [teamKey()];
    directory = {
      users: [{ userId: "user_dana", email: "dana@example.com", name: "", avatarUrl: null }],
    };
    render(<ApiKeysSection />);
    expect(screen.getByText("Created by dana@example.com")).toBeTruthy();
  });

  it("says the creator left when the directory does not carry them", () => {
    teamKeys = [teamKey({ createdBy: "user_gone" })];
    directory = {
      users: [{ userId: "user_dana", email: "dana@example.com", name: "Dana Rivera", avatarUrl: null }],
    };
    render(<ApiKeysSection />);
    expect(screen.getByText("Created by a member who left the organization")).toBeTruthy();
  });

  it("says the creator is unrecorded when the key carries no creator", () => {
    teamKeys = [teamKey({ createdBy: null })];
    render(<ApiKeysSection />);
    expect(screen.getByText("Creator not recorded")).toBeTruthy();
  });

  it("claims no creator while the member directory is still loading", () => {
    teamKeys = [teamKey()];
    directory = undefined;
    render(<ApiKeysSection />);
    expect(screen.queryByText(/Created by/)).toBeNull();
    expect(screen.getByText("CI pipeline")).toBeTruthy();
  });
});

describe("ApiKeysSection — personal workspace", () => {
  beforeEach(() => {
    scope = { key: "user", teamId: undefined };
    teamKeys = [];
    directory = { users: [] };
    personalKeys = [
      {
        id: "key_personal",
        name: "Laptop script",
        start: "vlt_wxyz",
        createdAt: new Date(Date.UTC(2026, 8, 1)),
        lastRequest: null,
      },
    ];
  });

  it("omits the creator: a personal key has one possible creator", () => {
    render(<ApiKeysSection />);
    expect(screen.getByText("Laptop script")).toBeTruthy();
    expect(screen.queryByText(/Created by/)).toBeNull();
    expect(screen.queryByText("Creator not recorded")).toBeNull();
  });
});
