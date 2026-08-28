// @vitest-environment jsdom
/**
 * Security session layout (valet-security M8, spec §engagement panel):
 * below `md` a Chat | Panel toggle renders, both panes exist, and the Chat
 * tab shows a dot while a decision gate is pending — the gates live in the
 * chat pane and must never hide silently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  DecisionGate,
  GetSessionResponse,
  GetSessionSecurityResponse,
  ListSecurityFindingsResponse,
} from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";
import { useStreamStore } from "~/stores/stream";

const getSessionMock = vi.fn<(id: string) => Promise<GetSessionResponse>>();
const getSecurityMock = vi.fn<(id: string) => Promise<GetSessionSecurityResponse>>();
const listFindingsMock = vi.fn<() => Promise<ListSecurityFindingsResponse>>();
const cancelReviewMock = vi.fn<(id: string) => Promise<GetSessionSecurityResponse>>();

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSession: (id: string) => getSessionMock(id),
      getSessionSecurity: (id: string) => getSecurityMock(id),
      listSecurityFindings: () => listFindingsMock(),
      cancelSecurityReview: (id: string) => cancelReviewMock(id),
    },
  };
});

interface MeQuery {
  data: { id: string; orgRole: string };
  isLoading: boolean;
  error: null;
}
interface TeamsQuery {
  data: { teams: Array<{ id: string; callerRole: string }> };
  isLoading: boolean;
  error: null;
}
const meMock = vi.fn<() => MeQuery>(() => ({
  data: { id: "u-1", orgRole: "member" },
  isLoading: false,
  error: null,
}));
const teamsMock = vi.fn<() => TeamsQuery>(() => ({
  data: { teams: [] },
  isLoading: false,
  error: null,
}));

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useMe: () => meMock(),
    useTeams: () => teamsMock(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { EngagementPanel, SecuritySessionLayout } from "./engagement-panel";

const security: GetSessionSecurityResponse = {
  engagement: {
    id: "eng-1",
    sessionId: "s-1",
    status: "running",
    repoFullName: "acme/site",
    repoRef: "a".repeat(40),
    plan: "cells: []",
    createdAt: 1,
    updatedAt: 2,
  },
  cells: [
    {
      id: "cell-1",
      ordinal: 1,
      persona: "code-review",
      mode: "fresh",
      goal: "recon the tree",
      dir: "01-recon",
      reads: [],
      review: false,
      status: "running",
      attempts: 1,
      compactedAt: null,
      childSessionId: "child-1",
      dispatchedAt: Date.now(),
      settledAt: null,
      createdAt: 1,
    },
  ],
  cost: { costUsd: 0.42, totalTokens: 1_200_000, priced: true },
};

const session: GetSessionResponse = {
  id: "s-1",
  workspace: "acme/site",
  status: "active",
  kind: "security",
  runState: "working",
  createdAt: 1,
  updatedAt: 2,
  lastActivityAt: 2,
  owner: { type: "user", id: "u-1" },
  messageCount: 0,
  profile: "headless",
  docker: false,
};

const gate: DecisionGate = {
  id: "gate-1",
  sessionId: "s-1",
  threadId: "t-1",
  type: "approval",
  title: "Start the security engagement on acme/site?",
  actions: [{ id: "approve", label: "Approve" }],
  status: "pending",
  createdAt: 1,
  updatedAt: 1,
};

function renderLayout() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <SecuritySessionLayout sessionId="s-1" chat={<div>CHAT PANE CONTENT</div>} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getSessionMock.mockResolvedValue(session);
  getSecurityMock.mockResolvedValue(security);
  listFindingsMock.mockResolvedValue({ findings: [], nextCursor: null });
  cancelReviewMock.mockReset();
  cancelReviewMock.mockResolvedValue(security);
  meMock.mockReturnValue({ data: { id: "u-1", orgRole: "member" }, isLoading: false, error: null });
  teamsMock.mockReturnValue({ data: { teams: [] }, isLoading: false, error: null });
  useStreamStore.getState().remove("s-1");
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <EngagementPanel sessionId="s-1" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("SecuritySessionLayout", () => {
  it("renders the mobile Chat | Panel toggle with both panes", async () => {
    renderLayout();
    const tablist = screen.getByRole("tablist", { name: "Session panes" });
    const chatTab = screen.getByRole("tab", { name: /Chat/ });
    const panelTab = screen.getByRole("tab", { name: /Panel/ });
    expect(tablist).toBeTruthy();
    expect(chatTab.getAttribute("aria-selected")).toBe("true");
    expect(panelTab.getAttribute("aria-selected")).toBe("false");

    // Both panes exist in the DOM (visibility is responsive CSS).
    expect(screen.getByText("CHAT PANE CONTENT")).toBeTruthy();
    expect(await screen.findByText("01-recon")).toBeTruthy();

    fireEvent.click(panelTab);
    expect(panelTab.getAttribute("aria-selected")).toBe("true");
    expect(chatTab.getAttribute("aria-selected")).toBe("false");
  });

  it("dots the Chat tab while a decision gate is pending", async () => {
    renderLayout();
    await screen.findByText("01-recon");
    expect(screen.queryByTestId("pending-gate-dot")).toBeNull();

    act(() => {
      useStreamStore.getState().setPendingGates("s-1", [gate]);
    });
    expect(screen.getByTestId("pending-gate-dot")).toBeTruthy();

    act(() => {
      useStreamStore.getState().setPendingGates("s-1", []);
    });
    expect(screen.queryByTestId("pending-gate-dot")).toBeNull();
  });

  it("shows Cancel review for an admin on a running engagement and cancels through confirm", async () => {
    renderPanel();
    const cancelBtn = await screen.findByRole("button", { name: "Cancel review" });
    expect(cancelBtn).toBeTruthy();

    // Opening the confirm and confirming calls the cancel mutation once.
    fireEvent.click(cancelBtn);
    const dialog = await screen.findByText("Cancel this security review?");
    expect(dialog).toBeTruthy();
    const confirm = screen
      .getAllByRole("button", { name: "Cancel review" })
      .find((b) => b !== cancelBtn);
    expect(confirm).toBeTruthy();
    if (confirm) fireEvent.click(confirm);
    await vi.waitFor(() => expect(cancelReviewMock).toHaveBeenCalledWith("s-1"));
  });

  it("hides Cancel review on a completed engagement", async () => {
    getSecurityMock.mockResolvedValue({
      ...security,
      engagement: { ...security.engagement, status: "completed" },
    });
    renderPanel();
    // Wait for the panel to settle (the repo line renders once loaded).
    await screen.findByText("acme/site");
    expect(screen.queryByRole("button", { name: "Cancel review" })).toBeNull();
  });

  it("hides Cancel review for a non-admin on a team-owned engagement", async () => {
    getSessionMock.mockResolvedValue({
      ...session,
      owner: { type: "team", id: "team-1" },
    });
    teamsMock.mockReturnValue({
      data: { teams: [{ id: "team-1", callerRole: "member" }] },
      isLoading: false,
      error: null,
    });
    renderPanel();
    await screen.findByText("acme/site");
    expect(screen.queryByRole("button", { name: "Cancel review" })).toBeNull();
  });

  it("renders the token + cost chip in the panel header", async () => {
    renderPanel();
    const chip = await screen.findByTestId("engagement-cost");
    expect(chip.textContent).toContain("1.2M tokens");
    expect(chip.textContent).toContain("$0.42");
  });

  it("shows 'cost n/a' when the spend is unpriced", async () => {
    getSecurityMock.mockResolvedValue({
      ...security,
      cost: { costUsd: 0, totalTokens: 900_000, priced: false },
    });
    renderPanel();
    const chip = await screen.findByTestId("engagement-cost");
    expect(chip.textContent).toContain("900k tokens");
    expect(chip.textContent).toContain("cost n/a");
    expect(chip.textContent).not.toContain("$");
  });

  it("shows the review cost line in the manifest card once closed", async () => {
    getSecurityMock.mockResolvedValue({
      ...security,
      engagement: { ...security.engagement, status: "completed" },
      cost: { costUsd: 0.42, totalTokens: 1_200_000, priced: true },
    });
    renderPanel();
    const line = await screen.findByTestId("review-cost");
    expect(line.textContent).toContain("Review cost:");
    expect(line.textContent).toContain("1.2M tokens");
    expect(line.textContent).toContain("$0.42");
  });

  it("resizes the security panel via the keyboard and persists the width", async () => {
    window.localStorage.removeItem("valet:sec-panel-width");
    renderLayout();
    await screen.findByText("01-recon");

    const handle = screen.getByRole("separator", { name: "Resize security panel" });
    // The container carries the width as a CSS variable (a `md:` class applies
    // it only in the side-by-side layout). Default is 480px.
    const row = handle.parentElement as HTMLElement;
    expect(row.style.getPropertyValue("--sec-panel-w")).toBe("480px");

    // ArrowLeft widens the right panel by one step (480 → 504); persisted.
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(row.style.getPropertyValue("--sec-panel-w")).toBe("504px");
    expect(handle.getAttribute("aria-valuenow")).toBe("504");
    expect(window.localStorage.getItem("valet:sec-panel-width")).toBe("504");
  });

  it("clamps the panel width to its minimum", async () => {
    window.localStorage.setItem("valet:sec-panel-width", "330");
    renderLayout();
    await screen.findByText("01-recon");
    const handle = screen.getByRole("separator", { name: "Resize security panel" });
    const row = handle.parentElement as HTMLElement;
    expect(row.style.getPropertyValue("--sec-panel-w")).toBe("330px");
    // Two ArrowRight steps (−48) would reach 282, below the 320 floor.
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(row.style.getPropertyValue("--sec-panel-w")).toBe("320px");
  });
});
