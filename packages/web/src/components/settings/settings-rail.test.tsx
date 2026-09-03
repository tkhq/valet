// @vitest-environment jsdom
/**
 * Settings rail (action-policies plan, Task 5): the two new org entries
 * (Policies, Action log) only show once `useOrg()` gates on + caller-admin,
 * matching the rail's existing visibility rule; the one new You entry
 * (Policies) always shows.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a href="#" {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => "/settings/profile",
}));

let orgData: { callerRole: "admin" | "member"; features: { organizations: boolean } } | undefined;

vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
}));

import { SettingsRail } from "./settings-rail";

describe("SettingsRail", () => {
  it("always shows the You · Policies entry", () => {
    orgData = { callerRole: "member", features: { organizations: false } };
    render(<SettingsRail />);
    expect(screen.getByRole("link", { name: "Policies" })).toBeTruthy();
  });

  it("hides Organization · Policies / Action log when the org gate is off", () => {
    orgData = { callerRole: "member", features: { organizations: false } };
    render(<SettingsRail />);
    expect(screen.queryByRole("link", { name: "Action log" })).toBeNull();
  });

  it("shows Organization · Policies + Action log for a gated-on admin", () => {
    orgData = { callerRole: "admin", features: { organizations: true } };
    render(<SettingsRail />);
    expect(screen.getByRole("link", { name: "Action log" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Policies" })).toHaveLength(2);
    // Beside GitHub and Slack: per-provider setup lives on the rail.
    expect(screen.getByRole("link", { name: "1Password" })).toBeTruthy();
  });

  // The page holds the member's OWN personal token as well as the org one,
  // so a member needs the link. Without it the allow-personal toggle an
  // admin turns on has no member-facing surface.
  it("shows a gated-on member 1Password beside Teams, and nothing else", () => {
    orgData = { callerRole: "member", features: { organizations: true } };
    render(<SettingsRail />);
    expect(screen.getByRole("link", { name: "1Password" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Teams" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Members" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Action log" })).toBeNull();
  });
});
