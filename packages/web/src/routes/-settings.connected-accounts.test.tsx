// @vitest-environment jsdom
/**
 * `/settings/connected-accounts` redirects to personal Integrations, which
 * now holds every connection. Old links, emails, and OAuth returns still
 * arrive at the old path, so the redirect keeps their connect result.
 */
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouteComponent,
} from "@tanstack/react-router";
import { Route as ConnectedAccountsRoute, connectedAccountsTarget } from "./settings.connected-accounts";

function mount(initial: string) {
  const root = createRootRoute({ component: Outlet });
  const component: RouteComponent | undefined = ConnectedAccountsRoute.options.component;
  if (!component) throw new Error("route has no component");
  const tree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: "settings/connected-accounts", component }),
    createRoute({ getParentRoute: () => root, path: "integrations", component: () => <p>Integrations page</p> }),
  ]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [initial] }) });
  render(<RouterProvider router={router} />);
  return router;
}

describe("/settings/connected-accounts", () => {
  it("opens personal Integrations and replaces the old entry", async () => {
    const router = mount("/settings/connected-accounts");
    await waitFor(() => expect(router.state.location.pathname).toBe("/integrations"));
    expect(router.state.location.search).toEqual({ workspace: "user" });
    // Replace, not push: Back must not land on the redirect again.
    expect(router.history.length).toBe(1);
  });

  it("keeps a GitHub return as the result Integrations reads", async () => {
    const router = mount("/settings/connected-accounts?github=connected");
    await waitFor(() => expect(router.state.location.pathname).toBe("/integrations"));
    expect(router.state.location.search).toEqual({ workspace: "user", connected: "github" });
  });

  it("keeps an OAuth result and drops anything else", () => {
    expect(connectedAccountsTarget({ connected: "slack-user", next: "https://evil.example" }))
      .toBe("/integrations?workspace=user&connected=slack-user");
    expect(connectedAccountsTarget({ error: "oauth_failed", detail: "Try again." }))
      .toBe("/integrations?workspace=user&error=oauth_failed&detail=Try+again.");
  });
});
