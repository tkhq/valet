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
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { TooltipProvider } from "~/components/primitives";
import type {
  DecisionGate,
  GetModelTiersResponse,
  ModelInfo,
  ChildWorkSummary,
  ThreadSummary,
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
    expect(window.localStorage.getItem("valet:subconversations-collapsed:thread-1")).toBeNull();
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
