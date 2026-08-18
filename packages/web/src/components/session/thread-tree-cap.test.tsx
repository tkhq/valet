// @vitest-environment jsdom
/**
 * What the thread sidebar says when the server cap is engaged (V1 port #13).
 *
 * The cap is a ceiling on an unbounded render, and it is correct. What it
 * changes is the meaning of every other control in the sidebar: search and
 * the origin chips run over the LOADED page, not over the session. So a
 * query that matches only an older thread returns "no match" for a thread
 * that exists. These tests pin the copy that connects the two, because the
 * failure mode is not a crash — it is a confident wrong answer.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { TooltipProvider } from "~/components/primitives";
import type { ThreadSummary } from "@valet/api/wire";

let threads: ThreadSummary[] = [];
let total = 0;
let archivedThreads: ThreadSummary[] = [];
let archivedTotal = 0;

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));

vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useThreads: () => ({ data: { threads, total }, isLoading: false, error: null, isFetching: false }),
    useArchivedThreads: (_id: string, opts?: { enabled?: boolean }) => ({
      data: opts?.enabled === false ? undefined : { threads: archivedThreads, total: archivedTotal },
      isLoading: false,
      error: null,
      isFetching: false,
    }),
    useCreateThread: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useSetThreadArchived: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useReplaceSandbox: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({ data: { sessionId: "orchestrator:user-1" } }),
  useOrchestratorChildren: () => ({ data: { children: [] }, refetch: vi.fn() }),
  useDismissChild: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("~/stores/stream", () => ({
  useStreamStore: () => undefined,
}));

import { ThreadTree } from "./thread-tree";

function thread(id: string, title: string): ThreadSummary {
  return { id, sessionId: "orchestrator:user-1", title, createdAt: Date.now() };
}

function renderTree() {
  return render(
    <TooltipProvider>
      <ThreadTree sessionId="orchestrator:user-1" />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  threads = [thread("t-1", "Plan the launch"), thread("t-2", "Fix the parser")];
  total = 2;
  archivedThreads = [];
  archivedTotal = 0;
});

describe("ThreadTree — search over a capped list", () => {
  it("says the search covered only the loaded threads when the cap is engaged", async () => {
    // 2 loaded of 340: the workflow-generator case the cap was written for.
    total = 340;
    renderTree();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Search threads"), "nothinghere");

    // The claim must be scoped. "No threads match" alone is false when 338
    // threads were never searched.
    expect(screen.getByText(/in the 2 threads loaded so far/i)).toBeTruthy();
    expect(screen.getByText(/Load the rest to search them/i)).toBeTruthy();
  });

  it("makes the button the way to widen the search, not an unrelated row", async () => {
    total = 340;
    renderTree();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Search threads"), "nothinghere");

    // While a search is active the row below must read as the continuation
    // of that search, not as an unrelated "Show more".
    expect(screen.getByRole("button", { name: /Search 100 more of 340 threads/i })).toBeTruthy();
  });

  it("says nothing about loading when the whole list is present", async () => {
    renderTree();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Search threads"), "nothinghere");

    expect(screen.queryByText(/loaded so far/i)).toBeNull();
    expect(screen.getByText(/No threads match/i)).toBeTruthy();
  });

  it("labels the row Show, not Search, when no filter is active", () => {
    total = 340;
    renderTree();
    expect(screen.getByRole("button", { name: /Show 100 more of 340 threads/i })).toBeTruthy();
  });
});

describe("ThreadTree — archived list", () => {
  it("offers a way past the archived cap instead of truncating in silence", async () => {
    archivedThreads = [thread("a-1", "Old thread")];
    archivedTotal = 150;
    renderTree();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Show archived/i }));

    // Before this, the archived list took the server's default cap of 100,
    // ignored `total`, and had no control to reach the rest.
    expect(screen.getByRole("button", { name: /Show 100 more of 150 archived threads/i })).toBeTruthy();
  });

  it("shows no archived control when the list is whole", async () => {
    archivedThreads = [thread("a-1", "Old thread")];
    archivedTotal = 1;
    renderTree();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Show archived/i }));

    expect(screen.queryByRole("button", { name: /archived threads$/i })).toBeNull();
  });
});
