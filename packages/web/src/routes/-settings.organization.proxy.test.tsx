// @vitest-environment jsdom
/**
 * Organization · Proxy settings page. Mocks `~/api/proxy-usage` and
 * `~/api/settings` to assert:
 *   - the enable switch reflects the `enabled` value from settings;
 *   - toggling the switch calls `setEnabled.mutate`;
 *   - the mode control reflects `mode`;
 *   - clicking a mode button calls `setMode.mutate`;
 *   - non-admin callers see read-only values, not interactive controls.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ── mocks ────────────────────────────────────────────────────────────────

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const setEnabledMutate = vi.fn();
const setModeMutate = vi.fn();

let settingsResult: {
  data: { enabled: boolean; mode: "centralized" | "passthrough" } | undefined;
  isLoading: boolean;
} = { data: { enabled: false, mode: "centralized" }, isLoading: false };

vi.mock("~/api/proxy-usage", () => ({
  useProxySettings: () => settingsResult,
  useSetProxyEnabled: () => ({
    mutate: setEnabledMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
  useSetProxyMode: () => ({
    mutate: setModeMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

let orgData: {
  data: { callerRole: "admin" | "member"; features: { organizations: boolean } } | undefined;
  isLoading: boolean;
} = {
  data: { callerRole: "admin", features: { organizations: true } },
  isLoading: false,
};

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return { ...actual, useOrg: () => orgData };
});

import { OrganizationProxyPage } from "./settings.organization.proxy";

beforeEach(() => {
  vi.clearAllMocks();
  settingsResult = { data: { enabled: false, mode: "centralized" }, isLoading: false };
  orgData = {
    data: { callerRole: "admin", features: { organizations: true } },
    isLoading: false,
  };
  setEnabledMutate.mockReset();
  setModeMutate.mockReset();
});

// ── enabled switch ────────────────────────────────────────────────────────

describe("OrganizationProxyPage — gateway switch", () => {
  it("switch is unchecked when enabled=false", () => {
    settingsResult = { data: { enabled: false, mode: "centralized" }, isLoading: false };
    render(<OrganizationProxyPage />);
    const sw = screen.getByRole("switch", { name: "Gateway disabled" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("switch is checked when enabled=true", () => {
    settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
    render(<OrganizationProxyPage />);
    const sw = screen.getByRole("switch", { name: "Gateway enabled" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("toggling the switch calls setEnabled.mutate with true", () => {
    settingsResult = { data: { enabled: false, mode: "centralized" }, isLoading: false };
    render(<OrganizationProxyPage />);
    fireEvent.click(screen.getByRole("switch", { name: "Gateway disabled" }));
    expect(setEnabledMutate).toHaveBeenCalledWith(true);
  });

  it("toggling when enabled=true calls setEnabled.mutate with false", () => {
    settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
    render(<OrganizationProxyPage />);
    fireEvent.click(screen.getByRole("switch", { name: "Gateway enabled" }));
    expect(setEnabledMutate).toHaveBeenCalledWith(false);
  });
});

// ── mode control ──────────────────────────────────────────────────────────

describe("OrganizationProxyPage — credential mode", () => {
  it("shows Centralized selected when mode=centralized", () => {
    settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
    render(<OrganizationProxyPage />);
    const group = document.querySelector("[role='group'][aria-label='Credential mode']");
    expect(group).toBeTruthy();
    expect(group!.textContent).toContain("Centralized");
  });

  it("shows Pass-through selected when mode=passthrough", () => {
    settingsResult = { data: { enabled: true, mode: "passthrough" }, isLoading: false };
    render(<OrganizationProxyPage />);
    const group = document.querySelector("[role='group'][aria-label='Credential mode']");
    expect(group).toBeTruthy();
    expect(group!.textContent).toContain("Pass-through");
  });

  it("clicking Centralized calls setMode.mutate('centralized')", () => {
    settingsResult = { data: { enabled: true, mode: "passthrough" }, isLoading: false };
    render(<OrganizationProxyPage />);
    fireEvent.click(screen.getByRole("button", { name: "Centralized" }));
    expect(setModeMutate).toHaveBeenCalledWith("centralized");
  });

  it("clicking Pass-through calls setMode.mutate('passthrough')", () => {
    settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
    render(<OrganizationProxyPage />);
    fireEvent.click(screen.getByRole("button", { name: "Pass-through" }));
    expect(setModeMutate).toHaveBeenCalledWith("passthrough");
  });
});

// ── non-admin read-only view ──────────────────────────────────────────────

describe("OrganizationProxyPage — non-admin read-only", () => {
  it("member does not see the switch", () => {
    orgData = {
      data: { callerRole: "member", features: { organizations: true } },
      isLoading: false,
    };
    settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
    render(<OrganizationProxyPage />);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("member does not see the mode toggle buttons", () => {
    orgData = {
      data: { callerRole: "member", features: { organizations: true } },
      isLoading: false,
    };
    render(<OrganizationProxyPage />);
    expect(document.querySelector("[role='group'][aria-label='Credential mode']")).toBeNull();
  });

  it("member sees read-only gateway and mode summary", () => {
    orgData = {
      data: { callerRole: "member", features: { organizations: true } },
      isLoading: false,
    };
    settingsResult = { data: { enabled: true, mode: "centralized" }, isLoading: false };
    render(<OrganizationProxyPage />);
    expect(screen.getByText("Gateway: On · Centralized mode")).toBeTruthy();
    expect(screen.getByText("Managed by your organization admins.")).toBeTruthy();
  });
});

// ── usage link ────────────────────────────────────────────────────────────

describe("OrganizationProxyPage — usage link", () => {
  it("renders a link to /usage", () => {
    render(<OrganizationProxyPage />);
    const link = screen.getByRole("link", { name: /View recorded usage/ });
    expect(link.getAttribute("href")).toBe("/usage");
  });
});
