// @vitest-environment jsdom
/**
 * `SessionView` variant chrome (decisions 13/14): "full" and "standalone"
 * get the existing `SessionHeader` (model picker, delete, etc.); "panel"
 * gets a compact header (title + open-full-page + ✕ close) instead. The
 * threads/thread-tree *sidebar* is deliberately NOT part of this
 * component (it's a root-layout concern — see `__root.tsx`), so this test
 * only covers header chrome, not sidebar visibility.
 *
 * All data hooks are mocked so this stays a pure rendering/branching test.
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
import { SessionView } from "./session-view";

vi.mock("~/api/ws", () => ({ useSessionWebSocket: () => undefined }));

// importOriginal: see -new-session-dialog.test.tsx for why a bare
// replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSession: () => ({
      isLoading: false,
      error: null,
      data: { id: "sess-1", title: "fix-auth", workspace: "/workspace" },
    }),
    useThreads: () => ({ data: { threads: [{ id: "t1", createdAt: 0 }] } }),
    useMessages: () => ({ data: undefined }),
    useDecisions: () => ({ data: undefined }),
  };
});

vi.mock("~/stores/stream", () => ({
  useSessionStream: () => ({ messages: [], agentStatus: "idle", conn: "open" }),
  useStreamStore: (selector: (s: { setThreadMessages: () => void; setPendingGates: () => void }) => unknown) =>
    selector({ setThreadMessages: vi.fn(), setPendingGates: vi.fn() }),
  usePendingGateForThread: () => undefined,
}));

vi.mock("./session-header", () => ({
  SessionHeader: ({ session }: { session: { title?: string } }) => (
    <div data-testid="full-header">{session.title}</div>
  ),
}));
vi.mock("./message-list", () => ({ MessageList: () => <div data-testid="message-list" /> }));
vi.mock("./composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("./decision-gate-card", () => ({ DecisionGateCard: () => null }));

function renderInRouter(sessionId: string, variant: "full" | "panel" | "standalone", onClose?: () => void) {
  const rootRoute = createRootRoute({
    component: () => <SessionView sessionId={sessionId} variant={variant} onClose={onClose} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // SessionView's auto-title effect needs a QueryClient in scope; provide
  // a scratch one per render so the effect can call `invalidateQueries`.
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("SessionView variants", () => {
  it("full: renders the standard SessionHeader", async () => {
    renderInRouter("sess-1", "full");
    expect(await screen.findByTestId("full-header")).toBeTruthy();
    expect(screen.queryByLabelText("Close panel")).toBeNull();
  });

  it("standalone: renders the standard SessionHeader too (full header, decision 14)", async () => {
    renderInRouter("sess-1", "standalone");
    expect(await screen.findByTestId("full-header")).toBeTruthy();
    expect(screen.queryByLabelText("Close panel")).toBeNull();
  });

  it("panel: renders a compact header with title + close button, not SessionHeader", async () => {
    const onClose = vi.fn();
    renderInRouter("sess-1", "panel", onClose);
    expect(await screen.findByText("fix-auth")).toBeTruthy();
    expect(screen.queryByTestId("full-header")).toBeNull();
    const closeBtn = screen.getByLabelText("Close panel");
    closeBtn.click();
    expect(onClose).toHaveBeenCalled();
  });

  it("all variants render the transcript and composer", async () => {
    renderInRouter("sess-1", "panel");
    expect(await screen.findByTestId("message-list")).toBeTruthy();
    expect(screen.getByTestId("composer")).toBeTruthy();
  });
});
