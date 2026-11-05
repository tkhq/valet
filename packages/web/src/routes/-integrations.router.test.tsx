// @vitest-environment jsdom
/**
 * `/settings/integrations` under a real router and memory history: the detail panel
 * is a URL (`?service=`), so opening, closing, and Back are history
 * behavior that a mocked router cannot show.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";
import type {
  CredentialSummary,
  ListPluginsResponse,
  PluginServiceSummary,
  TeamSummary,
  ToolPermissionWire,
} from "@valet/api/wire";

vi.mock("~/api/workflows", () => ({ useTriggerCatalog: () => ({ data: { catalog: [] } }) }));
vi.mock("~/components/integrations/integration-limit-notice", () => ({ IntegrationLimitNotice: () => null }));
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => undefined }));
// The membership read can fail, as a network error would leave it.
const membership = vi.hoisted(() => ({ failed: false }));
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u1", orgRole: "member" }, isLoading: false, error: null }),
  useTeams: () => membership.failed
    ? { data: undefined, isLoading: false, error: new Error("offline") }
    : { data: { teams: [team] }, isLoading: false, error: null },
  useOrg: () => ({ data: { features: { organizations: true } } }),
  useOrgDirectory: () => ({ data: { users: [] }, isLoading: false, error: null }),
}));
const team: TeamSummary = {
  id: "t1", name: "Platform", callerRole: "member", orgId: "o1", origin: "local",
  externalId: null, createdAt: 1, memberCount: 2, defaultModel: null,
};
vi.mock("~/api/repos", () => ({
  useConnectGithub: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useGithubOrgStatus: () => ({ data: undefined }),
}));
let credentials: CredentialSummary[] = [];
let plugins: ListPluginsResponse = { plugins: [] };
// Team credential rows let a member request removal through this hook.
vi.mock("~/api/team-deletion-requests", () => ({
  useSubmitTeamDeletionRequest: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));
vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: plugins, isLoading: false, error: null }),
  useCredentials: () => ({ data: { credentials }, isLoading: false, error: null }),
  useConnectCredential: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useDisconnectCredential: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
  useDelegateCredential: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useRevokeDelegation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));
vi.mock("~/api/onepassword", () => ({
  useTeamOnePasswordStatus: () => ({ data: { tokenConnected: false }, isSuccess: true, isError: false }),
  useTeamOnePasswordToken: () => ({ mutate: vi.fn(), isPending: false, reset: vi.fn() }),
  useOnePasswordSettings: () => ({ data: undefined, isLoading: false, error: null }),
  usePutOnePasswordSettings: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useIdentityLinks: () => ({ data: { links: [] }, isLoading: false, error: null }),
    useStartIdentityLink: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeliverIdentityLink: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useVerifyIdentityLink: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    useLinkMembers: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
    useUnlinkIdentity: () => ({ mutate: vi.fn(), isPending: false, reset: vi.fn() }),
  };
});

// The rows' summaries and the panel's tool controls read these.
let toolPermissions: ToolPermissionWire[] = [];
let setToolModesError: Error | null = null;
const setToolModes = vi.fn();
vi.mock("~/api/policies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api/policies")>()),
  useMyToolPermissions: () => ({ data: { tools: toolPermissions }, isLoading: false, error: null }),
  useSetMyToolModes: () => ({ mutate: setToolModes, error: setToolModesError }),
}));

import { WorkspaceScopeProvider } from "~/lib/workspace-scope";
import { Route as IntegrationsRoute } from "./settings.integrations";
import { Route as IntegrationsRedirectRoute } from "./integrations";

function service(name: string, extra: Partial<PluginServiceSummary> = {}): PluginServiceSummary {
  return { service: name, type: "api_key", configKeys: ["accessToken"], connected: false, connect: "manual", actions: [], ...extra };
}

function plugin(name: string, services: PluginServiceSummary[], description = "") {
  return { name, version: "1", actionCount: 3, description, services };
}

/** The real route's component and search schema under a memory history.
 * `/elsewhere` is the page the reader came from, one entry back. */
function mount(initial = "/settings/integrations") {
  // The real scope provider in the root route, as in `__root.tsx`. The
  // page pins your own workspace whatever the switcher holds.
  const root = createRootRoute({
    component: () => <WorkspaceScopeProvider><Outlet /></WorkspaceScopeProvider>,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "settings/integrations",
    component: IntegrationsRoute.options.component,
    validateSearch: IntegrationsRoute.options.validateSearch,
  });
  const elsewhere = createRoute({ getParentRoute: () => root, path: "elsewhere", component: () => <p>Elsewhere page</p> });
  const history = createMemoryHistory({ initialEntries: ["/elsewhere", initial], initialIndex: 1 });
  const router = createRouter({ routeTree: root.addChildren([page, elsewhere]), history });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  membership.failed = false;
  window.sessionStorage.clear();
  credentials = [];
  plugins = { plugins: [plugin("notion", [service("notion", { connected: true })], "Notes and docs")] };
});

describe("the integration detail panel", () => {
  it("closes back to the list, so one Back then leaves the page", async () => {
    const router = mount();
    // Each cycle opens a panel by a push and closes it. None may leave an
    // entry behind, or Back does nothing visible once per cycle.
    for (let cycle = 0; cycle < 3; cycle++) {
      fireEvent.click(await screen.findByRole("link", { name: /Notion/ }));
      fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(router.state.location.search).toEqual({}));
    }
    expect(router.state.location.pathname).toBe("/settings/integrations");

    await act(async () => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/elsewhere"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes a linked panel in place, so Back leaves without reopening it", async () => {
    const router = mount("/settings/integrations?service=notion");
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The panel was the first Integrations entry, so closing must not go
    // back out of the page.
    expect(router.state.location.pathname).toBe("/settings/integrations");
    expect(router.state.location.search).toEqual({});

    await act(async () => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/elsewhere"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes with Back after a push, and Forward reopens it", async () => {
    const router = mount();
    fireEvent.click(await screen.findByRole("link", { name: /Notion/ }));
    await screen.findByRole("dialog");
    await act(async () => router.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => router.history.forward());
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/elsewhere"));
  });

  it("keeps the search when it closes", async () => {
    const router = mount("/settings/integrations?q=notes");
    fireEvent.click(await screen.findByRole("link", { name: /Notion/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "notes", service: "notion" }));
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toEqual({ q: "notes" });
    expect(screen.getByRole("link", { name: /Notion/ })).toBeTruthy();
  });

  it("opens nothing for an unknown service and keeps the list", async () => {
    mount("/settings/integrations?service=does-not-exist");
    expect(await screen.findByRole("link", { name: /Notion/ })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the panel a link names", async () => {
    mount("/settings/integrations?service=notion");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Disconnect Notion" })).toBeTruthy();
  });
});

/** The row's link inside one of the page's lists. */
async function rowIn(list: string, name: RegExp) {
  return within(await screen.findByRole("list", { name: list })).getByRole("link", { name });
}

describe("integration rows", () => {
  it("flag a connected credential on a service this organization has not configured", async () => {
    plugins = { plugins: [plugin("drive", [service("drive", { connected: true, connect: "unconfigured", connectBlockedBy: "org" })])] };
    mount();
    const row = await rowIn("Connected", /Drive/);
    expect(within(row).getByText("Needs setup")).toBeTruthy();
    fireEvent.click(row);
    expect(within(await screen.findByRole("dialog")).getByText(/Not configured for this organization/)).toBeTruthy();
  });

  it("show the attention badge of a broken connection on the row", async () => {
    plugins = { plugins: [plugin("notion", [service("notion", { connected: true, health: { refreshFailed: true } })])] };
    mount();
    expect(within(await rowIn("Connected", /Notion/)).getByText("Refresh failed")).toBeTruthy();
  });

  it("say Connected for a healthy connection, and name its account", async () => {
    plugins = { plugins: [plugin("notion", [service("notion", { connected: true, health: { login: "me@example.com" } })])] };
    mount();
    const row = await rowIn("Connected", /Notion/);
    expect(within(row).getByText("Connected")).toBeTruthy();
    expect(within(row).getAllByText(/me@example\.com/).length).toBeGreaterThan(0);
    expect(row.textContent).not.toMatch(/Needs setup|Refresh failed|Expired|Reconnect/);
  });

  it("offer Reconnect on an expired connection", async () => {
    plugins = { plugins: [plugin("notion", [service("notion", { connected: true, health: { expiresAt: 1 } })])] };
    mount();
    const row = await rowIn("Connected", /Notion/);
    expect(within(row).getByText("Expired")).toBeTruthy();
    expect(within(row).getByText("Reconnect")).toBeTruthy();
  });

  it("name what an unconnected row offers", async () => {
    plugins = {
      plugins: [
        plugin("slack", [service("slack", { type: "bot_token", connect: "org" })]),
        plugin("gmail", [service("gmail", { connect: "unconfigured", connectBlockedBy: "deployment", missingEnv: ["GOOGLE_CLIENT_ID"] })]),
        plugin("typefully", [service("typefully")]),
      ],
    };
    mount();
    // The organization provides Slack, so it is connected for the caller.
    const slack = await rowIn("Connected", /Slack/);
    expect(within(slack).getByText("Connected")).toBeTruthy();
    expect(within(slack).getAllByText(/Your organization/).length).toBeGreaterThan(0);
    expect(within(await rowIn("Available", /Gmail/)).getByText("Needs setup")).toBeTruthy();
    expect(within(await rowIn("Available", /Typefully/)).getByText("Connect")).toBeTruthy();
  });

  it("let a long name shrink, so the row fits a phone screen", async () => {
    plugins = { plugins: [plugin("gw", [service("gw", { connected: true })], "Calendar and Drive")] };
    plugins.plugins[0]!.displayName = "Google Workspace Calendar and Drive (MCP)";
    mount();
    const row = await screen.findByRole("link", { name: /Google Workspace Calendar and Drive/ });
    const name = within(row).getByText("Google Workspace Calendar and Drive (MCP)");
    // jsdom has no layout. These classes are what lets the name give up
    // width to the badge and chevron instead of pushing them off screen.
    expect(name.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "shrink", "truncate"]));
    expect(name.className.split(" ")).not.toContain("shrink-0");
  });
});

describe("the pinned workspace", () => {
  it("opens personal Integrations while the switcher holds a team", async () => {
    window.sessionStorage.setItem("valet:workspace", "t1");
    mount();
    expect(await screen.findByRole("link", { name: /Notion/ })).toBeTruthy();
    expect(screen.queryByText("Platform workspace")).toBeNull();
  });
});

describe("other saved credentials", () => {
  it("lists a credential no installed integration uses, with Revoke", async () => {
    credentials = [{ service: "legacy-crm", type: "api_key", connectedAt: "2026-01-01T00:00:00Z" }];
    mount();
    const list = await screen.findByRole("list", { name: "Other saved credentials" });
    expect(within(list).getByRole("button", { name: /^Revoke / })).toBeTruthy();
  });

  it("does not list a credential an integration row already covers", async () => {
    credentials = [{ service: "notion", type: "api_key", connectedAt: "2026-01-01T00:00:00Z" }];
    mount();
    await screen.findByRole("link", { name: /Notion/ });
    expect(screen.queryByRole("list", { name: "Other saved credentials" })).toBeNull();
  });
});

describe("the /integrations redirect", () => {
  function mountRedirect(initial: string) {
    const root = createRootRoute({ component: () => <WorkspaceScopeProvider><Outlet /></WorkspaceScopeProvider> });
    const routes = [
      createRoute({ getParentRoute: () => root, path: "integrations", component: IntegrationsRedirectRoute.options.component }),
      createRoute({ getParentRoute: () => root, path: "settings/integrations", component: () => <p>Personal integrations</p> }),
      createRoute({ getParentRoute: () => root, path: "settings/teams/$teamId/integrations", component: () => <p>Team integrations</p> }),
    ];
    const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [initial] }) });
    render(<RouterProvider router={router} />);
    return router;
  }

  it("keeps a team result on its team when the membership read fails", async () => {
    membership.failed = true;
    const router = mountRedirect("/integrations?teamId=t1&connected=linear");
    expect(await screen.findByText("Team integrations")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/teams/t1/integrations");
    expect(router.state.location.searchStr).toBe("?teamId=t1&connected=linear");
  });

  it("sends a result for a team you are not on to personal Integrations", async () => {
    const router = mountRedirect("/integrations?teamId=gone&error=team_access_changed");
    expect(await screen.findByText("Personal integrations")).toBeTruthy();
    expect(router.state.location.searchStr).toBe("?teamId=gone&error=team_access_changed");
  });
});
