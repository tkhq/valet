// @vitest-environment jsdom
/** A space whose assistant cannot start still lists Spaces, so the person
 * can switch to another space. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TeamSummary } from "@valet/api/wire";
import { expect, it, vi } from "vitest";
import { WorkspaceScopeProvider } from "~/lib/workspace-scope";
import { AssistantRail } from "./assistant-rail";

const teams: TeamSummary[] = [{ id: "t1", name: "Broken", orgId: "org", createdAt: 1, memberCount: 2, callerRole: "member", origin: "local", externalId: null, defaultModel: null },
  { id: "t2", name: "Working", orgId: "org", createdAt: 1, memberCount: 2, callerRole: "member", origin: "local", externalId: null, defaultModel: null }];
vi.mock("~/api/settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/settings")>(),
  useOrg: () => ({ data: { features: { organizations: true }, plugins: [] }, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams }, isLoading: false, error: null }),
}));
const retry = vi.fn();
vi.mock("~/hooks/use-workspace-conversation", () => ({
  useWorkspaceConversation: () => ({ data: undefined, error: new Error("Could not start the assistant"), refetch: retry }),
  useCurrentWorkspace: () => "t1",
}));

it("lists Spaces when the space's runtime fails, and switches to another space", async () => {
  const root = createRootRoute({ component: () => <WorkspaceScopeProvider><AssistantRail /><Outlet /></WorkspaceScopeProvider> });
  const routes = ["/", "/chat", "/workflows"].map((path) => createRoute({ getParentRoute: () => root, path, component: () => null }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ["/workflows?workspace=t1"] }) });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);

  expect((await screen.findByRole("alert")).textContent).toContain("open another space");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("link", { name: "Working" }));
  await waitFor(() => expect(router.state.location.search).toEqual({ workspace: "t2" }));
  expect(router.state.location.pathname).toBe("/workflows");
});
