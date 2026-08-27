// @vitest-environment jsdom
/**
 * Per-thread needs-you dot (TKAI-258): a gate pending on thread A must be
 * visible while the user looks at thread B. The gate card and the header
 * badge are scoped to the active thread, so the tree row is the only
 * in-session surface for it. The set-building logic is pure and lives in
 * `thread-tree.test.ts`; this file checks the store → row wiring.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "~/components/primitives";
import type { DecisionGate, ThreadSummary } from "@valet/api/wire";

const SESSION_ID = "orchestrator:user-1";

let threads: ThreadSummary[] = [];
let pendingGates: Record<string, DecisionGate> = {};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));

// importOriginal: see -new-session-dialog.test.tsx for why a bare
// replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useThreads: () => ({ data: { threads }, isLoading: false, error: null }),
    useArchivedThreads: () => ({ data: undefined, isLoading: false, error: null }),
    useCreateThread: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useSetThreadArchived: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useReplaceSandbox: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({ data: { sessionId: SESSION_ID } }),
  useOrchestratorChildren: () => ({ data: { children: [] }, refetch: vi.fn() }),
  useDismissChild: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Applies the real selectors against a minimal store shape — the component
// reads `pendingGates` (the dot) and `queueByThread` (children live-update).
vi.mock("~/stores/stream", () => {
  interface FakeSlice {
    pendingGates: Record<string, DecisionGate>;
    queueByThread: Record<string, never>;
  }
  interface FakeState {
    bySession: Record<string, FakeSlice>;
  }
  return {
    useStreamStore: (sel: (s: FakeState) => unknown) =>
      sel({ bySession: { [SESSION_ID]: { pendingGates, queueByThread: {} } } }),
  };
});

import { ThreadTree } from "./thread-tree";

function thread(id: string, title: string, createdAt: number): ThreadSummary {
  return { id, sessionId: SESSION_ID, title, createdAt };
}

function gate(id: string, threadId: string): DecisionGate {
  return {
    id,
    sessionId: SESSION_ID,
    threadId,
    type: "approval",
    title: "Approve the deploy",
    actions: [{ id: "approve", label: "Approve" }],
    status: "pending",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function renderTree() {
  return render(
    <TooltipProvider>
      <ThreadTree />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  // thread-new is newest, so it is the active thread (no search param).
  threads = [thread("thread-new", "Active thread", 2_000), thread("thread-old", "Gated thread", 1_000)];
  pendingGates = {};
});

describe("ThreadTree — pending-gate dot", () => {
  it("marks a NON-active thread that holds a pending gate", () => {
    pendingGates = { g1: gate("g1", "thread-old") };
    renderTree();

    const dot = screen.getByLabelText("Needs your decision");
    expect(dot.closest("a")?.textContent).toContain("Gated thread");
  });

  it("shows no dot when no gate is pending", () => {
    renderTree();
    expect(screen.queryByLabelText("Needs your decision")).toBeNull();
  });

  it("marks each gated thread, and only those", () => {
    threads = [
      thread("thread-new", "Active thread", 3_000),
      thread("thread-b", "Gated B", 2_000),
      thread("thread-c", "Quiet C", 1_000),
    ];
    pendingGates = { g1: gate("g1", "thread-new"), g2: gate("g2", "thread-b") };
    renderTree();

    const dots = screen.getAllByLabelText("Needs your decision");
    const marked = dots.map((d) => d.closest("a")?.textContent ?? "");
    expect(marked.some((t) => t.includes("Active thread"))).toBe(true);
    expect(marked.some((t) => t.includes("Gated B"))).toBe(true);
    expect(marked.some((t) => t.includes("Quiet C"))).toBe(false);
    expect(dots).toHaveLength(2);
  });
});
