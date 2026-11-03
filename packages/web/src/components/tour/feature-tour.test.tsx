// @vitest-environment jsdom
/** The tour: version gating from the server's `due`, resume, skip, a step
 * whose element is missing, plugin gating, phone cards, and replay. */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TutorialStateResponse } from "@valet/api/wire";

let pathname = "/";
const navigate = vi.fn();
let mobile = false;
let slackOn = true;

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) => select({ location: { pathname } }),
}));
vi.mock("~/hooks/use-mobile-layout", () => ({ useMobileLayout: () => mobile }));
vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: { plugins: [{ name: "slack", enabledForCaller: slackOn }] } }),
  pluginEnabledForCaller: (org: { plugins: { name: string; enabledForCaller: boolean }[] } | undefined, name: string) =>
    org ? org.plugins.find((plugin) => plugin.name === name)?.enabledForCaller ?? false : undefined,
}));
const tutorial = vi.fn<() => Promise<TutorialStateResponse>>();
const updateTutorial = vi.fn();
vi.mock("~/api/client", () => ({ api: { tutorial: () => tutorial(), updateTutorial: (body: unknown) => updateTutorial(body) } }));

import { FeatureTourProvider, useFeatureTour } from "./feature-tour";
import { nextAvailableIndex, resumeIndex, TOUR_STEPS } from "./tour-steps";

const DUE: TutorialStateResponse = { version: 2, orgVersion: 1, seenVersion: 0, seenOrgVersion: 0, outcome: null, step: null, due: true };

/** Every anchor except the Tasks button, which only Home's wide layout has. */
function Page({ without = [] as string[] }) {
  return <div>
    {["home", "spaces", "projects", "workflows", "presence", "space-settings"].filter((id) => !without.includes(id))
      .map((id) => <button key={id} type="button" data-tour={id}>{id}</button>)}
  </div>;
}

function ReplayButton() {
  const tour = useFeatureTour();
  return <button type="button" onClick={() => tour?.start()}>Take the tour</button>;
}

function renderTour(children = <Page />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = <QueryClientProvider client={client}><FeatureTourProvider>{children}<ReplayButton /></FeatureTourProvider></QueryClientProvider>;
  const view = render(ui);
  return { rerender: () => view.rerender(ui) };
}

async function stepTitle(title: string) {
  return screen.findByRole("heading", { name: title });
}

beforeEach(() => {
  pathname = "/";
  mobile = false;
  slackOn = true;
  navigate.mockReset();
  tutorial.mockReset();
  updateTutorial.mockReset();
  updateTutorial.mockImplementation(async (body: { outcome?: string }) => ({ ...DUE, ...(body.outcome ? { outcome: body.outcome, due: false } : {}) }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("tour steps", () => {
  it("skips unavailable steps both ways and resumes at a saved id", () => {
    const noTasks = (step: { id: string }) => step.id !== "tasks";
    expect(nextAvailableIndex(TOUR_STEPS, 1, noTasks)).toBe(2);
    expect(nextAvailableIndex(TOUR_STEPS, 1, noTasks, -1)).toBe(0);
    expect(nextAvailableIndex(TOUR_STEPS, TOUR_STEPS.length, () => true)).toBe(-1);
    expect(resumeIndex(TOUR_STEPS, "workflows")).toBe(4);
    expect(resumeIndex(TOUR_STEPS, "renamed-step")).toBe(0);
    expect(resumeIndex(TOUR_STEPS, null)).toBe(0);
  });
});

describe("FeatureTourProvider", () => {
  it("starts a due tour on Home and skips a step whose element is missing", async () => {
    tutorial.mockResolvedValue(DUE);
    renderTour();
    await stepTitle("Home");
    expect(screen.getByText("1 of 7")).toBeTruthy();
    await waitFor(() => expect(updateTutorial).toHaveBeenCalledWith({ step: "home", version: 2, orgVersion: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // No Tasks button on this page: the tour goes on to Spaces.
    await stepTitle("Spaces");
    expect(screen.getByText("2 of 7")).toBeTruthy();
    expect(document.querySelector('[data-tour="spaces"]')?.hasAttribute("data-tour-active")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await stepTitle("Home");
  });

  it("shows nothing to a user who finished the current version", async () => {
    tutorial.mockResolvedValue({ ...DUE, seenVersion: 2, seenOrgVersion: 1, outcome: "completed", due: false });
    renderTour();
    await waitFor(() => expect(tutorial).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(updateTutorial).not.toHaveBeenCalled();
  });

  it("shows the tour again after a version bump made it due", async () => {
    tutorial.mockResolvedValue({ ...DUE, seenVersion: 1, seenOrgVersion: 1, outcome: "completed", due: true });
    renderTour();
    await stepTitle("Home");
  });

  it("waits only on Home", async () => {
    pathname = "/workflows";
    tutorial.mockResolvedValue(DUE);
    renderTour();
    await waitFor(() => expect(tutorial).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resumes at the saved step", async () => {
    tutorial.mockResolvedValue({ ...DUE, step: "workflows" });
    renderTour();
    await stepTitle("Workflows");
  });

  it("saves a skip with the versions the person saw", async () => {
    tutorial.mockResolvedValue(DUE);
    renderTour();
    await stepTitle("Home");
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    await waitFor(() => expect(updateTutorial).toHaveBeenCalledWith({ outcome: "skipped", version: 2, orgVersion: 1 }));
    expect(screen.queryByRole("heading", { name: "Home" })).toBeNull();
  });

  it("moves past a step whose element never renders", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    tutorial.mockResolvedValue({ ...DUE, step: "workflows" });
    renderTour(<Page without={["workflows"]} />);
    await waitFor(() => expect(updateTutorial).toHaveBeenCalledWith({ step: "workflows", version: 2, orgVersion: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await stepTitle("Presence");
  });

  it("ends at the last available step and saves completion", async () => {
    slackOn = false;
    tutorial.mockResolvedValue({ ...DUE, step: "integrations" });
    renderTour();
    await stepTitle("Integrations");
    expect(screen.getByText(/choose Take the tour/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(updateTutorial).toHaveBeenCalledWith({ outcome: "completed", version: 2, orgVersion: 1 }));
  });

  it("shows phone cards with phone copy and no anchors", async () => {
    mobile = true;
    tutorial.mockResolvedValue(DUE);
    renderTour(<div />);
    await stepTitle("Home");
    expect(screen.getByText(/shows in the Tasks tab/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await stepTitle("Tasks");
    expect(screen.getByText("2 of 8")).toBeTruthy();
  });

  it("replays from another page by opening Home first", async () => {
    pathname = "/workflows";
    tutorial.mockResolvedValue({ ...DUE, outcome: "completed", due: false });
    const view = renderTour();
    await waitFor(() => expect(tutorial).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
    pathname = "/";
    view.rerender();
    await stepTitle("Home");
  });
});
