// @vitest-environment jsdom
/**
 * "+ new thread" affordance at the bottom of the thread tree (only rendered
 * on `/chat`, decision 12 sidebar). Verifies the click calls
 * `useCreateThread`'s mutation and navigates to the new thread — the tree's
 * other tests (`thread-tree.test.ts`) cover pure grouping/status logic;
 * this one needs a render since the behavior is a hook call + navigation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { TooltipProvider } from "~/components/primitives";

const navigate = vi.fn();
const createThreadMutateAsync = vi.fn().mockResolvedValue({
  id: "thread-new",
  title: null,
  createdAt: Date.now(),
});

const markThreadsReadMutate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useSearch: () => ({}),
  useNavigate: () => navigate,
}));

// importOriginal keeps the module's other exports real (see vitest.config.ts).
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useThreadSearch: () => ({ data: { threads: [] }, isFetching: false, isError: false }),
    useSidebarThreads: () => ({
      data: { threads: [{ id: "thread-1", title: null, createdAt: Date.now() }] },
      isLoading: false,
      error: null,
    }),
    useCreateThread: () => ({
      mutateAsync: createThreadMutateAsync,
      isPending: false,
    }),
    useArchivedThreads: () => ({ data: undefined, isLoading: false, error: null }),
    useSetThreadArchived: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useRenameThread: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useReplaceSandbox: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useMarkThreadsRead: () => ({ mutate: markThreadsReadMutate, isPending: false }),
    // Session default model for the pin chip.
    useSession: () => ({ data: undefined, isLoading: false, error: null }),
    // Keeps the gate seed (usePendingGatesSeed) off the real query client.
    useDecisions: () => ({ data: undefined, isLoading: false, error: null }),
  };
});

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useMe: () => ({ data: { id: "user-1" }, error: null }),
    useModels: () => ({ data: { models: [] }, isLoading: false, error: null }),
    useModelTiers: () => ({
      data: { xs: [], s: [], m: [], l: [], xl: [] },
      isLoading: false,
      error: null,
    }),
  };
});

const runtimeInfo = vi.fn((_workspace?: string) => ({ data: { sessionId: "orchestrator:user-1" } }));
vi.mock("~/api/workspace-runtime", () => ({
  useWorkspaceRuntimeInfo: (workspace: string | undefined) => runtimeInfo(workspace),

}));

vi.mock("~/stores/stream", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/stores/stream")>(),
  useThreadLiveStatus: () => ({ status: "idle" }),
  useQueueStateForThread: () => undefined,
  useStreamStore: () => undefined,
}));

import { ThreadTree } from "./thread-tree";

describe("ThreadTree — new thread affordance", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("creates a thread inside a collapsed project and expands it", async () => {
    const key = "valet:thread-projects:user-1:team-runtime";
    localStorage.setItem(key, JSON.stringify({ projects: [{ id: "xset", name: "XSET", collapsed: true }], assignments: {}, pinned: [], grouped: true, collapsed: false }));
    render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    await userEvent.click(screen.getByRole("button", { name: "New thread in XSET" }));
    expect(createThreadMutateAsync).toHaveBeenCalledOnce();
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    expect(saved.assignments["thread-new"]).toBe("xset");
    expect(saved.projects[0].collapsed).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("does not navigate across a workspace switch during creation", async () => {
    const key = "valet:thread-projects:user-1:team-runtime";
    localStorage.setItem(key, JSON.stringify({ projects: [{ id: "xset", name: "XSET", collapsed: true }], assignments: {}, pinned: [], grouped: true, collapsed: false }));
    let finish: (thread: { id: string; title: null; createdAt: number }) => void = () => {};
    createThreadMutateAsync.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    await userEvent.click(screen.getByRole("button", { name: "New thread in XSET" }));
    view.rerender(<TooltipProvider><ThreadTree sessionId="another-runtime" /></TooltipProvider>);
    await act(async () => finish({ id: "thread-new", title: null, createdAt: 1 }));
    expect(navigate).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(key) ?? "null").assignments["thread-new"]).toBe("xset");
    expect(localStorage.getItem("valet:thread-projects:user-1:another-runtime")).toBeNull();
  });

  it("keeps the project unchanged and shows retry guidance if creation fails", async () => {
    const key = "valet:thread-projects:user-1:team-runtime";
    const original = JSON.stringify({ projects: [{ id: "xset", name: "XSET", collapsed: true }], assignments: {}, pinned: [], grouped: true, collapsed: false });
    localStorage.setItem(key, original);
    createThreadMutateAsync.mockRejectedValueOnce(new Error("offline"));
    render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    await userEvent.click(screen.getByRole("button", { name: "New thread in XSET" }));
    expect(screen.getByRole("alert").textContent).toContain("Try again");
    expect(localStorage.getItem(key)).toBe(original);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("disables the personal runtime query when an explicit session is supplied", () => {
    render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    expect(runtimeInfo).toHaveBeenLastCalledWith(undefined);
  });
  it("creates a thread and navigates to it", async () => {
    render(
      <TooltipProvider>
        <ThreadTree />
      </TooltipProvider>,
    );

    // Exact name, not a regex: an untitled newest thread is itself labelled
    // "New thread", so its row menu ("Thread menu: New thread") also matches
    // a loose /new thread/i.
    const button = screen.getByRole("button", { name: "New thread" });
    await userEvent.click(button);

    expect(createThreadMutateAsync).toHaveBeenCalledWith();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.any(Function) }),
    );
    const call = navigate.mock.calls[0][0] as { search: (prev: Record<string, unknown>) => Record<string, unknown> };
    expect(call.search({ thread: "thread-1", child: "child-1" })).toEqual({
      thread: "thread-new",
      child: undefined,
    });
  });
});

vi.mock("~/api/child-work", async (importOriginal) => {
 const actual = await importOriginal<typeof import("~/api/child-work")>();
 return { ...actual,
  useChildWork: () => ({ data: { pages: [{ children: [], runningCount: 0, nextCursor: null }] }, refetch: vi.fn() }),
  useDismissChild: () => ({ mutateAsync: vi.fn(), isPending: false }),
 };
});
