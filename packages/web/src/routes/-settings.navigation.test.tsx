// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

vi.mock("~/lib/workspace-scope", () => ({
  useWorkspaceScope: () => ({ key: "team_1", teamId: "team_1", available: ["user", "team_1"], setKey: vi.fn() }),
}));

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrg: () => ({
      data: { callerRole: "admin", features: { organizations: true } },
      isLoading: false,
      error: null,
    }),
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
  const appearance = createRoute({
    getParentRoute: () => settings,
    path: "appearance",
    component: () => <p>Appearance page</p>,
  });
  return createRouter({
    routeTree: root.addChildren([settings.addChildren([teams, profile, appearance])]),
    history: createMemoryHistory({ initialEntries: ["/settings/organization/teams"] }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("settings navigation from Organization Teams", () => {
  it.each([
    ["Profile", "/settings/profile", "Profile page"],
    ["Appearance", "/settings/appearance", "Appearance page"],
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
