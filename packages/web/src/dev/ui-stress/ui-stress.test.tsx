// @vitest-environment jsdom
/**
 * The UI stress gallery route (`/dev/ui-stress`): in dev it renders every
 * section from fixtures alone, and the production gate answers 404. The page
 * is the real route's component under a memory router. The app shell tests
 * put it under the real root layout too.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MutationObserver, QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { TooltipProvider } from "~/components/primitives/tooltip";
import type { ComposerFile } from "~/components/session/composer-files";
import { Route as RootRoute } from "~/routes/__root";
import { Route as UiStressRoute } from "~/routes/dev.ui-stress";
import { draftKey, useComposerDraftStore } from "~/stores/composer-drafts";
import { uiStressClient } from "./client";
import { FrozenQueryClient, MUTATIONS_DISABLED, MissingFixtureError } from "./frozen-query-client";
import { UI_STRESS_SECTIONS } from "./gallery";
import { UI_STRESS_PATH, requireUiStress } from "./gate";

/** Mounts the gallery route at `path`. `appShell` uses the real root layout,
 * which picks the app shell for the gallery, under the app's own client. */
function mount({ path = UI_STRESS_PATH, appShell = false }: { path?: string; appShell?: boolean } = {}) {
  const root = createRootRoute({
    component: appShell ? RootRoute.options.component : () => <TooltipProvider><Outlet /></TooltipProvider>,
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
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const appClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={appClient}><RouterProvider router={router} /></QueryClientProvider>);
}

/** Records every request and answers none of them. */
function blockFetch() {
  return vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("The test blocks the network."));
}

// A route test that mounts the gallery renders all of it. That takes under a
// second locally and about six on a loaded CI runner, so these tests wait
// longer than the 5 s test and 1 s findBy defaults.
const RENDER_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

// The route loads the gallery lazily. Its first import compiles every
// component it renders, which can take longer than a `findBy` waits on a
// loaded CI runner, so load it once before the tests mount the route.
beforeAll(async () => {
  await import("./gallery");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  useComposerDraftStore.setState({ owner: "", byKey: {} });
  localStorage.clear();
});

describe("/dev/ui-stress", () => {
  it("gates the route on the production check", () => {
    expect(UiStressRoute.options.beforeLoad).toBe(requireUiStress);
  });

  it("renders every section from fixtures, with no key left unseeded", async () => {
    mount();
    for (const section of UI_STRESS_SECTIONS) {
      expect(await screen.findByRole("heading", { level: 2, name: section.title }, { timeout: RENDER_TIMEOUT_MS })).toBeTruthy();
    }
    // The bell opens on load with 20 workflow items and a first decision
    // page of 20 that has a next page.
    expect((await screen.findAllByText("40+", {}, { timeout: RENDER_TIMEOUT_MS })).length).toBeGreaterThan(0);
    await waitFor(() => expect(uiStressClient.isFetching()).toBe(0), { timeout: RENDER_TIMEOUT_MS });
    const missing = uiStressClient.getQueryCache().findAll()
      .filter((query) => query.state.error instanceof MissingFixtureError)
      .map((query) => query.queryKey);
    expect(missing).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // jsdom cannot measure layout, so the gallery's layout audit is the
  // visual check. These pin the markup each overflow fix depends on.
  it("keeps the markup that stops long fixture text from overflowing", async () => {
    mount();
    await screen.findByRole("heading", { level: 2, name: UI_STRESS_SECTIONS[0]!.title }, { timeout: RENDER_TIMEOUT_MS });
    await waitFor(() => expect(uiStressClient.isFetching()).toBe(0), { timeout: RENDER_TIMEOUT_MS });
    // A team badge shrinks and truncates instead of pushing past its card.
    const teamLinks = [...document.querySelectorAll('a[href^="/chat?workspace="]')].filter((link) => link.querySelector(".truncate"));
    expect(teamLinks.length).toBeGreaterThan(0);
    for (const link of teamLinks) expect(link.className).not.toContain("shrink-0");
    // A long workflow name is clamped in the approvals list, with the full name on hover.
    const titles = [...document.querySelectorAll('[data-testid="action-required-item"] a[href^="/workflows/"]')].filter((link) => link.classList.contains("line-clamp-2"));
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(title.getAttribute("title")).toBe(title.textContent);
    // Gate and question buttons wrap their labels.
    const option = screen.getAllByRole("button").find((button) => /^Option 1: /.test(button.textContent ?? ""));
    expect(option?.className).toContain("whitespace-normal");
  }, TEST_TIMEOUT_MS);

  it("keeps the fixture account out of the real account's drafts", async () => {
    const owner = JSON.stringify(["org-real", "member-real"]);
    const store = useComposerDraftStore.getState();
    store.activateOwner(owner);
    const key = draftKey("real-session", "real-thread");
    // Only the text persists. An unsent file lives in memory alone.
    const file: ComposerFile = { id: "file-1", name: "notes.txt", bytes: 5, file: new File(["notes"], "notes.txt") };
    store.setText(key, "Unsent message");
    store.setFiles(key, [file]);
    mount({ appShell: true });
    await screen.findByRole("heading", { level: 1, name: "UI stress gallery" }, { timeout: RENDER_TIMEOUT_MS });
    expect(useComposerDraftStore.getState().owner).toBe(owner);
    expect(useComposerDraftStore.getState().byKey[key]?.files).toEqual([file]);
  }, TEST_TIMEOUT_MS);

  it("sends no request when Ask Valet opens the assistant", async () => {
    const fetchSpy = blockFetch();
    mount({ appShell: true });
    fireEvent.click(await screen.findByRole("button", { name: "Ask Valet" }, { timeout: RENDER_TIMEOUT_MS }));
    expect(await screen.findByText(MUTATIONS_DISABLED, {}, { timeout: RENDER_TIMEOUT_MS })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);

  it("puts the app shell on the fixtures when the path ends in a slash", async () => {
    const fetchSpy = blockFetch();
    mount({ path: `${UI_STRESS_PATH}/`, appShell: true });
    await screen.findByRole("heading", { level: 1, name: "UI stress gallery" }, { timeout: RENDER_TIMEOUT_MS });
    expect(screen.getByRole("button", { name: "Ask Valet" })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);

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
