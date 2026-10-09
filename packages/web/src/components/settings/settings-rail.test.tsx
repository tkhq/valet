// @vitest-environment jsdom
/**
 * Settings rail (settings-redesign spec, decision 2): every scope is listed
 * at once — Account, Personal workspace, Your teams, Organization — and the
 * rail never reads the workspace switcher.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@testing-library/react";

/** Each link's route pattern and params, as the typed `Link` receives them. */
const linkProps: Array<{ to: string; params?: Record<string, string> }> = [];
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, ...rest }: { children: ReactNode; to: string; params?: Record<string, string>; [key: string]: unknown }) => {
    linkProps.push({ to, params });
    return (
      <a href={params ? to.replace(/\$(\w+)/g, (_, name: string) => params[name] ?? "") : to} {...rest}>
        {children}
      </a>
    );
  },
  useRouterState: () => pathname,
}));

let pathname = "/settings/profile";
let orgData: { callerRole: "admin" | "member"; features: { organizations: boolean } } | undefined;
let teams: Array<{ id: string; name: string; callerRole: "admin" | "member" | null }> = [];

vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams }, isLoading: false, error: null }),
}));

import { PinnedWorkspaceScope } from "~/lib/workspace-scope";
import { SettingsRail, orgSectionFor } from "./settings-rail";

beforeEach(() => {
  linkProps.length = 0;
  pathname = "/settings/profile";
  orgData = { callerRole: "admin", features: { organizations: true } };
  teams = [
    { id: "t2", name: "platform", callerRole: "admin" },
    { id: "t1", name: "team-tvc", callerRole: "member" },
    { id: "t3", name: "not-mine", callerRole: null },
  ];
});

function rail() {
  return screen.getByRole("navigation", { name: "Settings" });
}

function groupLabels(): string[] {
  return within(rail()).getAllByRole("group").map((g) => g.getAttribute("aria-label") ?? "");
}

describe("SettingsRail", () => {
  it("lists every scope, with teams by name", () => {
    render(<SettingsRail />);
    expect(groupLabels()).toEqual(["Account", "Personal workspace", "Your teams", "Organization"]);
    const yourTeams = within(rail()).getByRole("group", { name: "Your teams" });
    expect(within(yourTeams).getAllByRole("link").map((a) => a.textContent)).toEqual(["platform", "team-tvc"]);
    expect(within(yourTeams).getByRole("link", { name: "team-tvc" }).getAttribute("href")).toBe("/settings/teams/t1");
  });

  it("links each team through its typed route and params", () => {
    render(<SettingsRail />);
    expect(linkProps).toContainEqual({ to: "/settings/teams/$teamId", params: { teamId: "t1" } });
    expect(linkProps.some((link) => link.to.startsWith("/settings/teams/t"))).toBe(false);
  });

  it("does not change with the workspace switcher", () => {
    const snapshot = () =>
      within(rail()).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")]);
    const personal = render(<PinnedWorkspaceScope teamId={undefined}><SettingsRail /></PinnedWorkspaceScope>);
    const onPersonal = snapshot();
    personal.unmount();
    render(<PinnedWorkspaceScope teamId="t1"><SettingsRail /></PinnedWorkspaceScope>);
    expect(snapshot()).toEqual(onPersonal);
    // Personal pages stay personal, and the team keeps its own item.
    const personalGroup = within(rail()).getByRole("group", { name: "Personal workspace" });
    expect(within(personalGroup).getByRole("link", { name: "API keys and proxy" }).getAttribute("href")).toBe("/settings/api-keys");
    expect(within(rail()).getByRole("group", { name: "Your teams" })).toBeTruthy();
  });

  it("keeps API keys, Agent access, and Policies under Personal workspace", () => {
    render(<SettingsRail />);
    const personal = within(rail()).getByRole("group", { name: "Personal workspace" });
    for (const label of ["API keys and proxy", "Agent access", "Policies"]) {
      expect(within(personal).getByRole("link", { name: label })).toBeTruthy();
    }
  });

  it("marks a team active on any of its tabs", () => {
    pathname = "/settings/teams/t1/policies";
    render(<SettingsRail />);
    expect(within(rail()).getByRole("link", { name: "team-tvc" }).getAttribute("aria-current")).toBe("page");
    expect(within(rail()).getByRole("link", { name: "platform" }).getAttribute("aria-current")).toBeNull();
  });

  it("groups an admin's organization pages into four sections", () => {
    pathname = "/settings/organization/linear";
    render(<SettingsRail />);
    const org = within(rail()).getByRole("group", { name: "Organization" });
    expect(within(org).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "General", "Models and usage", "Apps and plugins", "Security and audit",
    ]);
    expect(within(org).getByRole("link", { name: "Apps and plugins" }).getAttribute("aria-current")).toBe("page");
    expect(within(org).getByRole("link", { name: "General" }).getAttribute("aria-current")).toBeNull();
  });

  it("shows a member only Teams and 1Password under Organization", () => {
    orgData = { callerRole: "member", features: { organizations: true } };
    render(<SettingsRail />);
    const org = within(rail()).getByRole("group", { name: "Organization" });
    expect(within(org).getAllByRole("link").map((a) => a.textContent)).toEqual(["Teams", "1Password"]);
  });

  it("hides Organization and Your teams before the org query resolves", () => {
    orgData = undefined;
    render(<SettingsRail />);
    expect(groupLabels()).toEqual(["Account", "Personal workspace"]);
  });

  it("offers Models under Personal workspace only while organizations are off", () => {
    orgData = { callerRole: "admin", features: { organizations: false } };
    render(<SettingsRail />);
    const personal = within(rail()).getByRole("group", { name: "Personal workspace" });
    expect(within(personal).getByRole("link", { name: "Models" })).toBeTruthy();
    expect(groupLabels()).not.toContain("Organization");
  });

  it("names the current section in the narrow-screen menu", async () => {
    pathname = "/settings/teams/t1";
    render(<SettingsRail />);
    await userEvent.click(screen.getByRole("button", { name: "Settings section: Your teams / team-tvc" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Security and audit" })).toBeTruthy();
  });
});

describe("orgSectionFor", () => {
  it("matches the General root exactly and Teams by prefix", () => {
    expect(orgSectionFor("/settings/organization")?.label).toBe("General");
    expect(orgSectionFor("/settings/organization/teams/abc")?.label).toBe("General");
    expect(orgSectionFor("/settings/organization/action-log/")?.label).toBe("Security and audit");
    expect(orgSectionFor("/settings/profile")).toBeUndefined();
  });
});
