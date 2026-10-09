// @vitest-environment jsdom
/**
 * `/integrations` under a real router and memory history: the detail panel
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
import type { CredentialSummary, ListPluginsResponse, PluginServiceSummary, TeamSummary } from "@valet/api/wire";

vi.mock("~/api/workflows", () => ({ useTriggerCatalog: () => ({ data: { catalog: [] } }) }));
vi.mock("~/components/integrations/integration-limit-notice", () => ({ IntegrationLimitNotice: () => null }));
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => undefined }));
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u1", orgRole: "member" }, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams: [team] }, isLoading: false, error: null }),
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

import { WorkspaceScopeProvider, useWorkspaceScope } from "~/lib/workspace-scope";
import { WorkspaceSwitcher, workspaceOptions } from "~/components/layout/workspace-switcher";
import { Route as IntegrationsRoute } from "./integrations";

function service(name: string, extra: Partial<PluginServiceSummary> = {}): PluginServiceSummary {
  return { service: name, type: "api_key", configKeys: ["accessToken"], connected: false, connect: "manual", actions: [], ...extra };
}

function plugin(name: string, services: PluginServiceSummary[], description = "") {
  return { name, version: "1", actionCount: 3, description, services };
}

/** The workspace switcher as the top nav wires it, off `/chat`. */
function Switcher() {
  const scope = useWorkspaceScope();
  return <WorkspaceSwitcher options={workspaceOptions([team])} activeKey={scope.key} onSelect={scope.setKey} navigateOnSelect={false} />;
}

/** The real route's component and search schema under a memory history.
 * `/elsewhere` is the page the reader came from, one entry back. */
function mount(initial = "/integrations") {
  // The real scope provider in the root route, as in `__root.tsx`, so it
  // reads `?workspace=` through the page route's own search schema.
  const root = createRootRoute({
    component: () => <WorkspaceScopeProvider><Switcher /><Outlet /></WorkspaceScopeProvider>,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "integrations",
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
  window.sessionStorage.clear();
  credentials = [];
  plugins = { plugins: [plugin("notion", [service("notion", { connected: true })], "Notes and docs")] };
});

describe("the integration detail panel", () => {
  it("closes without a history entry, so Back does not reopen it", async () => {
    const router = mount();
    fireEvent.click(await screen.findByRole("link", { name: /Notion/ }));
    await screen.findByRole("dialog");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toEqual({});

    await act(async () => router.history.back());
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the search when it closes", async () => {
    const router = mount("/integrations?q=notes");
    fireEvent.click(await screen.findByRole("link", { name: /Notion/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "notes", service: "notion" }));
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toEqual({ q: "notes" });
    expect(screen.getByRole("link", { name: /Notion/ })).toBeTruthy();
  });

  it("opens nothing for an unknown service and keeps the list", async () => {
    mount("/integrations?service=does-not-exist");
    expect(await screen.findByRole("link", { name: /Notion/ })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the panel a link names", async () => {
    mount("/integrations?service=notion");
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
    expect(within(row).getByText("Not configured")).toBeTruthy();
    fireEvent.click(row);
    expect(within(await screen.findByRole("dialog")).getByText(/Not configured for this organization/)).toBeTruthy();
  });

  it("show the attention badge of a broken connection on the row", async () => {
    plugins = { plugins: [plugin("notion", [service("notion", { connected: true, health: { refreshFailed: true } })])] };
    mount();
    expect(within(await rowIn("Connected", /Notion/)).getByText("Refresh failed")).toBeTruthy();
  });

  it("show no badge for a healthy connection", async () => {
    mount();
    const row = await rowIn("Connected", /Notion/);
    expect(row.textContent).not.toMatch(/Connected|Not configured|Refresh failed|Expired/);
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
    expect(within(await rowIn("Connected", /Slack/)).getByText("Organization")).toBeTruthy();
    expect(within(await rowIn("Available", /Gmail/)).getByText("Set up")).toBeTruthy();
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

describe("the workspace a link names", () => {
  it("opens personal Integrations from ?workspace=user while the switcher holds a team", async () => {
    window.sessionStorage.setItem("valet:workspace", "t1");
    const router = mount("/integrations?workspace=user");
    expect(await screen.findByRole("link", { name: /Notion/ })).toBeTruthy();
    expect(screen.queryByText("Platform workspace")).toBeNull();
    // The route's own schema keeps the parameter, so a typed link can send it.
    expect(router.state.matches.at(-1)?.search).toMatchObject({ workspace: "user" });
  });

  it("shows the switcher's team without the parameter", async () => {
    window.sessionStorage.setItem("valet:workspace", "t1");
    mount("/integrations");
    expect(await screen.findByText("Platform workspace")).toBeTruthy();
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

describe("the switcher on a link that names the workspace", () => {
  it("changes the page to the team chosen after ?workspace=user", async () => {
    window.sessionStorage.setItem("valet:workspace", "t1");
    const user = userEvent.setup();
    const router = mount("/integrations?workspace=user");
    expect(await screen.findByRole("link", { name: /Notion/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Workspace: Personal. Change workspace" }));
    await user.click(await screen.findByRole("menuitem", { name: "Platform" }));
    expect(await screen.findByText("Platform workspace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Workspace: Platform. Change workspace" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/integrations");
  });
});
