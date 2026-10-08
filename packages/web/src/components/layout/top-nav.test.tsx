// @vitest-environment jsdom
/** Threads leads primary navigation. Session and artifact routes remain
 * available to existing links without separate navigation entries. */
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
import { TopNav } from "./top-nav";

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
  };
});

// The bell owns its own network calls (useNotifications) and is covered by
// its own test — stub it here so this test stays focused on nav layout.
vi.mock("./notifications-bell", () => ({
  NotificationsBell: () => <div data-testid="bell-stub" />,
}));

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
        withScope(<TopNav />)
      ) : (
        // The real shell, so the toggle is driven by the state it actually
        // reads — a hand-built context value would prove only that the
        // component renders what it is handed.
        withScope(
          <AppShell topNav={<TopNav />} sidebar={opts.withSidebar ? <nav /> : undefined}>
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
  const automationRoutes = ["/workflows", "/workflows/$workflowId", "/workflows/runs/$runId", "/channel"].map(path => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, threadsRoute, skillsRoute, artifactsRoute, memoryRoute, ...automationRoutes]),
    history: createMemoryHistory({ initialEntries: [opts.path ?? (opts.workspace ? `/?workspace=${opts.workspace}` : "/")] }),
  });
  const queryClient = new QueryClient();

  return { router, ...render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  ) };
}

describe("TopNav", () => {
  beforeEach(() => {
    navTeams = [];
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
    "/channel?key=slack%3AC123&workspace=t1",
    "/workflows/wf-old?workspace=t1",
    "/workflows/runs/run-old?workspace=t1",
    "/workflows?run=old&gate=old&workspace=t1",
  ])("returns to the new workspace's Automation list from %s", async (path) => {
    navTeams = [{ id: "t1", name: "Platform", orgId: "org", createdAt: 1, memberCount: 1, callerRole: "member", origin: "local", externalId: null, defaultModel: null }];
    const { router } = renderNav({path});
    await userEvent.click(await screen.findByRole("button", {name: "Workspace: Platform. Change workspace"}));
    await userEvent.click(screen.getByRole("menuitem", {name: "Personal"}));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
    expect(router.state.location.search).toEqual({workspace: "user"});
    expect(await screen.findByRole("button", {name: "Workspace: Personal. Change workspace"})).toBeTruthy();
  });

  it.each(["user", "t2"])("opens the selected team's Automation list from %s", async (workspace) => {
    const base: TeamSummary = { id: "t1", name: "Platform", orgId: "org", createdAt: 1, memberCount: 1, callerRole: "member", origin: "local", externalId: null, defaultModel: null };
    navTeams = [base, {...base, id:"t2", name:"People"}];
    const {router} = renderNav({path:`/workflows/wf-old?workspace=${workspace}`});
    await userEvent.click(await screen.findByRole("button", {name:`Workspace: ${workspace === "user" ? "Personal" : "People"}. Change workspace`}));
    await userEvent.click(screen.getByRole("menuitem", {name:"Platform"}));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
    expect(router.state.location.search).toEqual({workspace:"t1"});
    expect(await screen.findByRole("button", {name:"Workspace: Platform. Change workspace"})).toBeTruthy();
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

  it("opens a mobile navigation menu and closes after selecting a destination", async () => {
    renderNav();
    await userEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Valet Security" })).toBeTruthy();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Skills" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("applies entitlement filtering to mobile destinations", async () => {
    securityPlugins = [];
    renderNav();
    await userEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Valet Security" })).toBeNull();
  });

  it("renders the Valet logo, not the orchestrator's name", async () => {
    renderNav();
    expect(await screen.findByText("Valet")).toBeTruthy();
    expect(screen.queryByText("Echo")).toBeNull();
  });

  // The labelled links do not fit beside the logo and the icons on a
  // phone. They live in one scrollable landmark so the row can slide
  // sideways instead of pushing the settings icon off-screen; jsdom has no
  // layout, so this guards the STRUCTURE that makes the CSS fix possible.
  it("keeps every destination inside one scrollable primary nav", async () => {
    renderNav();
    await screen.findByText("Valet");
    expect(screen.getByRole("link", { name: "Threads" }).getAttribute("href")).toBe("/chat");
    expect(screen.getByRole("link", { name: "Skills" }).getAttribute("href")).toBe("/skills");
    expect(screen.queryByRole("link", { name: "Sessions" })).toBeNull();
    expect(screen.getByRole("link", { name: "Artifacts" }).getAttribute("href")).toBe("/artifacts");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((el) => el.textContent);
    expect(labels).toEqual([
      "Threads",
      "Artifacts",
      "Automation",
      "Events",
      "Usage",
      "Skills",
      "Integrations",
      "Changelog",
    ]);
  });

  it("keeps artifacts and enabled plugins reachable in mobile navigation", async () => {
    renderNav();
    await userEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const menu = screen.getByRole("menu", { name: "Open navigation" });
    expect(within(menu).getByRole("menuitem", { name: "Artifacts" }).getAttribute("href")).toBe("/artifacts");
    expect(within(menu).getByRole("menuitem", { name: "Valet Security" }).getAttribute("href")).toBe("/security");
    expect(within(menu).getByRole("menuitem", { name: "Memory" }).getAttribute("href")).toBe("/memory");
  });

  it("moves Settings into mobile navigation and keeps the desktop shortcut", async () => {
    renderNav();
    const shortcut = await screen.findByRole("link", { name: "Settings" });
    expect(shortcut.classList.contains("hidden")).toBe(true);
    expect(shortcut.classList.contains("md:inline-flex")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const menu = screen.getByRole("menu", { name: "Open navigation" });
    expect(within(menu).getByRole("menuitem", { name: "Settings" }).getAttribute("href")).toBe("/settings");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Settings" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens Valet Security from the Plugins dropdown", async () => {
    renderNav();
    expect(screen.queryByRole("link", { name: "Security" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Plugins" }));
    expect(screen.getByRole("menuitem", { name: "Valet Security" }).getAttribute("href")).toBe("/security");
  });

  it("hides the Security link when the plugin is not enabled for the caller", async () => {
    securityPlugins = [
      {
        name: "security",
        label: "Valet Security",
        description: "",
        instanceEnabled: true,
        entitlement: { mode: "off", teamIds: [] },
        enabledForCaller: false,
      },
    ];
    renderNav();
    await screen.findByText("Valet");
    await userEvent.click(await screen.findByRole("button", { name: "Plugins" }));
    expect(screen.queryByRole("menuitem", { name: "Valet Security" })).toBeNull();
  });

  it("hides the Security link when no security plugin is loaded", async () => {
    securityPlugins = [];
    renderNav();
    await screen.findByText("Valet");
    await userEvent.click(await screen.findByRole("button", { name: "Plugins" }));
    expect(screen.queryByRole("menuitem", { name: "Valet Security" })).toBeNull();
  });

  // The logo and the two icons sit OUTSIDE that scroller, so they stay put
  // while the links scroll. Regression guard: moving either inside the nav
  // would scroll them out of reach on a phone.
  it("keeps the logo and the settings icon outside the scrolling nav", async () => {
    renderNav();
    await screen.findByText("Valet");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).queryByLabelText("Valet — dashboard")).toBeNull();
    expect(within(nav).queryByLabelText("Settings")).toBeNull();
    expect(screen.getByLabelText("Settings")).toBeTruthy();
  });

  it("does not render a New runtime button", async () => {
    renderNav();
    await screen.findByText("Valet");
    expect(screen.queryByText("New runtime")).toBeNull();
  });
});

/**
 * The sidebar toggle. It lives in the nav rather than floating over the
 * sidebar's top-right corner, where it used to cover the assistants rail's
 * "New assistant" button — a control the user could see and could not click.
 *
 * jsdom has no layout and no media queries, so both the mobile and desktop
 * buttons are in the DOM at once and CSS alone decides which is visible.
 * These assert the part CSS cannot: that each announces the action it
 * performs, and that the desktop one tracks the shell's real state.
 */
describe("TopNav — sidebar toggle", () => {
  // The collapsed state persists to localStorage, which jsdom shares across
  // tests in a file — without this, whichever test collapses the sidebar
  // decides the starting state of every test after it.
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("draws no toggle outside a shell", async () => {
    renderNav();
    await screen.findByText("Valet");
    expect(screen.queryByRole("button", { name: /sidebar/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /open threads/i })).toBeNull();
  });

  it("draws no toggle when the shell has no sidebar to control", async () => {
    renderNav({ withSidebar: false });
    await screen.findByText("Valet");
    expect(screen.queryByRole("button", { name: /sidebar/i })).toBeNull();
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

  it("keeps the mobile drawer control labelled for its own action", async () => {
    renderNav({ withSidebar: true });
    await screen.findByText("Valet");
    // Distinct from the desktop label: it opens a drawer, it does not
    // collapse anything, and a screen reader must not be told otherwise.
    expect(screen.getByRole("button", { name: "Open threads" })).toBeTruthy();
  });

  it("puts the toggle ahead of the logo, at the row's left edge", async () => {
    renderNav({ withSidebar: true });
    const logo = await screen.findByText("Valet");
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    // `compareDocumentPosition` is the only order check jsdom can make; the
    // flex row does the rest.
    expect(toggle.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

const openAssistant = vi.fn();
vi.mock("~/components/layout/workspace-assistant", () => ({ useWorkspaceAssistant: () => ({ open: openAssistant }), WorkspaceAssistantButton: () => <button>Ask Valet</button> }));

it("opens Memory on hover while Artifacts remains a direct link", async () => {
  const user = userEvent.setup();
  renderNav();
  expect((await screen.findByRole("link", { name: "Artifacts" })).getAttribute("href")).toBe("/artifacts");
  await user.hover(screen.getByRole("link", { name: "Artifacts" }));
  expect(screen.getByRole("menuitem", { name: "Memory" }).getAttribute("href")).toBe("/memory");
});

it("navigates directly to Artifacts and opens the list with Arrow Down", async () => {
  const user = userEvent.setup();
  renderNav();
  const link = await screen.findByRole("link", { name: "Artifacts" });
  await user.click(link);
  await waitFor(() => expect(link.getAttribute("aria-current")).toBe("page"));
  expect(screen.queryByRole("menu")).toBeNull();
  link.focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Memory" })).toBeTruthy();
  await user.click(screen.getByRole("menuitem", { name: "Memory" }));
  await waitFor(() => expect(link.getAttribute("aria-current")).toBeNull());
  expect(screen.queryByRole("menu")).toBeNull();
});

it("opens Ask Valet from the mobile menu", async () => {
  const user = userEvent.setup();
  renderNav();
  await user.click(await screen.findByRole("button", { name: "Open navigation" }));
  await user.click(screen.getByRole("menuitem", { name: "Ask Valet" }));
  expect(openAssistant).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu", { name: "Navigation" })).toBeNull();
});
