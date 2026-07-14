// @vitest-environment jsdom
/**
 * Assistant-first nav (decision 9): the presence mark renders the name
 * from the mocked info query, "Sessions" links to /sessions, and the old
 * "New session" button is gone from the nav (it moved to the /sessions
 * stub page — see routes/sessions.tsx).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { TopNav } from "./top-nav";

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({
    data: {
      sessionId: "orchestrator:user-1",
      name: "Echo",
      personality: null,
      presence: "idle",
      activeChildren: 0,
    },
  }),
}));

// The bell owns its own network calls (useNotifications) and is covered by
// its own test — stub it here so this test stays focused on nav layout.
vi.mock("./notifications-bell", () => ({
  NotificationsBell: () => <div data-testid="bell-stub" />,
}));

function renderNav() {
  const rootRoute = createRootRoute({
    component: () => <TopNav />,
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, sessionsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient();

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("TopNav", () => {
  it("renders the assistant's name from the info query", async () => {
    renderNav();
    expect(await screen.findByText("Echo")).toBeTruthy();
  });

  it("renders a Sessions link", async () => {
    renderNav();
    const link = await screen.findByRole("link", { name: "Sessions" });
    expect(link.getAttribute("href")).toBe("/sessions");
  });

  it("does not render a New session button", async () => {
    renderNav();
    await screen.findByText("Echo");
    expect(screen.queryByText("New session")).toBeNull();
  });
});
