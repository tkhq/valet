// @vitest-environment jsdom
/**
 * "+ new thread" affordance at the bottom of the thread tree (only rendered
 * on `/chat`, decision 12 sidebar). Verifies the click calls
 * `useCreateThread`'s mutation and navigates to the new thread — the tree's
 * other tests (`thread-tree.test.ts`) cover pure grouping/status logic;
 * this one needs a render since the behavior is a hook call + navigation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { TooltipProvider } from "~/components/primitives";

const navigate = vi.fn();
const archiveThread = vi.fn().mockResolvedValue(undefined);
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
    useSetThreadArchived: () => ({ mutateAsync: archiveThread, isPending: false }),
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
    localStorage.setItem(key, JSON.stringify({ projects: [{ id: "acme", name: "ACME", collapsed: true }], assignments: {}, pinned: [], grouped: true, collapsed: false }));
    render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    await userEvent.click(screen.getByRole("button", { name: "New thread in ACME" }));
    expect(createThreadMutateAsync).toHaveBeenCalledOnce();
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    expect(saved.assignments["thread-new"]).toBe("acme");
    expect(saved.projects[0].collapsed).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("does not navigate across a workspace switch during creation", async () => {
    const key = "valet:thread-projects:user-1:team-runtime";
    localStorage.setItem(key, JSON.stringify({ projects: [{ id: "acme", name: "ACME", collapsed: true }], assignments: {}, pinned: [], grouped: true, collapsed: false }));
    let finish: (thread: { id: string; title: null; createdAt: number }) => void = () => {};
    createThreadMutateAsync.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    await userEvent.click(screen.getByRole("button", { name: "New thread in ACME" }));
    view.rerender(<TooltipProvider><ThreadTree sessionId="another-runtime" /></TooltipProvider>);
    await act(async () => finish({ id: "thread-new", title: null, createdAt: 1 }));
    expect(navigate).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(key) ?? "null").assignments["thread-new"]).toBe("acme");
    expect(localStorage.getItem("valet:thread-projects:user-1:another-runtime")).toBeNull();
  });

  it("keeps the project unchanged and shows retry guidance if creation fails", async () => {
    const key = "valet:thread-projects:user-1:team-runtime";
    const original = JSON.stringify({ projects: [{ id: "acme", name: "ACME", collapsed: true }], assignments: {}, pinned: [], grouped: true, collapsed: false });
    localStorage.setItem(key, original);
    createThreadMutateAsync.mockRejectedValueOnce(new Error("offline"));
    render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    await userEvent.click(screen.getByRole("button", { name: "New thread in ACME" }));
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


describe("ThreadTree — delete project", () => {
  const key = "valet:thread-projects:user-1:team-runtime";
  function seed(assignments: Record<string, string> = { "thread-1": "acme", unloaded: "acme", unrelated: "other" }) {
    const value = { projects: [{ id: "acme", name: "ACME", collapsed: true }], assignments, pinned: ["unloaded", "unrelated"], grouped: true, collapsed: false };
    localStorage.setItem(key, JSON.stringify(value));
    return value;
  }
  async function openDelete(rightClick = false) {
    if (rightClick) fireEvent.contextMenu(screen.getByRole("button", { name: "ACME" }));
    else await userEvent.click(screen.getByRole("button", { name: "Project menu: ACME" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete project" }));
  }
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); archiveThread.mockReset().mockResolvedValue(undefined); });

  it("right-clicks a folder and archives all assignments including pinned unloaded chats", async () => {
    seed();
    render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    await openDelete(true);
    expect(archiveThread).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Project: ACME" })).toBeNull());
    expect(archiveThread.mock.calls).toEqual([[{ threadId: "thread-1", archived: true }], [{ threadId: "unloaded", archived: true }]]);
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    expect(saved.projects).toEqual([]);
    expect(saved.assignments).toEqual({ unrelated: "other" });
    expect(saved.pinned).toEqual(["unrelated"]);
  });

  it("retains the folder after partial failure and completes on retry", async () => {
    const original = seed();
    archiveThread.mockRejectedValueOnce(new Error("offline"));
    render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    await openDelete();
    await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Already archived chats stay archived");
    expect(archiveThread).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(original);
    await userEvent.click(screen.getByRole("button", { name: "Retry delete project" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Project: ACME" })).toBeNull());
  });

  it("deletes an empty folder using the keyboard-accessible menu", async () => {
    seed({});
    render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    screen.getByRole("button", { name: "Project menu: ACME" }).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete project" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
    expect(archiveThread).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(key) ?? "null").projects).toEqual([]);
  });

  it("finishes only the original workspace after switching during archive", async () => {
    seed({ unloaded: "acme" });
    const otherKey = "valet:thread-projects:user-1:another-runtime";
    const other = JSON.stringify({ projects: [{ id: "acme", name: "Other", collapsed: true }], assignments: { other: "acme" }, pinned: [], grouped: true, collapsed: false });
    localStorage.setItem(otherKey, other);
    let finish = () => {};
    archiveThread.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const view = render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    await openDelete();
    await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
    view.rerender(<TooltipProvider><ThreadTree sessionId="another-runtime" /></TooltipProvider>);
    await act(async () => finish());
    expect(localStorage.getItem(otherKey)).toBe(other);
    expect(JSON.parse(localStorage.getItem(key) ?? "null").projects).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retains the folder when a new assignment arrives during archive", async () => {
    const original = seed({ unloaded: "acme" });
    let finish = () => {};
    archiveThread.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    render(<TooltipProvider><ThreadTree sessionId="team-runtime" /></TooltipProvider>);
    await openDelete();
    await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
    localStorage.setItem(key, JSON.stringify({ ...original, assignments: { unloaded: "acme", added: "acme" } }));
    await act(async () => finish());
    expect((await screen.findByRole("alert")).textContent).toContain("assignments changed");
    expect(JSON.parse(localStorage.getItem(key) ?? "null").projects).toHaveLength(1);
  });
});
