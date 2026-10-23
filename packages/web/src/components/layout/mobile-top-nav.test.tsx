// @vitest-environment jsdom
/** The phone top bar holds the drawer control, the mark that returns Home,
 * and the avatar that opens Settings. The drawer holds Home, the workspace switcher,
 * and the threads; the other pages live under Home's Make tab. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useBlocker,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrgPluginWire, TeamSummary } from "@valet/api/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceScopeProvider } from "~/lib/workspace-scope";
import { AppShell } from "./app-shell";
import { AppDrawer } from "./app-drawer";
import { MobileTopNav } from "./mobile-top-nav";

// The nav gates the Security link on the `security` plugin's entitlement,
// read from `useOrg().data.plugins`. Mock the settings reads so the gate is
// deterministic; `securityPlugins` is mutable per test.
let navTeams: TeamSummary[] = [];
let securityPlugins: OrgPluginWire[] = [
  {
    name: "security",
    label: "Valet Security",
    description: "",
    instanceEnabled: true,
    entitlement: { mode: "all", teamIds: [] },
    enabledForCaller: true,
  },
];

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrg: () => ({
      data: { callerRole: "admin", features: { organizations: true }, plugins: securityPlugins },
      isLoading: false,
      error: null,
    }),
    useTeams: () => ({ data: { teams: navTeams }, isLoading: false, error: null }),
    useMe: () => ({ data: { id: "u1", name: "Ada Park", email: "ada@example.com", avatarUrl: null }, isLoading: false, error: null }),
  };
});

// The thread list and the Tasks count make their own requests and have
// their own tests. Stub them so this file covers navigation.
vi.mock("~/components/session/assistant-rail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/session/assistant-rail")>()),
  AssistantRail: () => <div data-testid="threads-stub" />,
}));
let needsYou = { count: 0, partial: false };
vi.mock("~/components/home/tasks-panel", () => ({ useNeedsYouCount: () => needsYou }));

function renderNav(opts: { withSidebar?: boolean; workspace?: string; path?: string; blockNavigation?: boolean } = {}) {
  // The nav reads the workspace scope, which throws outside its provider —
  // deliberately, so a surface can never silently render another workspace's
  // data under this one's name. The provider must sit INSIDE the router: it
  // reads `?assistant=` to let the open assistant win over the stored key.
  const withScope = (node: React.ReactNode) => (
    <WorkspaceScopeProvider>{node}</WorkspaceScopeProvider>
  );
  const rootRoute = createRootRoute({
    component: () => {
      useBlocker({ shouldBlockFn: () => opts.blockNavigation === true });
      return opts.withSidebar === undefined ? (
        withScope(<><MobileTopNav /><AppDrawer /></>)
      ) : (
        // The real shell, so the toggle is driven by the state it actually
        // reads — a hand-built context value would prove only that the
        // component renders what it is handed.
        withScope(
          <AppShell topNav={<MobileTopNav />} sidebar={opts.withSidebar ? <nav /> : undefined}>
            <div />
          </AppShell>,
        )
      );
    },
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  const threadsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat",
    component: () => null,
  });
  const skillsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills",
    component: () => null,
  });
  const artifactsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/artifacts", component: () => null });
  const memoryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/memory", component: () => null });
  const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: () => null });
  const securityRoute = createRoute({ getParentRoute: () => rootRoute, path: "/security", component: () => null });
  const presenceRoutes = [
    "/presence",
    "/presence/places/$subject",
    "/presence/rules/$id",
    "/presence/routines/$id",
    "/presence/activity",
    "/presence/events/$eventId",
    "/workflows",
    "/workflows/$workflowId",
    "/workflows/runs",
    "/workflows/runs/$runId",
  ].map(path => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, threadsRoute, skillsRoute, artifactsRoute, memoryRoute, settingsRoute, securityRoute, ...presenceRoutes]),
    history: createMemoryHistory({ initialEntries: [opts.path ?? (opts.workspace ? `/?workspace=${opts.workspace}` : "/")] }),
  });
  const queryClient = new QueryClient();

  return { router, ...render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  ) };
}

describe("AppDrawer workspace switcher", () => {
  beforeEach(() => {
    navTeams = [];
    needsYou = { count: 0, partial: false };
    window.sessionStorage.clear();
    securityPlugins = [
      {
        name: "security",
        label: "Valet Security",
        description: "",
        instanceEnabled: true,
        entitlement: { mode: "all", teamIds: [] },
        enabledForCaller: true,
      },
    ];
  });

  it.each([
    ["/presence/places/slack%3AC123?workspace=t1", "/presence"],
    ["/presence/rules/sub-old?workspace=t1", "/presence"],
    ["/presence/events/ev-old?workspace=t1", "/presence/activity"],
    ["/workflows/wf-old?workspace=t1", "/workflows"],
    ["/workflows/runs/run-old?workspace=t1", "/workflows/runs"],
    ["/workflows?run=old&gate=old&workspace=t1", "/workflows"],
  ])("returns to the new workspace's Presence list from %s", async (path, list) => {
    navTeams = [{ id: "t1", name: "Platform", orgId: "org", createdAt: 1, memberCount: 1, callerRole: "member", origin: "local", externalId: null, defaultModel: null }];
    const { router } = renderNav({path});
    await userEvent.click(await screen.findByRole("button", {name: "Workspace: Platform. Change workspace"}));
    await userEvent.click(screen.getByRole("menuitem", {name: "Personal"}));
    await waitFor(() => expect(router.state.location.pathname).toBe(list));
    expect(router.state.location.search).toEqual({workspace: "user"});
    expect(await screen.findByRole("button", {name: "Workspace: Personal. Change workspace"})).toBeTruthy();
  });

  it.each(["user", "t2"])("opens the selected team's Workflows tab from %s", async (workspace) => {
    const base: TeamSummary = { id: "t1", name: "Platform", orgId: "org", createdAt: 1, memberCount: 1, callerRole: "member", origin: "local", externalId: null, defaultModel: null };
    navTeams = [base, {...base, id:"t2", name:"People"}];
    const {router} = renderNav({path:`/workflows/wf-old?workspace=${workspace}`});
    await userEvent.click(await screen.findByRole("button", {name:`Workspace: ${workspace === "user" ? "Personal" : "People"}. Change workspace`}));
    await userEvent.click(screen.getByRole("menuitem", {name:"Platform"}));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
    expect(router.state.location.search).toEqual({workspace:"t1"});
    expect(await screen.findByRole("button", {name:"Workspace: Platform. Change workspace"})).toBeTruthy();
  });

  it.each([
    "/presence?workspace=t1",
    "/presence/activity?workspace=t1&status=problems",
    "/workflows/runs?workspace=t1",
  ])("renames the workspace in place on a list page reached as %s", async (path) => {
    navTeams = [{ id: "t1", name: "Platform", orgId: "org", createdAt: 1, memberCount: 1, callerRole: "member", origin: "local", externalId: null, defaultModel: null }];
    const { router } = renderNav({ path });
    const pathname = path.split("?")[0];
    await userEvent.click(await screen.findByRole("button", { name: "Workspace: Platform. Change workspace" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Personal" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ workspace: "user" }));
    expect(router.state.location.pathname).toBe(pathname);
    if (path.includes("status=")) expect(router.state.location.search).toEqual({ workspace: "user", status: "problems" });
    expect(await screen.findByRole("button", { name: "Workspace: Personal. Change workspace" })).toBeTruthy();
    expect(window.sessionStorage.getItem("valet:workspace")).toBe("user");
  });

  it("keeps a Presence tab in place when the workspace changes", async () => {
    navTeams = [{ id: "t1", name: "Platform", orgId: "org", createdAt: 1, memberCount: 1, callerRole: "member", origin: "local", externalId: null, defaultModel: null }];
    window.sessionStorage.setItem("valet:workspace", "t1");
    const {router} = renderNav({path:"/presence/activity?status=problems"});
    await userEvent.click(await screen.findByRole("button", {name:"Workspace: Platform. Change workspace"}));
    await userEvent.click(screen.getByRole("menuitem", {name:"Personal"}));
    expect(await screen.findByRole("button", {name:"Workspace: Personal. Change workspace"})).toBeTruthy();
    expect(router.state.location.pathname).toBe("/presence/activity");
    expect(router.state.location.search).toEqual({status: "problems"});
  });

  it("keeps the original workspace when unsaved edits block leaving", async () => {
    navTeams = [{ id: "t1", name: "Platform", orgId: "org", createdAt: 1, memberCount: 1, callerRole: "member", origin: "local", externalId: null, defaultModel: null }];
    window.sessionStorage.setItem("valet:workspace", "t1");
    const {router} = renderNav({path:"/workflows/wf-old", blockNavigation:true});
    await userEvent.click(await screen.findByRole("button", {name:"Workspace: Platform. Change workspace"}));
    await userEvent.click(screen.getByRole("menuitem", {name:"Personal"}));
    expect(router.state.location.pathname).toBe("/workflows/wf-old");
    expect(screen.getByRole("button", {name:"Workspace: Platform. Change workspace"})).toBeTruthy();
    expect(window.sessionStorage.getItem("valet:workspace")).toBe("t1");
  });

  it("keeps the detail open when reselecting the same workspace", async () => {
    navTeams = [{ id: "t1", name: "Platform", orgId: "org", createdAt: 1, memberCount: 1, callerRole: "member", origin: "local", externalId: null, defaultModel: null }];
    const {router} = renderNav({path:"/workflows/wf-old?workspace=t1"});
    await userEvent.click(await screen.findByRole("button", {name:"Workspace: Platform. Change workspace"}));
    await userEvent.click(screen.getByRole("menuitem", {name:"Platform"}));
    expect(router.state.location.pathname).toBe("/workflows/wf-old");
  });

});

describe("MobileTopNav and AppDrawer", () => {
  beforeEach(() => {
    navTeams = [];
    needsYou = { count: 0, partial: false };
    securityPlugins = [{ name: "security", label: "Valet Security", description: "", instanceEnabled: true,
      entitlement: { mode: "all", teamIds: [] }, enabledForCaller: true }];
  });

  it("shows the Valet mark that returns Home, and no row of page links", async () => {
    renderNav();
    const home = await screen.findByRole("link", { name: "Valet home" });
    expect(home.getAttribute("href")).toBe("/");
    expect(home.textContent).toContain("Valet");
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Workflows" })).toBeNull();
  });

  it("opens Settings and the account pages from the avatar, on every screen size", async () => {
    renderNav();
    const avatar = await screen.findByRole("button", { name: "Account and settings" });
    expect(avatar.className).not.toContain("hidden");
    await userEvent.click(avatar);
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("Ada Park");
    expect(menu.textContent).toContain("ada@example.com");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Settings", "Usage", "Valet Security", "Changelog"]);
    expect(within(menu).getByRole("menuitem", { name: "Settings" }).getAttribute("href")).toBe("/settings");
  });

  it("leaves Valet Security out of the avatar menu when the plugin is not enabled for the caller", async () => {
    securityPlugins = [{ ...securityPlugins[0]!, enabledForCaller: false }];
    renderNav();
    await userEvent.click(await screen.findByRole("button", { name: "Account and settings" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Valet Security" })).toBeNull();
  });

  it("leads the drawer with Home and counts what needs the person", async () => {
    needsYou = { count: 4, partial: true };
    renderNav();
    const home = await screen.findByRole("link", { name: /^Home/ });
    expect(home.getAttribute("href")).toBe("/");
    expect(within(home).getByLabelText("4 need you").textContent).toBe("4+");
  });

  it("keeps the drawer to Home and the threads, with no More menu", async () => {
    renderNav();
    await screen.findByRole("link", { name: /^Home/ });
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(screen.getByTestId("threads-stub")).toBeTruthy();
  });

  it("shows no workspace switcher to a person with one workspace", async () => {
    renderNav();
    await screen.findByRole("link", { name: /^Home/ });
    expect(screen.queryByRole("button", { name: /Change workspace/ })).toBeNull();
  });
});

/**
 * Two toggle buttons are in the DOM at once and CSS alone decides which is
 * visible. These assert the part CSS cannot: that each announces the action
 * it performs, and that the desktop one tracks the shell's real state.
 */
describe("MobileTopNav — drawer toggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("draws no toggle outside a shell", async () => {
    renderNav();
    await screen.findByText("Valet");
    expect(screen.queryByRole("button", { name: /sidebar/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
  });

  it("draws no toggle when the shell has no drawer to control", async () => {
    renderNav({ withSidebar: false });
    await screen.findByText("Valet");
    expect(screen.queryByRole("button", { name: /sidebar/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
  });

  it("offers to collapse an open sidebar, and to expand it once collapsed", async () => {
    renderNav({ withSidebar: true });
    await screen.findByText("Valet");
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(collapse);
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
  });

  it("labels the phone control for its own action, with a 44px target", async () => {
    renderNav({ withSidebar: true });
    await screen.findByText("Valet");
    const open = screen.getByRole("button", { name: "Open menu" });
    expect(open.className).toContain("md:hidden");
    expect(open.className).toContain("max-md:min-h-11");
    expect(screen.getByRole("link", { name: "Valet home" }).className).toContain("max-md:min-h-11");
  });

  it("puts the toggle ahead of the mark, at the row's left edge", async () => {
    renderNav({ withSidebar: true });
    const logo = await screen.findByText("Valet");
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
