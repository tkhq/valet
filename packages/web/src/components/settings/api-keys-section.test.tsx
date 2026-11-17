// @vitest-environment jsdom
/**
 * Team workspace API keys follow the switcher. Create states the place.
 * There is no owner picker.
 *
 * A team key row also names the member who created it: the whole team sees
 * the key, so "who minted this" is not answerable from the row without it.
 * A personal key has exactly one possible creator, so that row omits the
 * field.
 *
 * Both create forms offer an expiry (auth v2 design, update of 2026-11-17):
 * 90 days first, no "No expiry" or longer choice under an org maximum, and
 * a managed note instead of the personal form when the org turns personal
 * keys off.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { OrgDirectoryResponse, TeamApiKeySummary } from "@valet/api/wire";

const createTeamKeyMutate = vi.fn();
const createTeamKeyTarget = vi.fn();
const createPersonalKeyMutate = vi.fn();

/** The fields `PersonalApiKeyRow` reads off a better-auth key summary. */
type PersonalKeyStub = {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: Date;
  lastRequest: Date | null;
  expiresAt: Date | null;
};

type OrgStub = {
  callerRole: "admin" | "member";
  features: { organizations: boolean };
  allowPersonalApiKeys?: boolean;
  maxApiKeyLifetimeDays?: number | null;
};

let scope: { key: string; teamId: string | undefined } = { key: "team_1", teamId: "team_1" };
let teamKeys: TeamApiKeySummary[] = [];
let personalKeys: PersonalKeyStub[] = [];
let directory: OrgDirectoryResponse | undefined = { users: [] };
let org: OrgStub = { callerRole: "admin", features: { organizations: true } };

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
        {
          id: "team_2", orgId: "org_1", name: "Support", origin: "local", externalId: null,
          createdAt: 1, memberCount: 2, callerRole: "admin", defaultModel: null,
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
  useOrg: () => ({ data: org, isLoading: false, error: null }),
  useOrgDirectory: () => ({ data: directory, isLoading: false, error: null }),
}));

vi.mock("~/api/api-keys", () => ({
  useApiKeys: () => ({ data: personalKeys, isLoading: false, error: null }),
  useCreateApiKey: () => ({ mutate: createPersonalKeyMutate, isPending: false, error: null }),
  useRevokeApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useTeamApiKeys: () => ({ data: teamKeys, isLoading: false, error: null }),
  useCreateTeamApiKey: (teamId: string) => ({
    mutate: (name: string, options: unknown) => {
      createTeamKeyTarget(teamId, name);
      createTeamKeyMutate(name, options);
    },
    isPending: false,
    error: null,
  }),
  useRevokeTeamApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

vi.mock("~/lib/use-copy", () => ({
  useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useRouterState: () => "/settings/api-keys",
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>,
  Outlet: () => <ApiKeysSection />,
}));

import { ApiKeysSection } from "./api-keys-section";

const DAY = 86_400;

function expirySelect(): HTMLSelectElement {
  const el = screen.getByLabelText("Key expiry");
  if (!(el instanceof HTMLSelectElement)) throw new Error("Key expiry is not a select");
  return el;
}

function optionLabels(): string[] {
  return Array.from(expirySelect().options).map((option) => option.textContent ?? "");
}

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
    expiresAt: null,
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
    org = { callerRole: "admin", features: { organizations: true } };
  });

  it("states the workspace and has no owner picker", () => {
    render(
      <Wrapper>
        <ApiKeysSection />
      </Wrapper>,
    );
    expect(screen.getByText(/Team members can see key names/)).toBeTruthy();
    expect(screen.getByText("Secrets are shown once. Share only with intended users.")).toBeTruthy();
    // The one picker is the expiry. There is no owner picker.
    expect(screen.getAllByRole("combobox").map((el) => el.getAttribute("aria-label"))).toEqual(["Key expiry"]);
    expect(screen.queryByLabelText(/owner/i)).toBeNull();
    expect(screen.getByText(/No API keys in Platform yet/)).toBeTruthy();
  });

  it("creates against the active team, not a picked owner", () => {
    render(<ApiKeysSection />);
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "CI" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createTeamKeyMutate).toHaveBeenCalledWith(
      { name: "CI", expiresIn: 90 * DAY },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("hides No expiry and longer choices under the org maximum", () => {
    org = { ...org, maxApiKeyLifetimeDays: 90 };
    render(<ApiKeysSection />);
    expect(optionLabels()).toEqual(["30 days", "90 days"]);
    expect(screen.getByText("Your organization requires keys to expire within 90 days.")).toBeTruthy();
  });

  it("shows when each team key expires", () => {
    teamKeys = [
      teamKey({ id: "k1", name: "Forever", expiresAt: null }),
      teamKey({ id: "k2", name: "Old", expiresAt: Date.now() - DAY * 1000 }),
      teamKey({ id: "k3", name: "Fresh", expiresAt: Date.now() + 30 * DAY * 1000 }),
    ];
    render(<ApiKeysSection />);
    expect(screen.getByText("No expiry", { selector: "div" })).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.getByText(/^Expires /)).toBeTruthy();
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
        expiresAt: null,
      },
    ];
    org = { callerRole: "member", features: { organizations: true } };
    createPersonalKeyMutate.mockClear();
  });

  it("offers 30 days, 90 days, 1 year, and No expiry, with 90 days first", () => {
    render(<ApiKeysSection />);
    expect(optionLabels()).toEqual(["30 days", "90 days", "1 year", "No expiry"]);
    expect(expirySelect().value).toBe("90");
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "CI" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createPersonalKeyMutate).toHaveBeenCalledWith({ name: "CI", expiresIn: 90 * DAY }, expect.anything());
  });

  it("sends null when the person picks No expiry", () => {
    render(<ApiKeysSection />);
    fireEvent.change(expirySelect(), { target: { value: "none" } });
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "CI" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createPersonalKeyMutate).toHaveBeenCalledWith({ name: "CI", expiresIn: null }, expect.anything());
  });

  it("selects the longest allowed choice when the maximum is below 90 days", () => {
    org = { ...org, maxApiKeyLifetimeDays: 30 };
    render(<ApiKeysSection />);
    expect(optionLabels()).toEqual(["30 days"]);
    expect(expirySelect().value).toBe("30");
  });

  it("shows a managed note instead of the form when personal keys are off", () => {
    org = { ...org, allowPersonalApiKeys: false };
    render(<ApiKeysSection />);
    expect(screen.queryByLabelText("Key name")).toBeNull();
    expect(screen.getByText(/Your organization does not allow personal API keys/)).toBeTruthy();
    // Existing keys stay listed, so the person can still revoke them.
    expect(screen.getByText("Laptop script")).toBeTruthy();
  });

  it("omits the creator: a personal key has one possible creator", () => {
    render(<ApiKeysSection />);
    expect(screen.getByText("Laptop script")).toBeTruthy();
    expect(screen.queryByText(/Created by/)).toBeNull();
    expect(screen.queryByText("Creator not recorded")).toBeNull();
  });
});


