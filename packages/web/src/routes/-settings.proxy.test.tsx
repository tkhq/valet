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
const createKeyMutate = vi.fn<(name: string, opts: { onSuccess: (key: { key: string }) => void }) => void>();
const personalKeyHook = vi.fn();
const teamCreate = vi.fn<(target: string, name: string, opts: { onSuccess: (key: { name: string; key: string }) => void }) => void>();
let teamRole: "admin" | "member" = "admin";
let teamError: Error | null = null;
let keysError: Error | null = null;
let createError: Error | null = null;
let teamLoading = false;
vi.mock("~/api/api-keys", () => ({
  useCreateApiKey: () => { personalKeyHook(); return ({
    mutate: createKeyMutate,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }); },
  useTeamApiKeys: (target: string) => ({ data: [{ id: `${target}-key`, name: `${target} shared key`, start: "vlt_123", createdAt: 1, lastRequest: null, createdBy: null }], isLoading: false, error: keysError }),
  useCreateTeamApiKey: (target: string) => ({ mutate: (name: string, opts: { onSuccess: (key: { name: string; key: string }) => void }) => teamCreate(target, name, opts), isPending: false, error: createError }),
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
  error?: Error;
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


describe("shared personal and team onboarding", () => {
  it.each(["personal", "team"])("%s follows create, reveal, actual-key snippets, run, and create another", (scope) => {
    teamId = scope === "team" ? "team-1" : undefined;
    const { container } = render(<SettingsProxyPage />);
    expect(screen.getByRole("heading", { name: "Proxy" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Step 2.*Create your key/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Team API keys" })).toBeNull();
    expect(screen.queryByText(/TEAM_API_KEY/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create proxy key" }));
    if (scope === "team") {
      expect(teamCreate).toHaveBeenCalledWith("team-1", "proxy-key", expect.anything());
      expect(personalKeyHook).not.toHaveBeenCalled();
      act(() => teamCreate.mock.calls[0][2].onSuccess({ name: "proxy-key", key: "vlt_new_key" }));
    } else {
      expect(teamCreate).not.toHaveBeenCalled();
      act(() => createKeyMutate.mock.calls[0][1].onSuccess({ key: "vlt_new_key" }));
    }
    expect(screen.getByText("Your proxy key is shown once. Store it now.")).toBeTruthy();
    expect(screen.getByText(/export ANTHROPIC_AUTH_TOKEN=vlt_new_key/)).toBeTruthy();
    expect(screen.getByText(/export VALET_KEY=vlt_new_key/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Step 3.*Configure your tool/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Step 4.*Run it/ })).toBeTruthy();
    expect(screen.getByText('codex exec "hello"')).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings → API keys" }).getAttribute("href")).toBe("/settings/api-keys");
    fireEvent.click(screen.getByRole("button", { name: "Create another key" }));
    expect(container.textContent).not.toContain("vlt_new_key");
    expect(screen.getByRole("button", { name: "Create proxy key" })).toBeTruthy();
  });

  it("keeps members read-only and org governance read-only even for admins", () => {
    teamId = "team-1";
    teamRole = "member";
    orgData = { data: { callerRole: "member", features: { organizations: true } }, isLoading: false };
    const { rerender } = render(<SettingsProxyPage />);
    expect(screen.getByRole("button", { name: "Create proxy key" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Create proxy key" }));
    expect(teamCreate).not.toHaveBeenCalled();
    expect(personalKeyHook).not.toHaveBeenCalled();
    expect(screen.getByText(/A team or organization admin must create/)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    orgData = { data: { callerRole: "admin", features: { organizations: true } }, isLoading: false };
    rerender(<SettingsProxyPage />);
    expect(screen.getByRole("button", { name: "Create proxy key" })).toHaveProperty("disabled", false);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("uses the real new team key in pass-through snippets while preserving organization mode", () => {
    teamId = "team-1";
    settingsResult = { data: { enabled: false, mode: "passthrough" }, isLoading: false };
    render(<SettingsProxyPage />);
    expect(screen.getByText("Gateway: Off · Pass-through mode")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create proxy key" }));
    act(() => teamCreate.mock.calls[0][2].onSuccess({ name: "proxy-key", key: "vlt_pass" }));
    expect(screen.getByText(/export ANTHROPIC_AUTH_TOKEN=vlt_pass/)).toBeTruthy();
    expect(screen.getByText(/http_headers =.*vlt_pass/)).toBeTruthy();
    expect(screen.getByText(/export OPENAI_API_KEY=<approved-openai-key>/)).toBeTruthy();
    expect(screen.getByText(/An admin must enable/)).toBeTruthy();
  });

  it("discards revealed secrets and delayed responses across team and personal switches", () => {
    teamId = "team-1";
    const { container, rerender } = render(<SettingsProxyPage />);
    fireEvent.click(screen.getByRole("button", { name: "Create proxy key" }));
    const first = teamCreate.mock.calls[0][2].onSuccess;
    act(() => first({ name: "proxy-key", key: "vlt_first" }));
    teamId = "team-2";
    rerender(<SettingsProxyPage />);
    expect(container.textContent).not.toContain("vlt_first");
    act(() => first({ name: "proxy-key", key: "vlt_late_first" }));
    expect(container.textContent).not.toContain("vlt_late_first");
    fireEvent.click(screen.getByRole("button", { name: "Create proxy key" }));
    expect(teamCreate).toHaveBeenLastCalledWith("team-2", "proxy-key", expect.anything());
    teamId = undefined;
    rerender(<SettingsProxyPage />);
    act(() => teamCreate.mock.calls[1][2].onSuccess({ name: "proxy-key", key: "vlt_late_second" }));
    expect(container.textContent).not.toContain("vlt_late_second");
    expect(screen.getByRole("button", { name: "Create proxy key" })).toBeTruthy();
  });

  it.each(["role", "keys", "teams", "org", "settings"])("clears secrets and ignores delayed creation after %s access loss", (failure) => {
    teamId = "team-1";
    orgData = { data: { callerRole: "member", features: { organizations: true } }, isLoading: false };
    const { container, rerender } = render(<SettingsProxyPage />);
    fireEvent.click(screen.getByRole("button", { name: "Create proxy key" }));
    const success = teamCreate.mock.calls[0][2].onSuccess;
    act(() => success({ name: "proxy-key", key: "vlt_secret" }));
    if (failure === "role") teamRole = "member";
    if (failure === "keys") keysError = new Error("Denied");
    if (failure === "teams") teamError = new Error("Denied");
    if (failure === "org") orgData.error = new Error("Denied");
    if (failure === "settings") settingsResult.error = new Error("Denied");
    rerender(<SettingsProxyPage />);
    act(() => success({ name: "proxy-key", key: "vlt_late" }));
    expect(container.textContent).not.toContain("vlt_secret");
    expect(container.textContent).not.toContain("vlt_late");
    if (failure === "role") expect(screen.getByRole("button", { name: "Create proxy key" })).toHaveProperty("disabled", true);
    else expect(screen.getByRole("alert").textContent).toContain("Reload");
    teamRole = "admin";
    keysError = null;
    teamError = null;
    orgData.error = undefined;
    settingsResult.error = undefined;
    rerender(<SettingsProxyPage />);
    expect(container.textContent).not.toContain("vlt_secret");
    expect(container.textContent).not.toContain("vlt_late");
    expect(screen.getByRole("button", { name: "Create proxy key" })).toBeTruthy();
  });

  it("handles loading and missing teams without creating personal keys", () => {
    teamId = "team-1";
    teamLoading = true;
    const { rerender } = render(<SettingsProxyPage />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create proxy key" })).toBeNull();
    teamLoading = false;
    teamId = "gone";
    rerender(<SettingsProxyPage />);
    expect(screen.getByRole("alert").textContent).toContain("Select another workspace");
    expect(personalKeyHook).not.toHaveBeenCalled();
  });

  it("shows the corrective server message for auth-disabled key creation", () => {
    teamId = "team-1";
    createError = new ApiError(503, "POST /teams/team-1/api-keys → 503", {
      error: "Team API keys need real auth. Set BETTER_AUTH_SECRET and sign in.",
    });
    render(<SettingsProxyPage />);
    expect(screen.getByRole("alert").textContent).toBe("Team API keys need real auth. Set BETTER_AUTH_SECRET and sign in.");
    expect(screen.queryByText(/POST \/teams/)).toBeNull();
  });
});
