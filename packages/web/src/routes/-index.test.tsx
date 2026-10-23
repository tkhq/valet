// @vitest-environment jsdom
/** On a wider screen, Home selects the personal or team dashboard without
 * profile setup. A phone gets the Home conversation instead. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const infoMock = vi.fn();

// The dashboard renders bare Links (Manage assistants), which need a router
// — mock them to anchors, same as every other route test.
vi.mock("@tanstack/react-router", () => ({
  // `options` mirrors the real route, so a test reads `validateSearch` the same way.
  createFileRoute: () => (config: object) => ({ ...config, options: config, useSearch: () => ({}) }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("~/api/workspace-runtime", () => ({
  useWorkspaceRuntimeInfo: () => infoMock(),

}));

vi.mock("~/components/dashboard/workspace-catch-up", () => ({
  WorkspaceCatchUp: () => <div data-testid="catch-up" />,
}));
vi.mock("~/components/assistant/memory-card", () => ({
  MemoryCard: () => <div data-testid="memory-card" />,
}));
vi.mock("~/components/assistant/usage-card", () => ({
  UsageCard: () => <div data-testid="usage-card" />,
}));
const mobile = vi.fn(() => false);
vi.mock("~/hooks/use-mobile-layout", () => ({ useMobileLayout: () => mobile() }));
vi.mock("~/components/home/home-screen", () => ({ HomeScreen: ({ view }: { view: string }) => <div data-testid="home-screen" data-view={view} /> }));
vi.mock("~/lib/page-title", () => ({ usePageTitle: () => undefined }));
vi.mock("~/components/dashboard/team-dashboard", () => ({
  TeamDashboard: ({ teamId }: { teamId: string }) => (
    <div data-testid="team-dashboard" data-team={teamId} />
  ),
}));

// The workspace branch (team dashboard design): `Home` reads the scope and
// picks a dashboard. Personal is the context default, so only the team
// arm needs the mock to steer.
const scopeMock = vi.fn((): { key: string; teamId: string | undefined; available: string[]; setKey: (next: string) => void } => ({
  key: "user",
  teamId: undefined,
  available: ["user"],
  setKey: vi.fn(),
}));
vi.mock("~/lib/workspace-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/workspace-scope")>();
  return { ...actual, useWorkspaceScope: () => scopeMock() };
});

import { Dashboard, Home, Route } from "./index";

function renderDashboard() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>,
  );
}

describe("Dashboard", () => {

  it("shows the personal workspace header and cards", () => {
    infoMock.mockReturnValue({
      data: {
        sessionId: "orchestrator:user-1",
        presence: "idle",
        activeChildren: 0,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderDashboard();

    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.getByTestId("catch-up")).toBeTruthy();
    expect(screen.getByTestId("memory-card")).toBeTruthy();
    expect(screen.getByTestId("usage-card")).toBeTruthy();
    expect(screen.queryByText("Meet your assistant")).toBeNull();
  });

  it("shows a loading state while the info query is in flight", () => {
    infoMock.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch: vi.fn() });
    renderDashboard();
    expect(screen.queryByTestId("catch-up")).toBeNull();
    expect(screen.queryByText("Meet your assistant")).toBeNull();
  });
});

describe("Home (workspace branch)", () => {
  it("renders the personal dashboard when the scope is personal", () => {
    scopeMock.mockReturnValue({ key: "user", teamId: undefined, available: ["user"], setKey: vi.fn() });
    infoMock.mockReturnValue({
      data: { sessionId: "orchestrator:user-1", presence: "idle", activeChildren: 0 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <Home />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("team-dashboard")).toBeNull();
  });

  it("renders the team dashboard when the scope names a team", () => {
    scopeMock.mockReturnValue({ key: "team_1", teamId: "team_1", available: ["user", "team_1"], setKey: vi.fn() });
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <Home />
      </QueryClientProvider>,
    );
    const dash = screen.getByTestId("team-dashboard");
    expect(dash.getAttribute("data-team")).toBe("team_1");
  });
});

describe("Home on a phone", () => {
  it("restores the team dashboard when the viewport returns to desktop", () => {
    scopeMock.mockReturnValue({ key: "team_1", teamId: "team_1", available: ["user", "team_1"], setKey: vi.fn() });
    mobile.mockReturnValue(false);
    const client = new QueryClient();
    const view = () => <QueryClientProvider client={client}><Home /></QueryClientProvider>;
    const { rerender } = render(view());
    expect(screen.getByTestId("team-dashboard")).toBeTruthy();
    expect(screen.queryByTestId("home-screen")).toBeNull();
    mobile.mockReturnValue(true);
    rerender(view());
    expect(screen.getByTestId("home-screen")).toBeTruthy();
    expect(screen.queryByTestId("team-dashboard")).toBeNull();
    mobile.mockReturnValue(false);
    rerender(view());
    expect(screen.getByTestId("team-dashboard")).toBeTruthy();
    expect(screen.queryByTestId("home-screen")).toBeNull();
  });

  it("shows the Home conversation instead of a dashboard", () => {
    mobile.mockReturnValueOnce(true);
    render(<QueryClientProvider client={new QueryClient()}><Home /></QueryClientProvider>);
    expect(screen.getByTestId("home-screen").dataset.view).toBe("chat");
    expect(screen.queryByTestId("team-dashboard")).toBeNull();
    expect(screen.queryByText("Personal")).toBeNull();
  });

  it("reads only view=tasks and view=make from the URL", () => {
    const validate = (Route.options as { validateSearch: (raw: Record<string, unknown>) => unknown }).validateSearch;
    expect(validate({ view: "tasks" })).toEqual({ view: "tasks" });
    expect(validate({ view: "make" })).toEqual({ view: "make" });
    expect(validate({ view: "chat" })).toEqual({});
    expect(validate({})).toEqual({});
  });
});
