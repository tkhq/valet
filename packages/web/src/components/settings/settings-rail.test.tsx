// @vitest-environment jsdom
/**
 * Settings rail (settings-redesign spec, decision 2): every scope is listed
 * at once (Account, Personal, Your teams, Organization), and the
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
  useRouter: () => ({ history: { push: historyPush } }),
}));

const historyPush = vi.fn();

let pathname = "/settings/profile";
let orgData: { callerRole: "admin" | "member"; features: { organizations: boolean }; plugins: Array<{ name: string; enabledForCaller: boolean }>; loadedPlugins?: string[] } | undefined;
let teams: Array<{ id: string; name: string; callerRole: "admin" | "member" | null }> = [];

vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams }, isLoading: false, error: null }),
}));

import { PinnedWorkspaceScope } from "~/lib/workspace-scope";
import { ORG_SECTIONS, SettingsRail, orgSectionFor } from "./settings-rail";
import { rememberAppPath } from "~/lib/last-app-path";

beforeEach(() => {
  linkProps.length = 0;
  pathname = "/settings/profile";
  orgData = { callerRole: "admin", features: { organizations: true }, plugins: [] };
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
  it("links back to the last app page, not to a settings page", async () => {
    rememberAppPath("/chat", "/chat?thread=abc");
    rememberAppPath("/settings/access", "/settings/access");
    render(<SettingsRail />);
    const back = within(rail()).getByRole("link", { name: "Back to app" });
    expect(back.getAttribute("href")).toBe("/chat?thread=abc");
    await userEvent.click(back);
    expect(historyPush).toHaveBeenCalledWith("/chat?thread=abc");
  });

  it("lists every scope, with teams by name", () => {
    render(<SettingsRail />);
    expect(groupLabels()).toEqual(["Account", "Personal", "Your teams", "Organization"]);
    const yourTeams = within(rail()).getByRole("group", { name: "Your teams" });
    expect(within(yourTeams).getAllByRole("link").map((a) => a.textContent)).toEqual(["platform", "team-tvc"]);
    expect(within(yourTeams).getByRole("link", { name: "team-tvc" }).getAttribute("href")).toBe("/settings/teams/t1");
  });

  it("has no Plugins group and no plugin page links: the top nav lists those", () => {
    orgData = {
      callerRole: "admin",
      features: { organizations: true },
      plugins: [{ name: "security", enabledForCaller: true }],
      loadedPlugins: ["pr-review"],
    };
    render(<SettingsRail />);
    expect(groupLabels()).not.toContain("Plugins");
    expect(within(rail()).queryByRole("link", { name: "Valet Security" })).toBeNull();
    expect(within(rail()).queryByRole("link", { name: "Code review" })).toBeNull();
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
    const personalGroup = within(rail()).getByRole("group", { name: "Personal" });
    expect(within(personalGroup).getByRole("link", { name: "Access" }).getAttribute("href")).toBe("/settings/access");
    expect(within(rail()).getByRole("group", { name: "Your teams" })).toBeTruthy();
  });

  it("lists the Personal pages in rail order, with one Access page", () => {
    render(<SettingsRail />);
    const personal = within(rail()).getByRole("group", { name: "Personal" });
    expect(within(personal).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Integrations", "Access", "Secrets", "Policies", "Usage", "Model comparison",
    ]);
    expect(within(personal).queryByRole("link", { name: "API keys and proxy" })).toBeNull();
    expect(within(personal).queryByRole("link", { name: "Agent access" })).toBeNull();
    expect(within(personal).getByRole("link", { name: "Model comparison" }).getAttribute("href")).toBe("/settings/model-comparison");
  });

  it("offers Model comparison to a plain member with organizations on", () => {
    orgData = { callerRole: "member", features: { organizations: true }, plugins: [] };
    render(<SettingsRail />);
    const personal = within(rail()).getByRole("group", { name: "Personal" });
    expect(within(personal).getByRole("link", { name: "Model comparison" })).toBeTruthy();
    expect(within(personal).queryByRole("link", { name: "Models" })).toBeNull();
  });

  it("lists Models, Proxy, and the organization's Usage in the Models and usage section", () => {
    const section = ORG_SECTIONS.find((s) => s.label === "Models and usage");
    expect(section?.routes.map((r) => r.label)).toEqual(["Models", "Proxy", "Usage"]);
    expect(section?.routes.at(-1)?.to).toBe("/settings/organization/usage");
  });

  it("lists the organization's Secrets and Sandbox settings under Security and audit", () => {
    const section = ORG_SECTIONS.find((s) => s.label === "Security and audit");
    expect(section?.routes.map((r) => r.label)).toEqual(["Policies", "Secrets", "Sandbox settings", "Action log", "Audit log"]);
    expect(orgSectionFor("/settings/organization/secrets")?.label).toBe("Security and audit");
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

  it("shows a member only Teams under Organization", () => {
    orgData = { callerRole: "member", features: { organizations: true }, plugins: [] };
    render(<SettingsRail />);
    const org = within(rail()).getByRole("group", { name: "Organization" });
    expect(within(org).getAllByRole("link").map((a) => a.textContent)).toEqual(["Teams"]);
  });

  it.each([
    ["an org admin", "admin" as const, ["General", "Models and usage", "Apps and plugins", "Security and audit"]],
    ["a plain member on a team", "member" as const, ["Teams"]],
  ])("gives %s the full rail for their role", (_who, role, orgItems) => {
    orgData = { callerRole: role, features: { organizations: true }, plugins: [] };
    teams = [{ id: "t1", name: "team-tvc", callerRole: "member" }, { id: "t3", name: "not-mine", callerRole: null }];
    render(<SettingsRail />);
    const items = (group: string) =>
      within(within(rail()).getByRole("group", { name: group })).getAllByRole("link").map((a) => a.textContent);
    expect(groupLabels()).toEqual(["Account", "Personal", "Your teams", "Organization"]);
    expect(items("Account")).toEqual(["Profile", "Preferences", "Notifications"]);
    expect(items("Personal")).toEqual(["Integrations", "Access", "Secrets", "Policies", "Usage", "Model comparison"]);
    // Your teams lists memberships only, even for an admin who may open more.
    expect(items("Your teams")).toEqual(["team-tvc"]);
    expect(items("Organization")).toEqual(orgItems);
  });

  it("hides Organization and Your teams before the org query resolves", () => {
    orgData = undefined;
    render(<SettingsRail />);
    expect(groupLabels()).toEqual(["Account", "Personal"]);
  });

  it("offers Models under Personal only while organizations are off", () => {
    orgData = { callerRole: "admin", features: { organizations: false }, plugins: [] };
    render(<SettingsRail />);
    const personal = within(rail()).getByRole("group", { name: "Personal" });
    expect(within(personal).getByRole("link", { name: "Models" })).toBeTruthy();
    expect(groupLabels()).not.toContain("Organization");
  });

  it("offers MCP servers under Personal only to an admin while organizations are off", () => {
    orgData = { callerRole: "admin", features: { organizations: false }, plugins: [] };
    const gateOff = render(<SettingsRail />);
    const personal = within(rail()).getByRole("group", { name: "Personal" });
    expect(within(personal).getByRole("link", { name: "MCP servers" }).getAttribute("href")).toBe("/settings/mcp-servers");
    gateOff.unmount();

    // `GET /api/org/mcp-servers` 403s a non-admin, so a member gets no link.
    orgData = { callerRole: "member", features: { organizations: false }, plugins: [] };
    const memberGateOff = render(<SettingsRail />);
    const memberPersonal = within(rail()).getByRole("group", { name: "Personal" });
    expect(within(memberPersonal).queryByRole("link", { name: "MCP servers" })).toBeNull();
    memberGateOff.unmount();

    orgData = { callerRole: "admin", features: { organizations: true }, plugins: [] };
    render(<SettingsRail />);
    const personalOn = within(rail()).getByRole("group", { name: "Personal" });
    expect(within(personalOn).queryByRole("link", { name: "MCP servers" })).toBeNull();
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
