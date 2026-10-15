// @vitest-environment jsdom
/**
 * The UI stress gallery route (`/dev/ui-stress`): in dev it renders every
 * section from fixtures alone, and the production gate answers 404. The page
 * is the real route's component under a memory router.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MutationObserver, QueryObserver } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { TooltipProvider } from "~/components/primitives/tooltip";
import { Route as UiStressRoute } from "~/routes/dev.ui-stress";
import { uiStressClient } from "./client";
import { FrozenQueryClient, MUTATIONS_DISABLED, MissingFixtureError } from "./frozen-query-client";
import { UI_STRESS_SECTIONS } from "./gallery";
import { UI_STRESS_PATH, requireUiStress } from "./gate";

function mount() {
  const root = createRootRoute({
    component: () => <TooltipProvider><Outlet /></TooltipProvider>,
    notFoundComponent: () => <p>Page not found</p>,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: UI_STRESS_PATH,
    beforeLoad: requireUiStress,
    component: UiStressRoute.options.component,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [UI_STRESS_PATH] }),
  });
  render(<RouterProvider router={router} />);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/dev/ui-stress", () => {
  it("gates the route on the production check", () => {
    expect(UiStressRoute.options.beforeLoad).toBe(requireUiStress);
  });

  it("renders every section from fixtures, with no key left unseeded", async () => {
    mount();
    for (const section of UI_STRESS_SECTIONS) {
      expect(await screen.findByRole("heading", { level: 2, name: section.title })).toBeTruthy();
    }
    // The bell opens on load with 20 workflow items and a first decision
    // page of 20 that has a next page.
    expect((await screen.findAllByText("40+")).length).toBeGreaterThan(0);
    await waitFor(() => expect(uiStressClient.isFetching()).toBe(0));
    const missing = uiStressClient.getQueryCache().findAll()
      .filter((query) => query.state.error instanceof MissingFixtureError)
      .map((query) => query.queryKey);
    expect(missing).toEqual([]);
  });

  it("answers 404 in a production build", async () => {
    vi.stubEnv("DEV", false);
    mount();
    expect(await screen.findByText("Page not found")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "UI stress gallery" })).toBeNull();
  });
});

describe("FrozenQueryClient", () => {
  it("answers a refetch from the cache and never calls the hook's query function", async () => {
    const client = new FrozenQueryClient();
    client.setQueryData(["thing"], { n: 1 });
    const queryFn = vi.fn(async () => ({ n: 2 }));
    const result = await new QueryObserver(client, { queryKey: ["thing"], queryFn, refetchInterval: 10 }).refetch();
    expect(result.data).toEqual({ n: 1 });
    expect(queryFn).not.toHaveBeenCalled();
    const unseeded = await new QueryObserver(client, { queryKey: ["unseeded"], queryFn }).refetch();
    expect(unseeded.error).toBeInstanceOf(MissingFixtureError);
  });

  it("fails every mutation without sending it", async () => {
    const mutationFn = vi.fn(async () => "sent");
    await expect(new MutationObserver(new FrozenQueryClient(), { mutationFn }).mutate()).rejects.toThrow(MUTATIONS_DISABLED);
    expect(mutationFn).not.toHaveBeenCalled();
  });
});
