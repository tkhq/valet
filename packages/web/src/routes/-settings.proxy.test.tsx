// @vitest-environment jsdom
/**
 * Personal proxy settings page (`/settings/proxy`). Mocks `~/api/proxy-usage`,
 * `~/api/settings`, and `~/api/api-keys` to assert:
 *   - the Create proxy key button is present (OnboardingPanel rendered);
 *   - in single-user mode (`features.organizations` false/absent), ProxyGovernance
 *     is editable — the Switch is present;
 *   - in org mode (`features.organizations` true), ProxyGovernance is read-only —
 *     no Switch, "Managed by your organization admins." text is shown;
 *   - the "Step 1 — Gateway status" heading from OnboardingPanel's pre-creation
 *     view is absent (showGatewayStatus=false), while ProxyGovernance's own
 *     gateway text IS shown.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

// ── mocks ────────────────────────────────────────────────────────────────

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

let teamId: string | undefined;
vi.mock("~/lib/workspace-scope", () => ({ useWorkspaceScope: () => ({ teamId }) }));
const createKeyMutate = vi.fn();
const personalKeyHook = vi.fn();
const teamCreate = vi.fn<(target: string, name: string, opts: { onSuccess: (key: { name: string; key: string }) => void }) => void>();
const revoke = vi.fn();
let teamRole: "admin" | "member" = "admin";
let teamError: Error | null = null;
let keysError: Error | null = null;
let createError: Error | null = null;
let teamLoading = false;
vi.mock("~/components/workspace-clause", () => ({
  CreateScopeLine: () => <p>Team workspace</p>,
  useActiveWorkspace: () => undefined,
  workspaceName: () => "Team",
}));


vi.mock("~/api/api-keys", () => ({
  useCreateApiKey: () => { personalKeyHook(); return ({
    mutate: createKeyMutate,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }); },
  useTeamApiKeys: (target: string) => ({ data: [{ id: `${target}-key`, name: `${target} shared key`, start: "vlt_123", createdAt: 1, lastRequest: null, createdBy: null }], isLoading: false, error: keysError }),
  useCreateTeamApiKey: (target: string) => ({ mutate: (name: string, opts: { onSuccess: (key: { name: string; key: string }) => void }) => teamCreate(target, name, opts), isPending: false, error: createError }),
  useRevokeTeamApiKey: (target: string) => ({ mutate: (id: string) => revoke(target, id), isPending: false, error: null }),
}));

let settingsResult: {
  data: { enabled: boolean; mode: "centralized" | "passthrough" } | undefined;
  isLoading: boolean;
  error?: Error;
} = { data: { enabled: true, mode: "centralized" }, isLoading: false };

vi.mock("~/api/proxy-usage", () => ({
  useProxySettings: () => settingsResult,
  useSetProxyEnabled: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
  useSetProxyMode: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

let orgData: {
  data: { callerRole: "admin" | "member"; features: { organizations: boolean } } | undefined;
  isLoading: boolean;
} = {
  data: { callerRole: "admin", features: { organizations: false } },
  isLoading: false,
};

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return { ...actual, useOrg: () => orgData,
    useTeams: () => ({ data: teamLoading ? undefined : { teams: [
      { id: "team-1", name: "Platform", callerRole: teamRole },
      { id: "team-2", name: "Support", callerRole: teamRole },
    ] }, error: teamError, isLoading: teamLoading }),
    useOrgDirectory: () => ({ data: { users: [] }, isLoading: false, error: null }),
  };
});

import { ApiError } from "~/api/client";
import { SettingsProxyPage } from "./settings.proxy";

beforeEach(() => {
  vi.clearAllMocks();
  teamId = undefined;
  teamRole = "admin";
  teamError = null;
  keysError = null;
  createError = null;
  teamLoading = false;
  settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
  orgData = {
    data: { callerRole: "admin", features: { organizations: false } },
    isLoading: false,
  };
  createKeyMutate.mockReset();
});

// ── OnboardingPanel present ───────────────────────────────────────────────

describe("SettingsProxyPage — onboarding panel", () => {
  it("renders the Create proxy key button", () => {
    render(<SettingsProxyPage />);
    expect(screen.getByRole("button", { name: "Create proxy key" })).toBeTruthy();
  });

  it("does not show the 'Step 1 — Gateway status' heading (showGatewayStatus=false)", () => {
    render(<SettingsProxyPage />);
    // The OnboardingPanel pre-creation view must NOT render the Step 1 heading.
    expect(screen.queryByText(/Step 1 — Gateway status/)).toBeNull();
  });
});

// ── single-user mode (editable) ───────────────────────────────────────────

describe("SettingsProxyPage — single-user mode (editable ProxyGovernance)", () => {
  it("shows the Switch control when features.organizations is false", () => {
    orgData = {
      data: { callerRole: "admin", features: { organizations: false } },
      isLoading: false,
    };
    render(<SettingsProxyPage />);
    expect(screen.getByRole("switch")).toBeTruthy();
  });

  it("keeps governance read-only while organization data loads", () => {
    orgData = { data: undefined, isLoading: true };
    render(<SettingsProxyPage />);
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

// ── org mode (read-only) ──────────────────────────────────────────────────

describe("SettingsProxyPage — org mode (read-only ProxyGovernance)", () => {
  beforeEach(() => {
    orgData = {
      data: { callerRole: "member", features: { organizations: true } },
      isLoading: false,
    };
  });

  it("does not show the Switch control in org mode", () => {
    render(<SettingsProxyPage />);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows 'Managed by your organization admins.' text in org mode", () => {
    render(<SettingsProxyPage />);
    expect(screen.getByText("Managed by your organization admins.")).toBeTruthy();
  });

  it("shows gateway status summary text in org mode", () => {
    settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
    render(<SettingsProxyPage />);
    expect(screen.getByText("Gateway: On · Centralized mode")).toBeTruthy();
  });
});


describe("SettingsProxyPage in a team workspace", () => {
  beforeEach(() => {
    teamId = "team-1";
    orgData = { data: { callerRole: "member", features: { organizations: true } }, isLoading: false };
  });

  it("shows shared team keys and setup without personal keys or governance mutations", () => {
    render(<SettingsProxyPage />);
    expect(screen.getByText("Platform proxy")).toBeTruthy();
    expect(screen.getByText("team-1 shared key")).toBeTruthy();
    expect(screen.getByText(/export ANTHROPIC_AUTH_TOKEN=TEAM_API_KEY/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create proxy key" })).toBeNull();
    expect(personalKeyHook).not.toHaveBeenCalled();
  });

  it("lets members use setup but keeps create and revoke admin-only", () => {
    teamRole = "member";
    render(<SettingsProxyPage />);
    expect(screen.getByText("team-1 shared key")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.getByText(/export ANTHROPIC_AUTH_TOKEN=TEAM_API_KEY/)).toBeTruthy();
  });

  it("allows organization admins to manage team keys without changing proxy governance here", () => {
    teamRole = "member";
    orgData = { data: { callerRole: "admin", features: { organizations: true } }, isLoading: false };
    render(<SettingsProxyPage />);
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("clears drafts and late key reveals when switching teams or returning to personal", () => {
    const { rerender } = render(<SettingsProxyPage />);
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Proxy" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(teamCreate).toHaveBeenCalledWith("team-1", "Proxy", expect.anything());
    teamId = "team-2";
    rerender(<SettingsProxyPage />);
    expect(screen.getByLabelText<HTMLInputElement>("Key name").value).toBe("");
    teamCreate.mock.calls[0][2].onSuccess({ name: "Old team", key: "vlt_old_secret" });
    expect(screen.queryByText("vlt_old_secret")).toBeNull();
    expect(screen.queryByText("team-1 shared key")).toBeNull();
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Support proxy" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(teamCreate).toHaveBeenLastCalledWith("team-2", "Support proxy", expect.anything());
    teamId = undefined;
    rerender(<SettingsProxyPage />);
    expect(screen.getByRole("button", { name: "Create proxy key" })).toBeTruthy();
    expect(screen.queryByText("team-2 shared key")).toBeNull();
  });

  it("explains disabled governance and pass-through setup without loading personal credentials", () => {
    settingsResult = { data: { enabled: false, mode: "passthrough" }, isLoading: false };
    render(<SettingsProxyPage />);
    expect(screen.getByText(/Ask an organization admin to enable/)).toBeTruthy();
    expect(screen.getByText(/Use an approved provider key/)).toBeTruthy();
    expect(screen.getByText(/export ANTHROPIC_API_KEY=<approved-anthropic-key>/)).toBeTruthy();
    expect(personalKeyHook).not.toHaveBeenCalled();
  });

  it("blocks setup while loading, on errors, and when the selected team is unavailable", () => {
    teamLoading = true;
    const { rerender } = render(<SettingsProxyPage />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByLabelText("Key name")).toBeNull();
    teamLoading = false;
    teamError = new Error("Offline");
    rerender(<SettingsProxyPage />);
    expect(screen.getByRole("alert").textContent).toContain("Reload");
    teamError = null;
    teamId = "missing";
    rerender(<SettingsProxyPage />);
    expect(screen.getByRole("alert").textContent).toContain("Select another workspace");
    expect(screen.queryByLabelText("Key name")).toBeNull();
  });
});


describe("team key access changes", () => {
  beforeEach(() => {
    teamId = "team-1";
    orgData = { data: { callerRole: "member", features: { organizations: true } }, isLoading: false };
  });

  it("clears secrets and drafts on a key authorization error even with cached roles and rows", () => {
    const { rerender } = render(<SettingsProxyPage />);
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Shared" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    act(() => teamCreate.mock.calls[0][2].onSuccess({ name: "Shared", key: "vlt_revealed" }));
    expect(screen.getByText("vlt_revealed")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Stale draft" } });
    keysError = new Error("Access denied");
    rerender(<SettingsProxyPage />);
    expect(screen.getByRole("alert").textContent).toContain("verify team key access");
    expect(screen.queryByText("vlt_revealed")).toBeNull();
    expect(screen.queryByText("team-1 shared key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    keysError = null;
    rerender(<SettingsProxyPage />);
    expect(screen.getByLabelText<HTMLInputElement>("Key name").value).toBe("");
    expect(screen.queryByText("vlt_revealed")).toBeNull();
  });

  it("ignores a late create response after admin role loss and does not restore the old draft", () => {
    const { rerender } = render(<SettingsProxyPage />);
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Pending" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    teamRole = "member";
    rerender(<SettingsProxyPage />);
    act(() => teamCreate.mock.calls[0][2].onSuccess({ name: "Late", key: "vlt_late" }));
    expect(screen.queryByText("vlt_late")).toBeNull();
    expect(screen.queryByLabelText("Key name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    teamRole = "admin";
    rerender(<SettingsProxyPage />);
    expect(screen.getByLabelText<HTMLInputElement>("Key name").value).toBe("");
    expect(screen.queryByText("vlt_late")).toBeNull();
    expect(screen.getByText(/Team members can see key names/)).toBeTruthy();
    expect(screen.queryByText(/Everyone on the team can see it/)).toBeNull();
  });
});


describe("team proxy setup presentation", () => {
  it("shows the server's corrective action when key creation needs real auth", () => {
    teamId = "team-1";
    createError = new ApiError(503, "POST /teams/team-1/api-keys → 503", {
      error: "Team API keys need real auth. Set BETTER_AUTH_SECRET and sign in.",
    });
    render(<SettingsProxyPage />);
    expect(screen.getByRole("alert").textContent).toBe("Team API keys need real auth. Set BETTER_AUTH_SECRET and sign in.");
    expect(screen.queryByText(/POST \/teams/)).toBeNull();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });
});
