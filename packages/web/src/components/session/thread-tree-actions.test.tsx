// @vitest-environment jsdom
/**
 * Thread tree actions (orchestrator UX redesign): the per-thread context
 * menu (archive + session-wide replace sandbox), the "Show archived"
 * toggle with unarchive, and the dismiss affordance on settled children.
 * The tree's pure grouping/status logic lives in `thread-tree.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { TooltipProvider } from "~/components/primitives";
import type { OrchestratorChildSummary, ThreadSummary } from "@valet/api/wire";

const navigate = vi.fn();
const setArchivedMutateAsync = vi.fn().mockResolvedValue({ id: "thread-1" });
const replaceMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const dismissMutateAsync = vi.fn().mockResolvedValue({ ok: true });

let threads: ThreadSummary[] = [];
let archivedThreads: ThreadSummary[] = [];
let children: OrchestratorChildSummary[] = [];

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useSearch: () => ({}),
  useNavigate: () => navigate,
}));

// importOriginal: see -new-session-dialog.test.tsx for why a bare
// replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useThreads: () => ({ data: { threads }, isLoading: false, error: null }),
    useArchivedThreads: (_id: string, opts?: { enabled?: boolean }) => ({
      data: opts?.enabled === false ? undefined : { threads: archivedThreads },
      isLoading: false,
      error: null,
    }),
    useCreateThread: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useSetThreadArchived: () => ({ mutateAsync: setArchivedMutateAsync, isPending: false }),
    useReplaceSandbox: () => ({ mutateAsync: replaceMutateAsync, isPending: false }),
  };
});

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({ data: { sessionId: "orchestrator:user-1" } }),
  useOrchestratorChildren: () => ({ data: { children }, refetch: vi.fn() }),
  useDismissChild: () => ({ mutateAsync: dismissMutateAsync, isPending: false }),
}));

vi.mock("~/stores/stream", () => ({
  useStreamStore: () => undefined,
}));

import { ThreadTree } from "./thread-tree";

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    sessionId: "orchestrator:user-1",
    title: "Plan the launch",
    createdAt: Date.now(),
    ...overrides,
  };
}

function child(overrides: Partial<OrchestratorChildSummary> = {}): OrchestratorChildSummary {
  return {
    sessionId: "child-1",
    title: "fix-auth",
    parentThreadId: "thread-1",
    status: "running",
    createdAt: Date.now(),
    ...overrides,
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
  navigate.mockClear();
  setArchivedMutateAsync.mockClear();
  replaceMutateAsync.mockClear();
  dismissMutateAsync.mockClear();
  threads = [thread()];
  archivedThreads = [];
  children = [];
});

describe("ThreadTree — thread context menu", () => {
  it("archives a thread from its context menu", async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /archive thread/i }));

    expect(setArchivedMutateAsync).toHaveBeenCalledWith({ threadId: "thread-1", archived: true });
  });

  it("archiving the ACTIVE thread navigates back to the default thread", async () => {
    // No `thread` search param → the newest thread (thread-1) is active.
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /archive thread/i }));

    expect(navigate).toHaveBeenCalledTimes(1);
    const call = navigate.mock.calls[0]?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.search({ thread: "thread-1", child: "c" })).toEqual({
      thread: undefined,
      child: undefined,
    });
  });

  it("archiving a NON-active thread does not navigate", async () => {
    threads = [
      thread({ id: "thread-newest", title: "Newest", createdAt: Date.now() }),
      thread({ id: "thread-1", title: "Plan the launch", createdAt: Date.now() - 1000 }),
    ];
    const user = userEvent.setup();
    renderTree();

    // thread-newest is active (newest, no search param); archive thread-1.
    await user.click(screen.getByRole("button", { name: /thread menu: plan the launch/i }));
    await user.click(screen.getByRole("menuitem", { name: /archive thread/i }));

    expect(setArchivedMutateAsync).toHaveBeenCalledWith({ threadId: "thread-1", archived: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("offers a session-wide Replace sandbox action", async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /replace sandbox/i }));

    expect(replaceMutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("ThreadTree — archived section", () => {
  it("shows archived threads behind a toggle, with unarchive", async () => {
    archivedThreads = [thread({ id: "thread-old", title: "Old research" })];
    const user = userEvent.setup();
    renderTree();

    // Hidden until toggled.
    expect(screen.queryByText("Old research")).toBeNull();

    await user.click(screen.getByRole("button", { name: /show archived/i }));
    expect(screen.getByText("Old research")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /unarchive/i }));
    expect(setArchivedMutateAsync).toHaveBeenCalledWith({
      threadId: "thread-old",
      archived: false,
    });
  });
});

describe("ThreadTree — settled children", () => {
  it("settled children get a dismiss affordance; running ones do not", async () => {
    children = [
      child({ sessionId: "child-done", title: "done-child", status: "settled" }),
      child({ sessionId: "child-live", title: "live-child", status: "running" }),
    ];
    const user = userEvent.setup();
    renderTree();

    const dismissButtons = screen.getAllByRole("button", { name: /dismiss/i });
    expect(dismissButtons).toHaveLength(1);

    await user.click(dismissButtons[0]!);
    expect(dismissMutateAsync).toHaveBeenCalledWith("child-done");
  });

  it("renders settled children muted (opacity treatment) vs running", () => {
    children = [
      child({ sessionId: "child-done", title: "done-child", status: "settled" }),
      child({ sessionId: "child-live", title: "live-child", status: "running" }),
    ];
    renderTree();

    const settledLink = screen.getByText("done-child").closest("a");
    const runningLink = screen.getByText("live-child").closest("a");
    expect(settledLink?.className ?? "").toMatch(/opacity/);
    expect(runningLink?.className ?? "").not.toMatch(/opacity/);
  });
});
