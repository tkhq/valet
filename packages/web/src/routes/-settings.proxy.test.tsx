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
import { render, screen } from "@testing-library/react";

// ── mocks ────────────────────────────────────────────────────────────────

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const createKeyMutate = vi.fn();

vi.mock("~/api/api-keys", () => ({
  useCreateApiKey: () => ({
    mutate: createKeyMutate,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));

let settingsResult: {
  data: { enabled: boolean; mode: "centralized" | "passthrough" } | undefined;
  isLoading: boolean;
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
  return { ...actual, useOrg: () => orgData };
});

import { SettingsProxyPage } from "./settings.proxy";

beforeEach(() => {
  vi.clearAllMocks();
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

  it("shows the Switch control when org data is loading (organizations=undefined)", () => {
    orgData = { data: undefined, isLoading: true };
    render(<SettingsProxyPage />);
    // singleUser = orgQ.data?.features.organizations !== true → true when data undefined
    expect(screen.getByRole("switch")).toBeTruthy();
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
