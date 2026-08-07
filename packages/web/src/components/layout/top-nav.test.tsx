// @vitest-environment jsdom
/**
 * Product-first nav: the logo is always "Valet" (the orchestrator's chosen
 * name lives in its own title card, not the logo), the presence dot still
 * reflects the orchestrator's state, "Sessions" links to /sessions, and
 * the old "New session" button is gone from the nav (it moved to the
 * /sessions stub page — see routes/sessions.tsx).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
  const skillsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, sessionsRoute, skillsRoute]),
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
  it("renders the Valet logo, not the orchestrator's name", async () => {
    renderNav();
    expect(await screen.findByText("Valet")).toBeTruthy();
    expect(screen.queryByText("Echo")).toBeNull();
  });

  it("renders a Sessions link", async () => {
    renderNav();
    const link = await screen.findByRole("link", { name: "Sessions" });
    expect(link.getAttribute("href")).toBe("/sessions");
  });

  it("renders a Skills link between Workflows and Integrations", async () => {
    renderNav();
    const link = await screen.findByRole("link", { name: "Skills" });
    expect(link.getAttribute("href")).toBe("/skills");

    const labels = screen.getAllByRole("link").map((el) => el.textContent);
    expect(labels.indexOf("Skills")).toBeGreaterThan(labels.indexOf("Workflows"));
    expect(labels.indexOf("Skills")).toBeLessThan(labels.indexOf("Integrations"));
  });

  // The six labelled links do not fit beside the logo and the icons on a
  // phone. They live in one scrollable landmark so the row can slide
  // sideways instead of pushing the settings icon off-screen; jsdom has no
  // layout, so this guards the STRUCTURE that makes the CSS fix possible.
  it("keeps every destination inside one scrollable primary nav", async () => {
    renderNav();
    await screen.findByText("Valet");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((el) => el.textContent);
    expect(labels).toEqual(["Chat", "Memory", "Sessions", "Workflows", "Skills", "Integrations"]);
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

  it("does not render a New session button", async () => {
    renderNav();
    await screen.findByText("Valet");
    expect(screen.queryByText("New session")).toBeNull();
  });
});
