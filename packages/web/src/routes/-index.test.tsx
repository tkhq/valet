// @vitest-environment jsdom
/**
 * Dashboard branch (assistant-centered web UI, decision 11/20): `/` shows
 * the identity step when `info.name === null` (first visit), otherwise the
 * identity header + card grid. Card internals (each a self-contained
 * query, decision 15) are stubbed here so this test stays focused on the
 * naming-vs-dashboard branch — they're covered by their own component
 * tests.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const infoMock = vi.fn();

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => infoMock(),
  useOrchestratorChildren: () => ({
    data: { children: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSaveIdentity: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

vi.mock("~/api/queries", () => ({
  useNotifications: () => ({
    data: { notifications: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("~/components/assistant/threads-card", () => ({
  ThreadsCard: () => <div data-testid="threads-card" />,
}));
vi.mock("~/components/assistant/memory-card", () => ({
  MemoryCard: () => <div data-testid="memory-card" />,
}));
vi.mock("~/components/assistant/usage-card", () => ({
  UsageCard: () => <div data-testid="usage-card" />,
}));

import { Dashboard } from "./index";

function renderDashboard() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>,
  );
}

describe("Dashboard", () => {
  it("shows the identity step on first visit (name === null)", () => {
    infoMock.mockReturnValue({
      data: {
        sessionId: "orchestrator:user-1",
        name: null,
        personality: null,
        presence: "idle",
        activeChildren: 0,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderDashboard();

    expect(screen.getByText("Meet your assistant")).toBeTruthy();
    expect(screen.queryByTestId("threads-card")).toBeNull();
  });

  it("shows the identity header + card grid once named", () => {
    infoMock.mockReturnValue({
      data: {
        sessionId: "orchestrator:user-1",
        name: "Echo",
        personality: null,
        presence: "idle",
        activeChildren: 0,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderDashboard();

    expect(screen.getByText("Echo")).toBeTruthy();
    expect(screen.getByText("idle")).toBeTruthy();
    expect(screen.getByTestId("threads-card")).toBeTruthy();
    expect(screen.getByTestId("memory-card")).toBeTruthy();
    expect(screen.getByTestId("usage-card")).toBeTruthy();
    expect(screen.queryByText("Meet your assistant")).toBeNull();
  });

  it("shows a loading state while the info query is in flight", () => {
    infoMock.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch: vi.fn() });
    renderDashboard();
    expect(screen.queryByTestId("threads-card")).toBeNull();
    expect(screen.queryByText("Meet your assistant")).toBeNull();
  });
});
