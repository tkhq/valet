// @vitest-environment jsdom
/** The app-wide sidebar lists Spaces, Linear style: each space opens to its
 * pages, and every page row names its space in the URL. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, useBlocker } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TeamSummary } from "@valet/api/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceScopeProvider } from "~/lib/workspace-scope";
import { SpacesNav, spacePageFor } from "./spaces-nav";

let teams: TeamSummary[] = [];
vi.mock("~/api/settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/settings")>(),
  useOrg: () => ({ data: { features: { organizations: true } }, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams }, isLoading: false, error: null }),
}));

const team = (id: string, name: string): TeamSummary =>
  ({ id, name, orgId: "org", createdAt: 1, memberCount: 2, callerRole: "member", origin: "local", externalId: null, defaultModel: null });

function mount(path: string) {
  const root = createRootRoute({ component: () => <WorkspaceScopeProvider><SpacesNav /><Outlet /></WorkspaceScopeProvider> });
  const routes = ["/", "/chat", "/workflows", "/presence", "/artifacts"].map(p => createRoute({ getParentRoute: () => root, path: p, component: () => null }));
  // An editor with unsaved edits that refuses to be left.
  const editor = createRoute({ getParentRoute: () => root, path: "/workflows/$id", component: function Editor() { useBlocker({ shouldBlockFn: () => true }); return null; } });
  const router = createRouter({ routeTree: root.addChildren([...routes, editor]), history: createMemoryHistory({ initialEntries: [path] }) });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

describe("SpacesNav", () => {
  beforeEach(() => {
    teams = [];
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("lists a solo caller's Personal space with its pages", async () => {
    mount("/workflows");
    const pages = await screen.findByRole("list", { name: "Personal pages" });
    expect(within(pages).getAllByRole("link").map((link) => link.textContent)).toEqual(["Threads", "Workflows", "Presence", "Artifacts"]);
    expect(within(pages).getByRole("link", { name: "Workflows" }).getAttribute("aria-current")).toBe("page");
  });

  it("opens the active space and closes the others", async () => {
    teams = [team("t1", "Platform"), team("t2", "People")];
    mount("/presence?workspace=t1");
    const pages = await screen.findByRole("list", { name: "Platform pages" });
    expect(within(pages).getByRole("link", { name: "Presence" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("list", { name: "Personal pages" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show People pages" })).toBeTruthy();
  });

  it("opens another space's page in one click once expanded, naming the space in the URL", async () => {
    teams = [team("t1", "Platform")];
    const router = mount("/workflows");
    await userEvent.click(await screen.findByRole("button", { name: "Show Platform pages" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Workflows" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: "t1" }));
    expect(router.state.location.pathname).toBe("/workflows");
    expect(window.sessionStorage.getItem("valet:workspace")).toBe("t1");
  });

  it("opens a space and its Threads from the space name, and remembers it open", async () => {
    teams = [team("t1", "Platform")];
    const router = mount("/artifacts");
    await userEvent.click(await screen.findByRole("link", { name: "Platform" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
    expect(router.state.location.search).toEqual({ workspace: "t1" });
    expect(await screen.findByRole("list", { name: "Platform pages" })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("valet:spaces-expanded") ?? "{}")).toEqual({ t1: true });
  });

  it("keeps a space closed after the person collapses it", async () => {
    teams = [team("t1", "Platform")];
    mount("/chat");
    await userEvent.click(await screen.findByRole("button", { name: "Collapse Personal" }));
    expect(screen.queryByRole("list", { name: "Personal pages" })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("valet:spaces-expanded") ?? "{}")).toEqual({ user: false });
  });

  it("leaves the space unchanged when unsaved edits block leaving", async () => {
    teams = [team("t1", "Platform")];
    window.sessionStorage.setItem("valet:workspace", "t1");
    const router = mount("/workflows/wf-1");
    await userEvent.click(await screen.findByRole("button", { name: "Show Personal pages" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Workflows" }));
    expect(router.state.location.pathname).toBe("/workflows/wf-1");
    expect(window.sessionStorage.getItem("valet:workspace")).toBe("t1");
    expect(screen.getByRole("list", { name: "Platform pages" })).toBeTruthy();
  });

  it("draws no divider of its own, so the sidebar's only divider is its top row's", async () => {
    teams = [team("t1", "Platform")];
    mount("/chat");
    const spaces = await screen.findByRole("region", { name: "Spaces" });
    for (const node of [spaces, ...spaces.querySelectorAll("*")]) expect(node.className.toString()).not.toMatch(/\bborder-(t|b)\b/);
  });

  it("maps paths to the space page they belong to", () => {
    expect(spacePageFor("/")).toBe("/chat");
    expect(spacePageFor("/chat")).toBe("/chat");
    expect(spacePageFor("/workflows/runs/r1")).toBe("/workflows");
    expect(spacePageFor("/presence/activity")).toBe("/presence");
    expect(spacePageFor("/artifacts")).toBe("/artifacts");
    expect(spacePageFor("/memory")).toBeUndefined();
  });
});
