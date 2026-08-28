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

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSession: (id: string) => getSessionMock(id),
      getSessionSecurity: (id: string) => getSecurityMock(id),
      listSecurityFindings: () => listFindingsMock(),
    },
  };
});

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useMe: () => ({ data: { id: "u-1", orgRole: "member" }, isLoading: false, error: null }),
    useTeams: () => ({ data: { teams: [] }, isLoading: false, error: null }),
  };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { SecuritySessionLayout } from "./engagement-panel";

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
  useStreamStore.getState().remove("s-1");
});

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
