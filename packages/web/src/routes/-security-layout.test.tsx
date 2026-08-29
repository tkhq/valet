// @vitest-environment jsdom
/**
 * `/security` layout gate (plugin-entitlements design): the hub outlet renders
 * only when the `security` plugin is enabled for the caller. A disabled or
 * unknown plugin shows the quiet empty state instead — a direct navigation to
 * `/security` must never show the hub. While the org query loads, render
 * nothing rather than flash either state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { OrgPluginWire } from "@valet/api/wire";

let orgData: { plugins: OrgPluginWire[] } | undefined = { plugins: [] };
let orgLoading = false;

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Outlet: () => <div data-testid="security-outlet" />,
}));

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrg: () => ({ data: orgData, isLoading: orgLoading, error: null }),
  };
});

import { SecurityLayout } from "./security";

const enabledPlugin: OrgPluginWire = {
  name: "security",
  label: "Valet Security",
  description: "",
  instanceEnabled: true,
  entitlement: { mode: "all", teamIds: [] },
  enabledForCaller: true,
};

beforeEach(() => {
  orgData = { plugins: [enabledPlugin] };
  orgLoading = false;
});

describe("SecurityLayout", () => {
  it("renders the outlet when the security plugin is enabled for the caller", () => {
    render(<SecurityLayout />);
    expect(screen.getByTestId("security-outlet")).toBeTruthy();
  });

  it("shows the empty state when the plugin is disabled for the caller", () => {
    orgData = {
      plugins: [{ ...enabledPlugin, enabledForCaller: false, entitlement: { mode: "off", teamIds: [] } }],
    };
    render(<SecurityLayout />);
    expect(screen.queryByTestId("security-outlet")).toBeNull();
    expect(
      screen.getByText(/Valet Security is not enabled for your account/),
    ).toBeTruthy();
  });

  it("shows the empty state when no security plugin is loaded", () => {
    orgData = { plugins: [] };
    render(<SecurityLayout />);
    expect(screen.queryByTestId("security-outlet")).toBeNull();
    expect(
      screen.getByText(/Valet Security is not enabled for your account/),
    ).toBeTruthy();
  });

  it("renders neither the outlet nor the empty state while the org query loads", () => {
    orgData = undefined;
    orgLoading = true;
    const { container } = render(<SecurityLayout />);
    expect(screen.queryByTestId("security-outlet")).toBeNull();
    expect(screen.queryByText(/Valet Security is not enabled/)).toBeNull();
    expect(container.childElementCount).toBe(0);
  });
});
