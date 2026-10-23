// @vitest-environment jsdom
/**
 * Thread tree actions (orchestrator UX redesign): the per-thread context
 * menu (archive + session-wide replace sandbox), the "Show archived"
 * toggle with unarchive, the dismiss affordance on settled children, and
 * the per-thread response-required bell (TKAI-258). The pure helpers behind
 * these live in `thread-tree.tsx` and are tested in `thread-tree.test.ts`;
 * this file checks the DOM wiring.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, within, fireEvent, act } from "@testing-library/react";
import { renderWithThreadProjects as render } from "~/test/thread-projects-client";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { TooltipProvider } from "~/components/primitives";
import { ApiError } from "~/api/client";
import type {
  ArtifactListItem,
  BackgroundWorkConflict,
  DecisionGate,
  GetModelTiersResponse,
  ModelInfo,
  ChildWorkSummary,
  ListSessionWakeupsResponse,
  ThreadSummary,
  WorkflowDefinitionSummary,
} from "@valet/api/wire";

const navigate = vi.fn();
const setArchivedMutateAsync = vi.fn().mockResolvedValue({ id: "thread-1" });
const replaceMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const dismissMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const renameMutateAsync = vi.fn().mockResolvedValue({ id: "thread-1" });

let threads: ThreadSummary[] = [];
let searchMatches: ThreadSummary[] = [];
let archivedThreads: ThreadSummary[] = [];
let children: ChildWorkSummary[] = [];
let hasNextPage = false;
const fetchNextPage = vi.fn();
let hasMoreThreads = false;
let threadPageError = false;
let fixedReady = true;
const fetchMoreThreads = vi.fn();
let pendingGates: Record<string, DecisionGate> = {};
let sessionModel: string | undefined;
let models: ModelInfo[] = [];
let tierMap: GetModelTiersResponse = { xs: [], s: [], m: [], l: [], xl: [] };
let wakeups: ListSessionWakeupsResponse | undefined;
// The phone drawer and the web sidebar share this component. Most tests
// cover the web sidebar; a phone test sets `mobile`.
let mobile = false;
vi.mock("~/hooks/use-mobile-layout", () => ({ useMobileLayout: () => mobile }));
let workflows: WorkflowDefinitionSummary[] = [];
let artifacts: ArtifactListItem[] = [];
/** The `enabled` option of each workflow and artifact list read, in render order. */
const listReads: Array<{ list: "workflows" | "artifacts"; enabled: boolean | undefined; ownerId: string | undefined }> = [];

// The search dialog lists the workspace's workflows and files.
function listResult<T>(data: T, enabled: boolean | undefined) {
  const on = enabled !== false;
  return { data: on ? data : undefined, isPending: !on, isError: false, isSuccess: on, refetch: vi.fn() };
}
vi.mock("~/api/workflows", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/workflows")>(),
  useWorkflows: (owner?: { ownerId: string }, opts?: { enabled?: boolean }) => {
    listReads.push({ list: "workflows", enabled: opts?.enabled, ownerId: owner?.ownerId });
    return listResult({ workflows }, opts?.enabled);
  },
}));
vi.mock("~/api/artifacts", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/artifacts")>(),
  useArtifacts: (owner?: { ownerId: string }, opts?: { enabled?: boolean }) => {
    listReads.push({ list: "artifacts", enabled: opts?.enabled, ownerId: owner?.ownerId });
    return listResult({ artifacts }, opts?.enabled);
  },
}));

const markThreadsReadMutate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useSearch: () => ({}),
  useNavigate: () => navigate,
  // The thread list renders on /chat here, where a row can be the open thread.
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) => select({ location: { pathname: "/chat" } }),
}));

// importOriginal keeps the module's other exports real (see vitest.config.ts).
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useThreadSearch: () => ({ data: { threads: searchMatches }, isFetching: false, isError: false }),
    useSidebarThreads: () => ({ data: { threads }, fixedReady, isLoading: false, error: threadPageError ? new Error("network") : null,
      hasNextPage: hasMoreThreads, fetchNextPage: fetchMoreThreads, isFetchNextPageError: threadPageError, isError: threadPageError, isFetching: false }),
    useSession: () => ({
      data: sessionModel ? { model: sessionModel } : undefined,
      isLoading: false,
      error: null,
    }),
    useArchivedThreads: (_id: string, opts?: { enabled?: boolean }) => ({
      data: opts?.enabled === false ? undefined : { threads: archivedThreads },
      isLoading: false,
      error: null,
    }),
    useCreateThread: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useSetThreadArchived: () => ({ mutateAsync: setArchivedMutateAsync, isPending: false }),
    useRenameThread: () => ({ mutateAsync: renameMutateAsync, isPending: false }),
    useReplaceSandbox: () => ({ mutateAsync: replaceMutateAsync, isPending: false }),
    useMarkThreadsRead: () => ({ mutate: markThreadsReadMutate, isPending: false }),
    // The gate seed (usePendingGatesSeed) stays inert: with no data the
    // effect never touches the store. Gates enter through `pendingGates`.
    useDecisions: () => ({ data: undefined, isLoading: false, error: null }),
    useSessionWakeups: () => ({ data: wakeups }),
  };
});

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useMe: () => ({ data: { id: "user-1" }, error: null }),
    useModels: () => ({ data: { models }, isLoading: false, error: null }),
    useModelTiers: () => ({ data: tierMap, isLoading: false, error: null }),
  };
});

vi.mock("~/api/workspace-runtime", () => ({
  useWorkspaceRuntimeInfo: () => ({ data: { sessionId: "orchestrator:user-1" } }),

}));

// Applies the component's real selectors against a minimal store shape:
// `pendingGates` drives the response-required bell, `queueByThread` the children
// live-update hook, and the absent `setPendingGates` is never called
// because the mocked useDecisions returns no data.
vi.mock("~/stores/stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/stores/stream")>();
  interface FakeStreamState {
    bySession: Record<
      string,
      { pendingGates: Record<string, DecisionGate>; queueByThread: Record<string, never> }
    >;
    setPendingGates?: (sessionId: string, gates: DecisionGate[]) => void;
  }
  return {
    ...actual,
    useThreadLiveStatus: () => ({ status: "idle" }),
    useQueueStateForThread: () => undefined,
    useStreamStore: (sel: (s: FakeStreamState) => unknown) =>
      sel({ bySession: { "orchestrator:user-1": { pendingGates, queueByThread: {} } } }),
  };
});

import { ThreadTree } from "./thread-tree";

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    sessionId: "orchestrator:user-1",
    title: "Plan the launch",
    createdAt: Date.now(),
    lastUserActivityAt: Date.now(),
    ...overrides,
  };
}

function child(overrides: Partial<ChildWorkSummary> = {}): ChildWorkSummary {
  return {
    sessionId: "child-1",
    title: "fix-auth",
    parentThreadId: "thread-1",
    status: "running",
    createdAt: Date.now(),
    ...overrides,
  };
}

function gate(id: string, threadId: string): DecisionGate {
  return {
    id,
    sessionId: "orchestrator:user-1",
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
  window.localStorage.clear();
  navigate.mockClear();
  setArchivedMutateAsync.mockClear();
  replaceMutateAsync.mockClear();
  dismissMutateAsync.mockClear();
  renameMutateAsync.mockClear();
  threads = [thread()];
  archivedThreads = [];
  searchMatches = [];
  children = [];
  hasNextPage = false;
  hasMoreThreads = false;
  threadPageError = false;
  fixedReady = true;
  fetchMoreThreads.mockClear();
  pendingGates = {};
  sessionModel = undefined;
  models = [];
  tierMap = { xs: [], s: [], m: [], l: [], xl: [] };
  wakeups = undefined;
  workflows = [];
  artifacts = [];
  listReads.length = 0;
  mobile = false;
});

describe("ThreadTree progressive loading", () => {
  it("keeps loaded rows and offers explicit load and retry actions", async () => {
    hasMoreThreads = true;
    const rendered = renderTree();
    await userEvent.click(screen.getByRole("button", { name: "Load more threads" }));
    expect(fetchMoreThreads).toHaveBeenCalledTimes(1);
    threadPageError = true;
    rendered.rerender(<TooltipProvider><ThreadTree /></TooltipProvider>);
    expect(screen.getByText("Plan the launch")).toBeTruthy();
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    expect(fetchMoreThreads).toHaveBeenCalledTimes(2);
  });

  it("requests one next page when the scroll sentinel intersects", () => {
    hasMoreThreads = true;
    const observe = vi.fn();
    const disconnect = vi.fn();
    let intersect: (() => void) | undefined;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = () => callback([{
          isIntersecting: true, intersectionRatio: 1, time: 0, target: document.body,
          boundingClientRect: new DOMRect(), intersectionRect: new DOMRect(), rootBounds: null,
        }], this);
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = () => [];
      root = null;
      rootMargin = "0px";
      thresholds = [0];
    });
    try {
      const rendered = renderTree();
      expect(observe).toHaveBeenCalledWith(screen.getByRole("button", { name: "Load more threads" }));
      act(() => { intersect?.(); intersect?.(); });
      expect(fetchMoreThreads).toHaveBeenCalledTimes(1);
      rendered.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("ThreadTree — title-first sidebar", () => {
  it("keeps model names and size badges out of the thread row", () => {
    sessionModel = "s";
    models = [
      {
        id: "anthropic/claude-sonnet-5",
        name: "Claude Sonnet 5",
        providerId: "anthropic",
        providerKind: "anthropic",
        providerName: "Anthropic",
        active: true,
        approved: true,
      },
    ];
    tierMap = { xs: [], s: [], m: [], l: ["anthropic/claude-sonnet-5"], xl: [] };
    threads = [thread({ model: "l", title: "Investigate onboarding workflow" })];

    renderTree();

    expect(screen.getByText("Investigate onboarding workflow")).toBeTruthy();
    expect(screen.queryByText("Claude Sonnet 5")).toBeNull();
    expect(screen.queryByText("Large")).toBeNull();
    expect(screen.queryByText("l")).toBeNull();
  });
});

describe("ThreadTree — thread context menu", () => {
  it("archives a thread from its context menu", async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /archive thread/i }));

    expect(setArchivedMutateAsync).toHaveBeenCalledWith({ threadId: "thread-1", archived: true });
  });

  it("archives from the menu with the A shortcut", async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.keyboard("a");

    expect(setArchivedMutateAsync).toHaveBeenCalledWith({ threadId: "thread-1", archived: true });
  });

  it("leaves Select All alone while the menu is open", async () => {
    // The accelerator is a bare `A`. Without a modifier guard, Select All
    // pressed over an open menu archives the thread instead.
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.keyboard("{Control>}a{/Control}");

    expect(setArchivedMutateAsync).not.toHaveBeenCalled();
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

  it("pins from the context menu, the only row control on a phone", async () => {
    const user = userEvent.setup();
    renderTree();

    expect(screen.getByRole("button", { name: "Pin thread" }).className).toContain("max-md:hidden");
    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.click(screen.getByRole("menuitem", { name: "Pin thread" }));
    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    expect(await screen.findByRole("menuitem", { name: "Unpin thread" })).toBeTruthy();
  });

  it("offers a session-wide Replace sandbox action", async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /replace sandbox/i }));

    expect(replaceMutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("ThreadTree: background work blocks archive and replace (fix wave 3, H1, H3)", () => {
  const conflict: BackgroundWorkConflict = {
    error: 'This thread has background work running: "full proof build" (process).',
    code: "background_work",
    work: [{ id: "wk_1", kind: "process", status: "running", reason: "full proof build", threadId: "thread-1", createdAt: Date.now() }],
    hiddenCount: 0,
    forceAllowed: true,
  };

  it("archive asks first, names the work, and archives with force on confirm", async () => {
    setArchivedMutateAsync.mockRejectedValueOnce(new ApiError(409, "PATCH → 409", conflict));
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /archive thread/i }));

    const dialog = await screen.findByRole("dialog", { name: "Stop background work and archive?" });
    expect(within(dialog).getByText("full proof build")).toBeTruthy();
    // Nothing left the list yet, so the view stays on the thread.
    expect(navigate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Stop background work and archive" }));
    expect(setArchivedMutateAsync).toHaveBeenLastCalledWith({ threadId: "thread-1", archived: true, force: true });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("the A hotkey path asks the same way", async () => {
    setArchivedMutateAsync.mockRejectedValueOnce(new ApiError(409, "PATCH → 409", conflict));
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.keyboard("a");

    expect(await screen.findByRole("dialog", { name: "Stop background work and archive?" })).toBeTruthy();
  });

  it("Replace sandbox asks first under background work, then resends with force", async () => {
    replaceMutateAsync.mockRejectedValueOnce(new ApiError(409, "POST → 409", conflict));
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /replace sandbox/i }));

    const dialog = await screen.findByRole("dialog", { name: "Stop background work and replace the sandbox?" });
    await user.click(within(dialog).getByRole("button", { name: "Stop background work and replace" }));
    expect(replaceMutateAsync).toHaveBeenLastCalledWith({ force: true });
  });

  it("Replace sandbox shows a failure instead of dropping it", async () => {
    replaceMutateAsync.mockRejectedValueOnce(new ApiError(502, "POST → 502", { error: "sandbox replacement failed to provision. Check the sandbox backend, then retry." }));
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /replace sandbox/i }));

    expect(await screen.findByText(/sandbox replacement failed to provision/)).toBeTruthy();
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

describe("ThreadTree — collapsible subconversations", () => {
  it("toggles a parent's children and persists the state", async () => {
    children = [child({ title: "child one" })];
    const user = userEvent.setup();
    const view = renderTree();

    const collapse = screen.getByRole("button", { name: /collapse subconversations/i });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    await user.click(collapse);

    expect(screen.queryByText("child one")).toBeNull();
    expect(window.localStorage.getItem("valet:subconversations-collapsed:thread-1")).toBe("1");

    view.unmount();
    renderTree();
    expect(screen.queryByText("child one")).toBeNull();

    await user.click(screen.getByRole("button", { name: /expand subconversations/i }));
    expect(screen.getByText("child one")).toBeTruthy();
    expect(window.localStorage.getItem("valet:subconversations-collapsed:thread-1")).toBe("0");
  });

  it("starts collapsed on a phone, and keeps a group the person opened", async () => {
    mobile = true;
    children = [child({ title: "child one" })];
    const user = userEvent.setup();
    const view = renderTree();

    const expand = screen.getByRole("button", { name: /expand subconversations/i });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("child one")).toBeNull();
    await user.click(expand);
    expect(window.localStorage.getItem("valet:subconversations-collapsed:thread-1")).toBe("0");

    view.unmount();
    renderTree();
    expect(screen.getByText("child one")).toBeTruthy();
  });

  it("keeps each parent's state independent", async () => {
    threads = [
      thread({ id: "thread-1", title: "First", createdAt: 2 }),
      thread({ id: "thread-2", title: "Second", createdAt: 1 }),
    ];
    children = [
      child({ sessionId: "child-1", parentThreadId: "thread-1", title: "first child" }),
      child({ sessionId: "child-2", parentThreadId: "thread-2", title: "second child" }),
    ];
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: /collapse subconversations for first/i }));

    expect(screen.queryByText("first child")).toBeNull();
    expect(screen.getByText("second child")).toBeTruthy();
    expect(window.localStorage.getItem("valet:subconversations-collapsed:thread-1")).toBe("1");
    expect(window.localStorage.getItem("valet:subconversations-collapsed:thread-2")).toBeNull();
  });
});

describe("ThreadTree — settled children", () => {
  it("shows the settled mark, Dismiss on hover, and neither on a phone", () => {
    children = [child({ sessionId: "child-done", title: "done-child", status: "settled" })];
    renderTree();

    const settled = screen.getByRole("img", { name: "settled" }).className;
    expect(settled).toContain("max-md:hidden");
    expect(settled).not.toContain("opacity-0");
    const dismiss = screen.getByRole("button", { name: "Dismiss done-child" }).className;
    expect(dismiss).toContain("max-md:hidden");
    expect(dismiss).toContain("opacity-0");
    expect(dismiss).toContain("group-hover/child:opacity-100");
  });

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

/**
 * Per-thread response-required bell (TKAI-258): a gate pending on thread A
 * must be visible while the user looks at thread B. The gate card and the
 * header badge are scoped to the active thread, so the tree row is the only
 * in-session surface for it — including when a filter, a search query, or
 * the archive would otherwise hide the row.
 */
describe("ThreadTree — response-required bell", () => {
  it("marks a NON-active thread that holds a pending gate", () => {
    threads = [
      thread({ id: "thread-new", title: "Active thread", createdAt: 2_000 }),
      thread({ id: "thread-old", title: "Gated thread", createdAt: 1_000 }),
    ];
    pendingGates = { g1: gate("g1", "thread-old") };
    renderTree();

    const bell = screen.getByLabelText("Needs approval");
    expect(bell.closest("a")?.textContent).toContain("Gated thread");
    expect(bell.getAttribute("role")).toBe("img");
  });

  it("shows no bell when no gate is pending", () => {
    renderTree();
    expect(screen.queryByLabelText("Needs approval")).toBeNull();
  });

  it("marks each gated thread, and only those", () => {
    threads = [
      thread({ id: "thread-a", title: "Active thread", createdAt: 3_000 }),
      thread({ id: "thread-b", title: "Gated B", createdAt: 2_000 }),
      thread({ id: "thread-c", title: "Quiet C", createdAt: 1_000 }),
    ];
    pendingGates = { g1: gate("g1", "thread-a"), g2: gate("g2", "thread-b") };
    renderTree();

    const bells = screen.getAllByLabelText("Needs approval");
    const marked = bells.map((bell) => bell.closest("a")?.textContent ?? "");
    expect(marked.some((t) => t.includes("Active thread"))).toBe(true);
    expect(marked.some((t) => t.includes("Gated B"))).toBe(true);
    expect(marked.some((t) => t.includes("Quiet C"))).toBe(false);
    expect(bells).toHaveLength(2);
  });

  it("keeps approval state in the sidebar when dialog search filters other threads", async () => {
    threads = [
      thread({ id: "thread-new", title: "Newest", createdAt: 3_000 }),
      thread({ id: "thread-gated", title: "Plan the launch", createdAt: 2_000 }),
      thread({ id: "thread-quiet", title: "Old notes", createdAt: 1_000 }),
    ];
    pendingGates = { g1: gate("g1", "thread-gated") };
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByRole("button", { name: "Search threads" }));
    await user.type(screen.getByRole("combobox", { name: "Search threads" }), "Newest");
    const results = within(screen.getByRole("listbox"));
    expect(results.getByText("Newest")).toBeTruthy();
    expect(results.queryByText("Plan the launch")).toBeNull();
    expect(results.queryByText("Old notes")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("Needs approval").closest("a")?.textContent).toContain("Plan the launch");

  });

  it("does not put an active filtered Slack approval on archived history", () => {
    window.localStorage.setItem("valet:thread-origin", "chat");
    threads.push(thread({ id: "slack-active", key: "slack:C1:1", title: "Slack gated" }));
    pendingGates = { g1: gate("g1", "slack-active") };
    renderTree();
    expect(screen.queryByText("Slack gated")).toBeNull();
    expect(screen.queryByLabelText("Response required")).toBeNull();
  });

  it("does not label missing supplemental rows as archived while they load", () => {
    fixedReady = false;
    pendingGates = { g1: gate("g1", "not-loaded") };
    renderTree();
    expect(screen.queryByLabelText("Response required")).toBeNull();
    fixedReady = true;
  });

  it("surfaces a gate on an archived thread: toggle bell, then row bell", async () => {
    archivedThreads = [thread({ id: "thread-old", title: "Old gated" })];
    pendingGates = { g1: gate("g1", "thread-old") };
    const user = userEvent.setup();
    renderTree();

    // Closed section: the toggle itself carries the surface.
    expect(screen.getByLabelText("Response required")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /show archived/i }));
    const row = screen.getByText("Old gated").closest("li");
    expect(row?.querySelector('[aria-label="Response required"]')).toBeTruthy();
  });
});

describe("ThreadTree — thread rename", () => {
  async function openRename(): Promise<HTMLInputElement> {
    const label = screen.getByText("Plan the launch");
    await userEvent.dblClick(label);
    return screen.findByRole<HTMLInputElement>("textbox", { name: /rename thread/i });
  }

  it("keeps the browser default for the rename double-click", async () => {
    renderTree();
    const label = screen.getByText("Plan the launch");
    const event = new MouseEvent("dblclick", { bubbles: true, cancelable: true });

    expect(label.dispatchEvent(event)).toBe(true);
    expect(await screen.findByRole("textbox", { name: /rename thread/i })).toBeTruthy();
  });

  it("focuses and selects the title when editing starts", async () => {
    renderTree();

    const input = await openRename();

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("renames a thread from an inline editor and sends the trimmed title", async () => {
    renderTree();

    const input = await openRename();
    await userEvent.clear(input);
    await userEvent.type(input, "  Launch plan  {enter}");

    expect(renameMutateAsync).toHaveBeenCalledTimes(1);
    expect(renameMutateAsync).toHaveBeenCalledWith({
      threadId: "thread-1",
      title: "Launch plan",
    });
  });

  it("clears the title when the field is emptied", async () => {
    renderTree();

    const input = await openRename();
    await userEvent.clear(input);
    await userEvent.keyboard("{Enter}");

    expect(renameMutateAsync).toHaveBeenCalledWith({
      threadId: "thread-1",
      title: null,
    });
  });

  it("cancels the rename on Escape without a mutation", async () => {
    renderTree();

    const input = await openRename();
    await userEvent.type(input, "unsaved{Escape}");

    expect(renameMutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: /rename thread/i })).toBeNull();
    expect(screen.getByText("Plan the launch")).toBeTruthy();
  });

  it("does not fire when the title is unchanged", async () => {
    renderTree();

    await openRename();
    await userEvent.keyboard("{Enter}");

    expect(renameMutateAsync).not.toHaveBeenCalled();
  });

  it("does not save a legacy title that only needs trimming", async () => {
    threads = [thread({ title: "  Plan the launch  " })];
    renderTree();

    await openRename();
    await userEvent.keyboard("{Enter}");

    expect(renameMutateAsync).not.toHaveBeenCalled();
  });

  it("commits at most once when Enter is followed by blur", async () => {
    renderTree();

    const input = await openRename();
    await userEvent.clear(input);
    await userEvent.type(input, "Once{enter}");

    expect(renameMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("exposes a Rename thread item in the context menu", async () => {
    const user = userEvent.setup();
    renderTree();
    await user.click(screen.getByRole("button", { name: /thread menu/i }));
    expect(screen.getByRole("menuitem", { name: /rename thread/i })).toBeTruthy();
  });
});

describe("ThreadTree — sort preference", () => {
  it("uses Last user activity by default and persists Created", async () => {
    const user = userEvent.setup();
    threads = [
      thread({ id: "newer", title: "Newer", createdAt: 2_000, lastUserActivityAt: 2_000 }),
      thread({ id: "older", title: "Older", createdAt: 1_000, lastUserActivityAt: 3_000 }),
    ];
    const view = renderTree();

    const older = screen.getByText("Older");
    const newer = screen.getByText("Newer");
    expect(older.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    await user.click(screen.getByRole("button", { name: "Sidebar options" }));
    await user.hover(screen.getByRole("menuitem", { name: "Sort chats by" }));
    await screen.findByRole("menuitemradio", { name: "Created" });
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
      "Last user activity",
      "Created",
    ]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Created" }));
    expect(window.localStorage.getItem("valet:thread-sort")).toBe("created");
    view.unmount();

    renderTree();
    const restoredNewer = screen.getByText("Newer");
    const restoredOlder = screen.getByText("Older");
    expect(restoredNewer.compareDocumentPosition(restoredOlder) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});

describe("ThreadTree — origin", () => {
  it("marks each row with its origin and filters by origin", async () => {
    const user = userEvent.setup();
    threads = [
      thread({ id: "slack-thread", title: "From the channel", key: "slack:C1:1.2" }),
      thread({ id: "web-thread", title: "Typed here", key: "web:abc" }),
    ];
    renderTree();
    expect(screen.getByRole("img", { name: "From Slack" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "From web chat" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Sidebar options" }));
    await user.hover(screen.getByRole("menuitem", { name: "Show threads from" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Slack and other channels/ }));
    expect(screen.getByText("From the channel")).toBeTruthy();
    expect(screen.queryByText("Typed here")).toBeNull();
    expect(window.localStorage.getItem("valet:thread-origin")).toBe("channel");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("Typed here")).toBeTruthy();
  });
});

describe("ThreadTree — questions", () => {
  it("marks a thread amber while Valet's question waits on a reply", () => {
    threads = [
      thread({ id: "home", title: "Home", key: "default" }),
      thread({ id: "asked", title: "Asked", lastUserActivityAt: 10, lastAgentActivityAt: 20, agentQuestion: "Merge it once CI passes?" }),
      thread({ id: "answered", title: "Answered", lastUserActivityAt: 30, lastAgentActivityAt: 20, readAt: 40, agentQuestion: "Merge it?" }),
    ];
    renderTree();
    expect(screen.getAllByLabelText("Valet asked you a question")).toHaveLength(1);
    // The question outranks the unread dot on the same row.
    expect(screen.queryAllByLabelText("Unread")).toHaveLength(0);
  });
});

describe("ThreadTree — unread and pull requests", () => {
  it("dots unread threads, shows pull request state, and marks all read", async () => {
    const user = userEvent.setup();
    markThreadsReadMutate.mockClear();
    // Fixed creation times: the newest thread is the open one, and an open
    // thread shows no unread dot. `Date.now()` per fixture made that a race.
    threads = [
      thread({ id: "home", title: "Home", key: "default", createdAt: 3 }),
      thread({ id: "replied", title: "Agent replied", createdAt: 2, lastUserActivityAt: 10, lastAgentActivityAt: 20,
        pullRequests: [{ url: "https://github.com/acme/app/pull/7", repo: "acme/app", number: 7, state: "merged" }] }),
      thread({ id: "read", title: "Already read", createdAt: 1, lastUserActivityAt: 10, lastAgentActivityAt: 20, readAt: 30,
        pullRequests: [{ url: "https://github.com/acme/app/pull/8", repo: "acme/app", number: 8, state: "open" }] }),
    ];
    renderTree();
    expect(screen.getAllByLabelText("Unread")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Pull request merged: acme/app#7" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Pull request open: acme/app#8" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sidebar options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark all as read" }));
    expect(markThreadsReadMutate).toHaveBeenCalledWith({});
  });
});

vi.mock("~/api/child-work", async (importOriginal) => {
 const actual = await importOriginal<typeof import("~/api/child-work")>();
 return { ...actual,
  useChildWork: () => ({ hasNextPage, fetchNextPage, data: { pages: [{ children, runningCount: 0, nextCursor: null }] }, refetch: vi.fn() }),
  useDismissChild: () => ({ mutateAsync: dismissMutateAsync, isPending: false }),
 };
});

it("loads the next page of child work from the thread tree", async () => {
  hasNextPage = true;
  renderTree();
  await userEvent.setup().click(screen.getByRole("button", { name: "Load more work" }));
  expect(fetchNextPage).toHaveBeenCalledOnce();
});


it("keeps the selected search thread when content matches arrive", async () => {
  threads = [thread({ id: "content", title: "Deployment notes", lastUserActivityAt: 3 }), thread({ id: "first", title: "Linear plans", lastUserActivityAt: 2 }), thread({ id: "chosen", title: "Linear receipts", lastUserActivityAt: 1 })];
  const view = renderTree();
  fireEvent.click(screen.getByRole("button", { name: "Search threads" }));
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "Linear" } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  // Mouse and keyboard selection share the same active-result state.
  fireEvent.mouseMove(screen.getByRole("option", { name: "Linear receipts" }));
  searchMatches = [threads[0]!];
  view.rerender(<TooltipProvider><ThreadTree /></TooltipProvider>);
  expect(screen.getByRole("option", { name: "Deployment notes" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Linear receipts" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input, { key: "Enter" });
  const navigateOptions = navigate.mock.calls.at(-1)?.[0];
  expect(navigateOptions.search({})).toMatchObject({ thread: "chosen" });
});

describe("ThreadTree: timer wait line", () => {
  it("shows a quiet line on a thread with an active timer, and none on the others", () => {
    threads = [thread({ id: "thread-1", title: "Plan the launch" }), thread({ id: "thread-2", title: "Fix the build" })];
    const now = Date.now();
    wakeups = {
      wakeups: [
        { id: "wk_1", threadId: "thread-1", kind: "timer", status: "pending", reason: "check CI", fireAt: now + 26 * 60_000 + 10_000, createdAt: now },
        // A process gets no row line: only timers do.
        { id: "wk_2", threadId: "thread-2", kind: "process", status: "running", reason: "build", deadlineAt: now + 3_600_000, createdAt: now },
      ],
      leases: [{ id: "ls_1", threadId: "thread-2", ownerKind: "hold", reason: "terminal", deadlineAt: now + 3_600_000, createdAt: now }],
    };
    renderTree();
    const lines = screen.getAllByText(/^Waiting · next wakeup/);
    expect(lines.map((l) => l.textContent)).toEqual(["Waiting · next wakeup in 26m"]);
    // The line sits under its own thread's row.
    const row = screen.getByText("Plan the launch").closest("a")?.parentElement?.parentElement;
    expect(row?.contains(lines[0] ?? null)).toBe(true);
  });

  it("shows no line without timers", () => {
    wakeups = { wakeups: [], leases: [] };
    renderTree();
    expect(screen.queryByText(/^Waiting · next wakeup/)).toBeNull();
  });
});

/** Saves the sidebar document the projects hook reads at render. */
function saveSidebar(value: { projects?: Array<{ id: string; name: string; collapsed: boolean }>; pinned?: string[] }) {
  window.localStorage.setItem(`valet:thread-projects:user-1:${encodeURIComponent("orchestrator:user-1")}`, JSON.stringify({
    projects: value.projects ?? [], assignments: {}, pinned: value.pinned ?? [], grouped: true, collapsed: false,
  }));
}

describe("ThreadTree: Needs you section", () => {
  // The section is the phone drawer's. The web sidebar marks rows in place.
  beforeEach(() => { mobile = true; });

  it("keeps gated threads in place on a wider screen", () => {
    mobile = false;
    threads = [thread({ id: "gated", title: "Gated thread" })];
    pendingGates = { g1: gate("g1", "gated") };
    renderTree();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Recents" })).getByText("Gated thread")).toBeTruthy();
  });

  it("moves a gated thread to the top section and out of Pinned and Recents", () => {
    threads = [
      thread({ id: "quiet", title: "Quiet thread", createdAt: 3_000 }),
      thread({ id: "gated", title: "Gated thread", createdAt: 2_000 }),
    ];
    pendingGates = { g1: gate("g1", "gated") };
    saveSidebar({ pinned: ["gated"] });
    renderTree();

    const needsYou = screen.getByRole("region", { name: "Needs you" });
    expect(within(needsYou).getByText("Gated thread")).toBeTruthy();
    expect(within(needsYou).getByRole("img", { name: "Needs approval" })).toBeTruthy();
    expect(within(needsYou).getByText("Gated thread").className).toContain("font-medium");
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();
    const recents = screen.getByRole("region", { name: "Recents" });
    expect(within(recents).queryByText("Gated thread")).toBeNull();
    expect(within(recents).getByText("Quiet thread")).toBeTruthy();
    expect(screen.getAllByText("Gated thread")).toHaveLength(1);
  });

  it("lists questions and gates newest activity first, and hides when nothing waits", () => {
    threads = [
      thread({ id: "older", title: "Older question", createdAt: 1, lastUserActivityAt: 10, lastAgentActivityAt: 20, agentQuestion: "Ship it?" }),
      thread({ id: "newer", title: "Newer question", createdAt: 2, lastUserActivityAt: 10, lastAgentActivityAt: 50, agentQuestion: "Merge it?" }),
    ];
    const view = renderTree();
    // The mocked Link renders an `a` without `href`, which has no link role.
    const titles = [...screen.getByRole("region", { name: "Needs you" }).querySelectorAll("a")].map((link) => link.textContent);
    expect(titles[0]).toContain("Newer question");
    expect(titles[1]).toContain("Older question");
    view.unmount();

    threads = [thread()];
    renderTree();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });
});

describe("ThreadTree: project row controls", () => {
  it("hides per-project actions on a phone, keeps the list menu, and always shows them on a wider screen", () => {
    saveSidebar({ projects: [{ id: "acme", name: "ACME", collapsed: false }] });
    renderTree();

    for (const name of ["New thread in ACME", "Project menu: ACME", "New project"]) {
      const control = screen.getByRole("button", { name });
      expect(control.className).toContain("max-md:hidden");
      expect(control.className).not.toContain("opacity-0");
    }
    // The list-wide menu (sort, filter, mark all read) has no other home on a
    // phone, so it stays, with a 44px target.
    const options = screen.getByRole("button", { name: "Sidebar options" }).className;
    expect(options).not.toContain("max-md:hidden");
    expect(options).toContain("max-md:min-h-11");
  });

  it("shows an empty project's drop hint on a wider screen only", () => {
    saveSidebar({ projects: [{ id: "acme", name: "ACME", collapsed: false }] });
    renderTree();
    expect(screen.getByText("Start a thread with + or move one here").className).toContain("max-md:hidden");
  });
});

function workflow(overrides: Partial<WorkflowDefinitionSummary> = {}): WorkflowDefinitionSummary {
  return { id: "wf-1", name: "Nightly release notes", definition: {}, createdAt: 1, updatedAt: 1, ownerType: "user", ownerId: "user-1", ...overrides };
}

function artifact(overrides: Partial<ArtifactListItem> = {}): ArtifactListItem {
  return {
    id: "artifact-1", ownerType: "user", path: "reports/q3.md", title: "Quarterly report", format: "markdown", icon: "file",
    version: 1, sharedVersion: null, token: "token-1", url: "https://valet.example/a/token-1", visibility: "org",
    actorUserId: "user-1", revoked: false, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function openSearch(query: string): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Search threads" }));
  const input = screen.getByRole("combobox", { name: "Search threads" });
  fireEvent.change(input, { target: { value: query } });
  return input;
}

describe("ThreadTree: search filter chips", () => {
  // Workflow and file results are the phone drawer's. The web sidebar searches threads.
  beforeEach(() => { mobile = true; });

  it("searches threads only on a wider screen, with no chips and no workflow or file reads", () => {
    mobile = false;
    workflows = [workflow({ name: "Release workflow" })];
    threads = [thread({ title: "Release checklist" })];
    renderTree();
    openSearch("release");
    expect(screen.queryByRole("group", { name: "Search in" })).toBeNull();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Release checklist"]);
    expect(listReads.every((read) => read.enabled === false)).toBe(true);
  });

  it("reads workflows and files only while the dialog is open", () => {
    renderTree();
    expect(listReads.length).toBeGreaterThan(0);
    expect(listReads.every((read) => read.enabled === false)).toBe(true);

    openSearch("");
    expect(listReads.slice(-2)).toEqual([
      { list: "workflows", enabled: true, ownerId: "user-1" },
      { list: "artifacts", enabled: true, ownerId: "user-1" },
    ]);
  });

  it("lists matching workflow names under Workflows and opens one with Enter", () => {
    workflows = [workflow({ id: "wf-release", name: "Nightly Release notes" }), workflow({ id: "wf-triage", name: "Triage alerts" })];
    threads = [thread({ title: "Release checklist" })];
    renderTree();
    const input = openSearch("release");

    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
    expect(screen.getByRole("button", { name: "Workflows" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Nightly Release notes"]);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenLastCalledWith({ to: "/workflows/$workflowId", params: { workflowId: "wf-release" } });
  });

  it("lists matching files by title or path under Files and opens one like the Artifacts page", () => {
    artifacts = [
      artifact({ id: "a-title", title: "Quarterly report", path: "reports/q3.md", token: "token-title" }),
      artifact({ id: "a-path", title: "Notes", path: "journal/quarterly-notes.md", token: "token-path" }),
      artifact({ id: "a-revoked", title: "Old quarterly", revoked: true }),
      artifact({ id: "a-other", title: "Unrelated", path: "misc.md" }),
    ];
    renderTree();
    openSearch("quarterly");

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Quarterly reportreports/q3.md", "Notesjournal/quarterly-notes.md"]);

    fireEvent.click(options[1]!);
    expect(navigate).toHaveBeenLastCalledWith({ to: "/a/$token", params: { token: "token-path" } });
  });

  it("shows every group under All, threads first and at most eight each, and arrows move across groups", () => {
    threads = Array.from({ length: 10 }, (_, i) => thread({ id: `t-${i}`, title: `Deploy thread ${i}`, createdAt: 100 - i, lastUserActivityAt: 100 - i }));
    workflows = Array.from({ length: 10 }, (_, i) => workflow({ id: `wf-${i}`, name: `Deploy workflow ${i}` }));
    artifacts = [artifact({ id: "doc", title: "Deploy runbook" })];
    renderTree();
    const input = openSearch("deploy");

    const listbox = screen.getByRole("listbox");
    const groups = within(listbox).getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Threads", "Workflows", "Files"]);
    expect(within(screen.getByRole("group", { name: "Threads" })).getAllByRole("option")).toHaveLength(8);
    expect(within(screen.getByRole("group", { name: "Workflows" })).getAllByRole("option")).toHaveLength(8);
    expect(within(screen.getByRole("group", { name: "Files" })).getAllByRole("option")).toHaveLength(1);

    // jsdom has no scrollIntoView. The arrow keys keep the active option in view.
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: vi.fn(), configurable: true });
    try {
      for (let i = 0; i < 8; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
    const firstWorkflow = screen.getByRole("option", { name: "Deploy workflow 0" });
    expect(firstWorkflow.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(firstWorkflow.id);
  });
});
