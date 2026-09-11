// @vitest-environment jsdom
/**
 * Settings rail (action-policies plan, Task 5): the two new org entries
 * (Policies, Action log) only show once `useOrg()` gates on + caller-admin,
 * matching the rail's existing visibility rule; the one new You entry
 * (Policies) always shows.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string; [key: string]: unknown }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => pathname,
}));

let pathname = "/settings/profile";
let teamId: string | undefined;
vi.mock("~/lib/workspace-scope", () => ({
  useWorkspaceScope: () => ({ teamId }),
}));
beforeEach(() => {
  pathname = "/settings/profile";
  teamId = undefined;
});

let orgData: { callerRole: "admin" | "member"; features: { organizations: boolean } } | undefined;

vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
}));

import { SettingsRail } from "./settings-rail";

describe("SettingsRail", () => {
  it("opens the current section menu with only permitted organization links", async () => {
    orgData = { callerRole: "member", features: { organizations: true } };
    render(<SettingsRail />);
    await userEvent.click(screen.getByRole("button", { name: "Settings section: You / Profile" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Teams" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Members" })).toBeNull();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Appearance" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not expose organization sections before the query resolves", async () => {
    orgData = undefined;
    render(<SettingsRail />);
    await userEvent.click(screen.getByRole("button", { name: "Settings section: You / Profile" }));
    expect(within(screen.getByRole("menu")).queryByText("Organization")).toBeNull();
  });

  it("distinguishes Team and Organization sections and follows the current route", async () => {
    orgData = { callerRole: "admin", features: { organizations: true } };
    teamId = "team-1";
    pathname = "/settings/team";
    const { rerender } = render(<SettingsRail />);
    await userEvent.click(screen.getByRole("button", { name: "Settings section: Team / General" }));
    const menu = screen.getByRole("menu");
    const team = within(menu).getByRole("group", { name: "Team" });
    const organization = within(menu).getByRole("group", { name: "Organization" });
    expect(within(team).getByRole("menuitem", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(within(organization).getByRole("menuitem", { name: "General" }).getAttribute("href")).toBe("/settings/organization");
    await userEvent.keyboard("{Escape}");
    pathname = "/settings/organization";
    rerender(<SettingsRail />);
    expect(screen.getByRole("button", { name: "Settings section: Organization / General" })).toBeTruthy();
  });

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
    expect(screen.getByRole("link", { name: "Sandbox settings" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sandbox images" })).toBeNull();
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
