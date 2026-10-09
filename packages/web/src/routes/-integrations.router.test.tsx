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
import type { CredentialSummary, ListPluginsResponse, PluginServiceSummary } from "@valet/api/wire";

vi.mock("~/api/workflows", () => ({ useTriggerCatalog: () => ({ data: { catalog: [] } }) }));
vi.mock("~/components/integrations/integration-limit-notice", () => ({ IntegrationLimitNotice: () => null }));
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => undefined }));
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u1", orgRole: "member" }, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams: [team] }, isLoading: false, error: null }),
  useOrg: () => ({ data: { features: { organizations: true } } }),
  useOrgDirectory: () => ({ data: { users: [] }, isLoading: false, error: null }),
}));
const team = {
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

import { WorkspaceScopeProvider } from "~/lib/workspace-scope";
import { Route as IntegrationsRoute } from "./integrations";

function service(name: string, extra: Partial<PluginServiceSummary> = {}): PluginServiceSummary {
  return { service: name, type: "api_key", configKeys: ["accessToken"], connected: false, connect: "manual", actions: [], ...extra };
}

function plugin(name: string, services: PluginServiceSummary[], description = "") {
  return { name, version: "1", actionCount: 3, description, services };
}

/** The real route's component and search schema under a memory history. */
function mount(initial = "/integrations") {
  // The real scope provider in the root route, as in `__root.tsx`, so it
  // reads `?workspace=` through the page route's own search schema.
  const root = createRootRoute({ component: () => <WorkspaceScopeProvider><Outlet /></WorkspaceScopeProvider> });
  const page = createRoute({
    getParentRoute: () => root,
    path: "integrations",
    component: IntegrationsRoute.options.component,
    validateSearch: IntegrationsRoute.options.validateSearch,
  });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createRouter({ routeTree: root.addChildren([page]), history });
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

describe("integration rows", () => {
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
