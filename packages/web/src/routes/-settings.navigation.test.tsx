// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

vi.mock("~/lib/workspace-scope", () => ({
  useWorkspaceScope: () => ({ key: "team_1", teamId: "team_1", available: ["user", "team_1"], setKey: vi.fn() }),
}));

vi.mock("~/api/integrations", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/integrations")>(),
  usePlugins: () => ({ data: { plugins: [] }, isLoading: false, error: null }),
}));
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrg: () => ({
      data: { callerRole: "admin", features: { organizations: true }, plugins: [] },
      isLoading: false,
      error: null,
    }),
    useTeams: () => ({ data: { teams: [] }, isLoading: false, error: null }),
  };
});

import { SettingsLayout } from "./settings";

function settingsRouter() {
  const root = createRootRoute();
  const settings = createRoute({ getParentRoute: () => root, path: "settings", component: SettingsLayout });
  const teams = createRoute({
    getParentRoute: () => settings,
    path: "organization/teams",
    component: () => <p>Teams page</p>,
  });
  const profile = createRoute({
    getParentRoute: () => settings,
    path: "profile",
    component: () => <p>Profile page</p>,
  });
  const preferences = createRoute({
    getParentRoute: () => settings,
    path: "preferences",
    component: () => <p>Preferences page</p>,
  });
  return createRouter({
    routeTree: root.addChildren([settings.addChildren([teams, profile, preferences])]),
    history: createMemoryHistory({ initialEntries: ["/settings/organization/teams"] }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("settings navigation from Organization Teams", () => {
  it.each([
    ["Profile", "/settings/profile", "Profile page"],
    ["Preferences", "/settings/preferences", "Preferences page"],
  ])("exits to %s and stays there", async (label, expectedPath, expectedPage) => {
    const router = settingsRouter();
    render(<RouterProvider router={router} />);
    await screen.findByText("Teams page");

    await userEvent.click(screen.getByRole("link", { name: label }));

    await waitFor(() => expect(router.state.location.pathname).toBe(expectedPath));
    expect(await screen.findByText(expectedPage)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.state.location.pathname).toBe(expectedPath);
    expect(screen.queryByText("Teams page")).toBeNull();
  });
});

describe("leaving settings", () => {
  it.each(["/integrations", "/workflows", "/chat"])("allows primary navigation to %s", async (destination) => {
    const root = createRootRoute({ component: () => <><Link to={destination}>Leave settings</Link><Outlet /></> });
    const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsLayout });
    const profile = createRoute({ getParentRoute: () => settings, path: "/profile", component: () => <p>Profile page</p> });
    const target = createRoute({ getParentRoute: () => root, path: destination, component: () => <p>Destination content</p> });
    const router = createRouter({
      routeTree: root.addChildren([settings.addChildren([profile]), target]),
      history: createMemoryHistory({ initialEntries: ["/settings/profile"] }),
      defaultPendingMinMs: 0,
    });
    render(<RouterProvider router={router} />);
    await screen.findByText("Profile page");
    fireEvent.click(screen.getByRole("link", { name: "Leave settings" }));
    await screen.findByText("Destination content");
    await waitFor(() => expect(router.state.status).toBe("idle"));
    expect(router.state.location.pathname).toBe(destination);
    expect(screen.queryByText("Profile page")).toBeNull();
  });
});
