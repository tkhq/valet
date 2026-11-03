// @vitest-environment jsdom
/** The thread sidebar lists Spaces in place of the top-bar switcher: the
 * active space holds its threads, and another space's row switches to it
 * through the URL. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TeamSummary } from "@valet/api/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceScopeProvider } from "~/lib/workspace-scope";
import { SpacesNav } from "./spaces-nav";

let teams: TeamSummary[] = [];
vi.mock("~/api/settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/settings")>(),
  useOrg: () => ({ data: { features: { organizations: true } }, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams }, isLoading: false, error: null }),
}));

const team = (id: string, name: string): TeamSummary =>
  ({ id, name, orgId: "org", createdAt: 1, memberCount: 2, callerRole: "member", origin: "local", externalId: null, defaultModel: null });

function mount(path: string, bare = false) {
  const root = createRootRoute({ component: () => <WorkspaceScopeProvider><Outlet /></WorkspaceScopeProvider> });
  const page = () => <SpacesNav bare={bare}><div data-testid="threads" /></SpacesNav>;
  const routes = ["/", "/chat"].map(p => createRoute({ getParentRoute: () => root, path: p, component: page }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

describe("SpacesNav", () => {
  beforeEach(() => {
    teams = [];
    window.sessionStorage.clear();
  });

  it("shows only the threads when there is one space", async () => {
    mount("/");
    expect(await screen.findByTestId("threads")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Spaces" })).toBeNull();
  });

  it("opens the active space with its threads and lists the others as rows", async () => {
    teams = [team("t1", "Platform"), team("t2", "People")];
    mount("/?workspace=t1");
    const spaces = await screen.findByRole("region", { name: "Spaces" });
    const active = within(spaces).getByRole("group", { name: "Platform" });
    expect(within(active).getByTestId("threads")).toBeTruthy();
    expect(within(spaces).getByRole("button", { name: "Open space Personal" })).toBeTruthy();
    expect(within(spaces).getByRole("button", { name: "Open space People" })).toBeTruthy();
  });

  it("switches space by naming it in the URL, and keeps Home open", async () => {
    teams = [team("t1", "Platform")];
    const router = mount("/");
    await userEvent.click(await screen.findByRole("button", { name: "Open space Platform" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ workspace: "t1" }));
    expect(router.state.location.pathname).toBe("/");
    expect(await screen.findByRole("group", { name: "Platform" })).toBeTruthy();
    expect(window.sessionStorage.getItem("valet:workspace")).toBe("t1");
  });

  it("opens the new space's thread list from Chat", async () => {
    teams = [team("t1", "Platform")];
    const router = mount("/chat?thread=th-old");
    await userEvent.click(await screen.findByRole("button", { name: "Open space Platform" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: "t1" }));
  });

  it("leaves a phone drawer to its own space dropdown", async () => {
    teams = [team("t1", "Platform")];
    mount("/", true);
    expect(await screen.findByTestId("threads")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Spaces" })).toBeNull();
  });
});
