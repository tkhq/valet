// @vitest-environment jsdom
/**
 * Settings routes under a real router (settings-redesign spec, decisions 1
 * and 2): the old paths redirect, Preferences joins two pages, personal
 * pages pin personal scope while the switcher holds a team, a team's tabs
 * render that team's sections through the real `Outlet`, and the
 * Organization layout shows its tabs to an admin only. Each page is the real
 * route's own component. Only data hooks and a few leaf sections are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type AnyRoute,
  type RouteComponent,
} from "@tanstack/react-router";
import { useWorkspaceScope } from "~/lib/workspace-scope";

type Role = "admin" | "member";
let orgRole: Role = "admin";
const teams = [
  { id: "t1", name: "platform", callerRole: "member" as const },
  { id: "t2", name: "support", callerRole: "admin" as const },
];

/** Whether the teams and org queries have answered. A test flips it to
 * show a page while membership is still unknown, then the answer. */
let membershipLoaded = true;
const membershipListeners = new Set<() => void>();
function resolveMembership() {
  membershipLoaded = true;
  for (const listener of membershipListeners) listener();
}
function useMembershipLoaded(): boolean {
  return useSyncExternalStore((listener) => {
    membershipListeners.add(listener);
    return () => membershipListeners.delete(listener);
  }, () => membershipLoaded);
}

vi.mock("~/api/settings", () => ({
  useOrg: () => useMembershipLoaded()
    ? { data: { callerRole: orgRole, features: { organizations: true } }, isLoading: false, error: null }
    : { data: undefined, isLoading: true, error: null },
  useTeams: () => useMembershipLoaded()
    ? { data: { teams }, isLoading: false, error: null }
    : { data: undefined, isLoading: true, error: null },
  useMe: () => ({ data: { id: "u1", orgRole, defaultModel: null, defaultReasoning: null }, isLoading: false, error: null }),
  usePatchMe: () => ({ mutate: vi.fn() }),
  useOrgDirectory: () => ({ data: { users: [] }, isLoading: false, error: null }),
}));
vi.mock("~/api/api-keys", () => ({
  useApiKeys: () => ({ data: [], isLoading: false, error: null }),
  useCreateApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
  useRevokeApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useTeamApiKeys: (teamId: string) => ({
    data: [{ id: `${teamId}-key`, name: `${teamId} shared key`, start: "vlt_123", createdAt: 1, lastRequest: null, createdBy: null }],
    isLoading: false,
    error: null,
  }),
  useCreateTeamApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useRevokeTeamApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("~/api/proxy-usage", () => ({
  useProxySettings: () => ({ data: { enabled: true, mode: "centralized" }, isLoading: false, error: null }),
  useSetProxyEnabled: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useSetProxyMode: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}));

/** Prints the scope a section reads, so a test sees which workspace it got. */
function ScopeProbe({ label }: { label: string }) {
  const { teamId } = useWorkspaceScope();
  return <p>{`${label}: ${teamId ?? "personal"}`}</p>;
}
vi.mock("~/components/settings/policy-overrides-section", () => ({ PolicyOverridesSection: () => <ScopeProbe label="policy overrides" /> }));
vi.mock("~/components/settings/grants-section", () => ({ GrantsSection: () => <ScopeProbe label="grants" /> }));
vi.mock("~/components/settings/team-policy-overrides", () => ({
  TeamPolicyOverrides: ({ teamId, canEdit }: { teamId: string; canEdit: boolean }) => <p>{`team policies: ${teamId}, ${canEdit ? "editable" : "read-only"}`}</p>,
}));
vi.mock("~/components/settings/model-combobox", () => ({ ModelCombobox: () => <span>model picker</span> }));
vi.mock("~/components/settings/reasoning-select", () => ({ ReasoningSelect: () => <span>reasoning picker</span> }));

import { WorkspaceScopeProvider } from "~/lib/workspace-scope";
import { SettingsLayout } from "./settings";
import { Route as AppearanceRoute } from "./settings.appearance";
import { Route as ThreadsRoute } from "./settings.threads";
import { Route as ProxyRoute } from "./settings.proxy";
import { Route as PreferencesRoute } from "./settings.preferences";
import { Route as PoliciesRoute } from "./settings.policies";
import { Route as ApiKeysRoute } from "./settings.api-keys";
import { TeamSettingsShell } from "./settings.teams.$teamId";
import { Route as TeamAccessRoute } from "./settings.teams.$teamId.access";
import { Route as TeamPoliciesRoute } from "./settings.teams.$teamId.policies";
import { Route as OrganizationRoute } from "./settings.organization";
import { Route as TeamRedirectRoute } from "./settings.team";

/** The component a file route renders. Every route here declares one. */
function componentOf(route: { options: { component?: RouteComponent } }): RouteComponent {
  const component = route.options.component;
  if (!component) throw new Error("route has no component");
  return component;
}

function stub(text: string) {
  return () => <p>{text}</p>;
}

/** `/settings` with the real layout and rail, under the real scope provider
 * in the root route as in `__root.tsx`. */
async function mount(initial: string) {
  const root = createRootRoute({ component: () => <WorkspaceScopeProvider><Outlet /></WorkspaceScopeProvider> });
  const settings = createRoute({ getParentRoute: () => root, path: "settings", component: SettingsLayout });
  const child = (path: string, component: RouteComponent): AnyRoute =>
    createRoute({ getParentRoute: () => settings, path, component });
  const team = createRoute({
    getParentRoute: () => settings,
    path: "teams/$teamId",
    component: function TeamLayout() {
      return <TeamSettingsShell teamId={team.useParams().teamId} />;
    },
  });
  const org = createRoute({ getParentRoute: () => settings, path: "organization", component: componentOf(OrganizationRoute) });
  const orgChild = (path: string): AnyRoute =>
    createRoute({ getParentRoute: () => org, path, component: stub(`org page ${path}`) });
  const tree = root.addChildren([
    settings.addChildren([
      child("profile", stub("Profile page")),
      child("team", componentOf(TeamRedirectRoute)),
      child("appearance", componentOf(AppearanceRoute)),
      child("threads", componentOf(ThreadsRoute)),
      child("proxy", componentOf(ProxyRoute)),
      child("preferences", componentOf(PreferencesRoute)),
      child("policies", componentOf(PoliciesRoute)),
      child("api-keys", componentOf(ApiKeysRoute)),
      team.addChildren([
        createRoute({ getParentRoute: () => team, path: "/", component: stub("team general") }),
        createRoute({ getParentRoute: () => team, path: "access", component: componentOf(TeamAccessRoute) }),
        createRoute({ getParentRoute: () => team, path: "policies", component: componentOf(TeamPoliciesRoute) }),
      ]),
      org.addChildren([orgChild("/"), orgChild("members"), orgChild("teams"), orgChild("linear"), orgChild("slack")]),
    ]),
  ]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [initial] }) });
  render(<RouterProvider router={router} />);
  await screen.findByRole("navigation", { name: "Settings" });
  return router;
}

function content(): HTMLElement {
  // The settings layout's column beside the rail.
  const rail = screen.getByRole("navigation", { name: "Settings" });
  const column = rail.nextElementSibling;
  if (!(column instanceof HTMLElement)) throw new Error("no settings content column");
  return column;
}

beforeEach(() => {
  membershipLoaded = true;
  orgRole = "admin";
  window.sessionStorage.clear();
  // The switcher holds a team for every test: settings pages must not follow it.
  window.sessionStorage.setItem("valet:workspace", "t1");
});

describe("old settings paths", () => {
  it.each([
    ["/settings/appearance", "/settings/preferences"],
    ["/settings/threads", "/settings/preferences"],
    ["/settings/proxy", "/settings/api-keys"],
  ])("%s redirects to %s", async (from, to) => {
    const router = await mount(from);
    await waitFor(() => expect(router.state.location.pathname).toBe(to));
    // Replace, not push: Back must not land on the redirect again.
    expect(router.history.length).toBe(1);
  });
});

describe("/settings/team", () => {
  it("opens the switcher's team once membership is known", async () => {
    const router = await mount("/settings/team");
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/teams/t1"));
    expect(await within(content()).findByRole("heading", { name: "platform" })).toBeTruthy();
  });

  it("opens Profile, not a refusal, when the switcher holds a team the caller left", async () => {
    // The stored key outlives the team. While the queries load, the scope
    // provider keeps it, because it cannot yet tell the team is gone.
    window.sessionStorage.setItem("valet:workspace", "gone-team");
    membershipLoaded = false;
    const router = await mount("/settings/team");
    expect(router.state.location.pathname).toBe("/settings/team");
    act(() => resolveMembership());
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/profile"));
    expect(within(content()).getByText("Profile page")).toBeTruthy();
    expect(screen.queryByText(/not a member of this team/)).toBeNull();
  });
});

describe("Preferences", () => {
  it("joins Appearance and Thread defaults on one page", async () => {
    await mount("/settings/preferences");
    expect(await within(content()).findByRole("heading", { name: "Appearance" })).toBeTruthy();
    expect(within(content()).getByRole("heading", { name: "Thread defaults" })).toBeTruthy();
    expect(within(content()).getByRole("radiogroup", { name: "Light and dark" })).toBeTruthy();
    expect(within(content()).getByText("model picker")).toBeTruthy();
  });
});

describe("personal workspace pages", () => {
  it("Policies keeps personal scope while the switcher holds a team", async () => {
    await mount("/settings/policies");
    expect(await within(content()).findByText("policy overrides: personal")).toBeTruthy();
    expect(within(content()).getByText("grants: personal")).toBeTruthy();
    expect(within(content()).queryByText(/team policies/)).toBeNull();
    expect(document.title).toBe("Personal · Valet");
  });
});

describe("a team's settings tabs", () => {
  it("API keys and proxy renders that team's keys and proxy", async () => {
    await mount("/settings/teams/t2/access");
    const page = content();
    expect(await within(page).findByText("t2 shared key")).toBeTruthy();
    expect(within(page).getByRole("heading", { name: "Proxy" })).toBeTruthy();
    expect(within(page).getByText(/through support for spend tracking/)).toBeTruthy();
    expect(within(page).getByRole("link", { name: "API keys and proxy" }).getAttribute("aria-current")).toBe("page");
    expect(document.title).toBe("support · Valet");
  });

  it("Policies renders that team's policies with the caller's role", async () => {
    await mount("/settings/teams/t2/policies");
    expect(await within(content()).findByText("team policies: t2, editable")).toBeTruthy();
    expect(within(content()).queryByText(/policy overrides/)).toBeNull();
  });

  it("Policies is read-only for a plain member of the team", async () => {
    orgRole = "member";
    await mount("/settings/teams/t1/policies");
    expect(await within(content()).findByText("team policies: t1, read-only")).toBeTruthy();
  });
});

describe("Organization tabs", () => {
  it("show an admin the section's tabs with the open page marked", async () => {
    await mount("/settings/organization/linear");
    const tabs = await within(content()).findByRole("navigation", { name: "Apps and plugins" });
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Plugins", "GitHub", "Slack", "Linear", "1Password", "Library",
    ]);
    expect(within(tabs).getByRole("link", { name: "Linear" }).getAttribute("aria-current")).toBe("page");
    expect(within(tabs).getByRole("link", { name: "Slack" }).getAttribute("aria-current")).toBeNull();
    expect(within(content()).getByText("org page linear")).toBeTruthy();
  });

  it("mark General on the organization root", async () => {
    await mount("/settings/organization");
    const tabs = await within(content()).findByRole("navigation", { name: "General" });
    expect(within(tabs).getByRole("link", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(within(tabs).getByRole("link", { name: "Members" }).getAttribute("aria-current")).toBeNull();
  });

  it("are hidden from a member, who reaches Teams alone", async () => {
    orgRole = "member";
    await mount("/settings/organization/teams");
    expect(await within(content()).findByText("org page teams")).toBeTruthy();
    expect(within(content()).queryByRole("navigation")).toBeNull();
  });
});
