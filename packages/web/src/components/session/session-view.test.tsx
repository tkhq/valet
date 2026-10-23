// @vitest-environment jsdom
/**
 * `SessionView` header chrome (decisions 13/14): by default the view gets
 * the existing `SessionHeader` (model picker, delete, etc.); with `panel`
 * it gets a compact header (title + open-full-page + ✕ close) instead. The
 * threads/thread-tree *sidebar* is deliberately NOT part of this
 * component (it's a root-layout concern — see `__root.tsx`), so this test
 * only covers header chrome, not sidebar visibility.
 *
 * All data hooks are mocked so this stays a pure rendering/branching test.
 */
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { api } from "~/api/client";
import { SessionView } from "./session-view";
import { ChildPanel } from "./child-panel";
import { useThreadReplyTarget } from "./send-as-person";


let browserActivity = false;
let liveStatus: import("~/stores/stream").AgentStatus = "idle";
let queueState: import("@valet/api/wire").WireQueueState | undefined;
let fullProfile = false;
let readOnlyReason: string | undefined;
let mobileLayout = false;
let pendingGate: import("@valet/api/wire").DecisionGate | undefined;
let sessionOwner: { type: "user" | "team"; id: string } = { type: "user", id: "u1" };
beforeEach(() => { pendingGate = undefined; browserActivity = false; fullProfile = false; readOnlyReason = undefined; liveStatus = "idle"; queueState = undefined; mobileLayout = false; sessionOwner = { type: "user", id: "u1" }; announceView.mockClear(); });


vi.mock("~/hooks/use-mobile-layout", () => ({ useMobileLayout: () => mobileLayout }));
vi.mock("~/components/home/tasks-panel", () => ({ TasksPanel: () => <div>Tasks across workspaces</div>, useNeedsYouCount: () => ({ count: 0, partial: false }) }));
vi.mock("~/components/home/make-panel", () => ({ MakePanel: () => <div>Make across workspaces</div> }));

const announceView = vi.hoisted(() => vi.fn());
vi.mock("~/api/ws", () => ({ useSessionWebSocket: () => undefined, useAnnounceThreadView: announceView, announceTyping: () => undefined }));

// importOriginal keeps the module's other exports real (see vitest.config.ts).
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSession: () => ({
      isLoading: false,
      error: null,
      data: { readOnlyReason, owner: sessionOwner, id: "sess-1", title: "fix-auth", workspace: "/workspace", profile: fullProfile ? "full" : "headless" },
    }),
    useThreads: () => ({ data: { threads: [{ id: "t1", createdAt: 0 }] } }),
    useMessages: () => ({ data: undefined }),
    useDecisions: () => ({ data: undefined }),
  };
});

vi.mock("~/stores/stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/stores/stream")>();
  return {
    ...actual,
    useSessionStream: () => ({ messages: browserActivity ? [{ id: "browser-call", sessionId: "sess-1", threadId: "t1", role: "assistant", content: "", createdAt: 1, parts: [{kind: "tool_call", callId: "browser", toolName: "browser.execute", status: "completed"}] }] : [], statusByThread: {}, conn: "open" }),
    useStreamStore: (selector: (s: { setThreadMessages: () => void; setPendingGates: () => void }) => unknown) =>
      selector({ setThreadMessages: vi.fn(), setPendingGates: vi.fn() }),
    usePendingGateForThread: () => pendingGate,
    useQueueStateForThread: () => queueState,
    useThreadLiveStatus: () => ({ status: liveStatus }),
  };
});

// Signal turns reach the transcript only through this refetch hook.
const queueStateRefetch = vi.hoisted(() => vi.fn());
vi.mock("~/hooks/use-invalidate-messages-on-queue-state", () => ({ useInvalidateMessagesOnQueueState: queueStateRefetch }));

vi.mock("./session-header", () => ({
  SandboxChip: () => null,
  SessionHeader: ({ session, summaryControl, onOpenView }: { session: { title?: string }; summaryControl?: ReactNode; onOpenView?: (view: "browser") => void }) => (
    <div data-testid="full-header"><button aria-label="Thread menu">Menu</button>{session.title}{summaryControl}{onOpenView && <button onClick={() => onOpenView("browser")}>Open browser</button>}</div>
  ),
}));
vi.mock("./thread-context-panel", () => ({ ThreadContextPanel: () => <div>Thread summary contents</div> }));
vi.mock("./message-list", () => ({ MessageList: ({ header }: { header?: ReactNode }) =>
  <div data-testid="message-list" data-can-reply={Boolean(useThreadReplyTarget())}>{header}</div> }));
// The stub renders the status line slot, so the background work line shows.
vi.mock("./composer", () => ({ Composer: ({ statusLine }: { statusLine?: ReactNode }) => <div data-testid="composer">{statusLine}</div> }));
vi.mock("./decision-gate-card", () => ({ DecisionGateCard: () => null }));

vi.mock("./browser/browser-overlay", () => ({ BrowserOverlay: ({ minimized, onMinimize, onRestore, onClose, onExpand }: {
  minimized: boolean; onMinimize: () => void; onRestore: () => void; onClose: () => void; onExpand: () => void;
}) => <section aria-label="Browser preview"><span>{minimized ? "minimized feed" : "visible feed"}</span>
  <button onClick={onMinimize}>minimize preview</button><button onClick={onRestore}>restore preview</button>
  <button onClick={onClose}>close preview</button><button onClick={onExpand}>expand preview</button></section> }));
vi.mock("./browser/mobile-browser", async (importOriginal) => ({
  ...await importOriginal<typeof import("./browser/mobile-browser")>(),
  MobileBrowser: () => <section aria-label="Mobile browser card" />,
}));
vi.mock("./browser/browser-pane", () => ({ BrowserPane: ({ compact }: { compact?: boolean }) => <section aria-label="Full browser" data-compact={compact} /> }));

function renderInRouter(sessionId: string, panel: boolean, onClose?: () => void, active = true) {
  return renderComponent(() => <SessionView sessionId={sessionId} panel={panel} onClose={onClose} active={active} />);
}

function renderComponent(component: () => ReactNode) {
  const rootRoute = createRootRoute({ component });
  const router = createRouter({
    routeTree: rootRoute.addChildren([]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // SessionView's query hooks need a QueryClient in scope. Provide a scratch
  // client per render so the test shares no cache state.
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("SessionView header chrome", () => {
  it("uses Chat, Tasks, and Make for a team thread with a sharing notice, keeping its draft mounted", async () => {
    mobileLayout = true;
    sessionOwner = { type: "team", id: "team-a" };
    renderComponent(() => <SessionView sessionId="sess-1" activeThreadId="t1" scopeNotice="Shared with Platform. Members can read and reply." />);
    expect((await screen.findAllByRole("tab")).map((tab) => tab.textContent)).toEqual(["Chat", "Tasks", "Make"]);
    const composer = screen.getByTestId("composer");
    fireEvent.click(screen.getByRole("tab", { name: "Make" }));
    expect(screen.getByText("Make across workspaces")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(screen.getByText("Tasks across workspaces")).toBeTruthy();
    expect(announceView).toHaveBeenLastCalledWith("sess-1", undefined);
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByTestId("composer")).toBe(composer);
    expect(announceView).toHaveBeenLastCalledWith("sess-1", "t1");
    expect(screen.queryByRole("tab", { name: "Browser" })).toBeNull();
  });

  it("opens a team's browser from the menu and returns to chat without the legacy view tabs", async () => {
    mobileLayout = true;
    sessionOwner = { type: "team", id: "team-a" };
    renderComponent(() => <SessionView sessionId="sess-1" activeThreadId="t1" scopeNotice="Shared with Platform." />);
    fireEvent.click(await screen.findByRole("button", { name: "Open browser" }));
    expect((await screen.findByRole("region", { name: "Full browser" })).getAttribute("data-compact")).toBe("true");
    expect(screen.queryByRole("tab", { name: "Browser" })).toBeNull();
    const back = screen.getByRole("button", { name: "Back to chat" });
    back.focus();
    fireEvent.click(back);
    expect(screen.getByTestId("composer")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Thread menu" }));
  });

  it("keeps the draft mounted but hides the phone composer while answering", async () => {
    mobileLayout = true;
    pendingGate = { id: "g1", sessionId: "sess-1", threadId: "t1", type: "question", title: "Choose", actions: [], status: "pending", createdAt: 0, updatedAt: 0 };
    renderComponent(() => <SessionView sessionId="sess-1" activeThreadId="t1" composerAccessory={<div data-testid="other-request" />} />);
    expect((await screen.findByTestId("other-request")).closest('[aria-hidden="true"]')).toBeTruthy();
    const composer = await screen.findByTestId("composer");
    expect(composer.closest('[aria-hidden="true"]')?.className).toContain("hidden");
  });

  it("keeps the composer visible for a question assigned to someone else", async () => {
    mobileLayout = true;
    pendingGate = { id: "g2", sessionId: "sess-1", threadId: "t1", type: "question", title: "Choose", actions: [], status: "pending", createdAt: 0, updatedAt: 0, approver: { userId: "other", name: "Another member" } };
    renderComponent(() => <SessionView sessionId="sess-1" activeThreadId="t1" />);
    const composer = await screen.findByTestId("composer");
    expect(composer.closest('[aria-hidden="true"]')).toBeNull();
  });

  it("retains a cross-thread answer when an own-thread question arrives", async () => {
    mobileLayout = true;
    function Preview() {
      const [waiting, setWaiting] = useState(false);
      pendingGate = waiting ? { id: "own-question", sessionId: "sess-1", threadId: "t1", type: "question", title: "Choose", actions: [], status: "pending", createdAt: 0, updatedAt: 0 } : undefined;
      return <><button onClick={() => setWaiting(!waiting)}>Toggle own question</button><SessionView sessionId="sess-1" activeThreadId="t1" suppressComposer composerAccessory={<textarea aria-label="Cross-thread answer" />} /></>;
    }
    renderComponent(() => <Preview />);
    const answer = await screen.findByRole("textbox", { name: "Cross-thread answer" });
    fireEvent.change(answer, { target: { value: "Draft with important details" } });
    fireEvent.click(screen.getByRole("button", { name: "Toggle own question" }));
    expect(answer.closest('[aria-hidden="true"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Toggle own question" }));
    expect(screen.getByRole("textbox", { name: "Cross-thread answer" })).toBe(answer);
    expect(answer).toHaveProperty("value", "Draft with important details");
  });

  it("opens Home's browser even when its desktop view is chat-only", async () => {
    mobileLayout = true;
    const { MobileConversationLayout } = await import("~/components/home/mobile-conversation-layout");
    renderComponent(() => <MobileConversationLayout view="chat" onViewChange={() => {}}><SessionView sessionId="sess-1" activeThreadId="t1" panel hidePanelHeader chatOnly sharedConversationChrome /></MobileConversationLayout>);
    fireEvent.click(await screen.findByRole("button", { name: "Open browser" }));
    expect((await screen.findByRole("region", { name: "Full browser" })).getAttribute("data-compact")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  it("keeps embedded panel close controls on a phone", async () => {
    mobileLayout = true;
    renderInRouter("sess-1", true, () => {});
    expect(await screen.findByRole("button", { name: "Close panel" })).toBeTruthy();
  });

  it("preserves custom controls in a chat-only assistant panel on a phone", async () => {
    mobileLayout = true;
    renderComponent(() => <SessionView sessionId="sess-1" activeThreadId="t1" panel chatOnly renderPanelHeader={() => <button>Close assistant</button>} />);
    expect(await screen.findByRole("button", { name: "Close assistant" })).toBeTruthy();
  });

  it("suppresses summary portals for a hidden embedded chat", async () => {
    renderInRouter("sess-1", false, undefined, false);
    fireEvent.click(await screen.findByRole("button", { name: "Toggle summary" }));
    expect(screen.queryByText("Thread summary contents")).toBeNull();
  });
  it("leaves the chat unobscured until the user opens the summary", async () => {
    renderInRouter("sess-1", false);
    const toggle = await screen.findByRole("button", { name: "Toggle summary" });
    expect(screen.queryByText("Thread summary contents")).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText("Thread summary contents")).toBeTruthy();
  });
  it("shows a recovery instruction instead of a composer for legacy history", async () => {
    readOnlyReason = "This legacy conversation is read-only. Start a new thread to continue.";
    renderInRouter("sess-1", false);
    expect(await screen.findByText(readOnlyReason)).toBeTruthy();
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.getByTestId("message-list").getAttribute("data-can-reply")).toBe("false");
  });
  it("watches from chat, suspends in the full pane, restores, and returns focus on close", async () => {
    fullProfile = true;
    renderInRouter("sess-1", false);
    fireEvent.click(await screen.findByRole("tab", { name: "Browser" }));
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByText("visible feed")).toBeTruthy();
    fireEvent.click(screen.getByText("minimize preview"));
    expect(screen.getByText("minimized feed")).toBeTruthy();
    fireEvent.click(screen.getByText("restore preview"));
    expect(screen.getByText("visible feed")).toBeTruthy();
    fireEvent.click(screen.getByText("expand preview"));
    expect(screen.queryByRole("region", { name: "Browser preview" })).toBeNull();
    expect(screen.getByRole("region", { name: "Full browser" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Browser" }));
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByText("visible feed")).toBeTruthy();
    fireEvent.click(screen.getByText("close preview"));
    expect(screen.queryByRole("region", { name: "Browser preview" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Chat" }));
  });
  it("without panel: renders the standard SessionHeader", async () => {
    renderInRouter("sess-1", false);
    expect(await screen.findByTestId("full-header")).toBeTruthy();
    expect(screen.queryByLabelText("Close panel")).toBeNull();
  });

  it("panel: renders a compact header with title + close button, not SessionHeader", async () => {
    const onClose = vi.fn();
    renderInRouter("sess-1", true, onClose);
    expect(await screen.findByText("fix-auth")).toBeTruthy();
    expect(screen.queryByTestId("full-header")).toBeNull();
    const closeBtn = screen.getByLabelText("Close panel");
    closeBtn.click();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the phone tab strip in a panel, whose header has no thread menu", async () => {
    renderInRouter("sess-1", true);
    const panelStrip = (await screen.findByRole("tab", { name: "Chat" })).closest(".border-b");
    expect(panelStrip?.className).not.toContain("max-sm:hidden");
  });

  it("hides the phone tab strip on Chat when the thread menu lists the views", async () => {
    renderInRouter("sess-1", false);
    const strip = (await screen.findByRole("tab", { name: "Chat" })).closest(".border-b");
    expect(strip?.className).toContain("max-sm:hidden");
  });

  it("keeps focus on the selected sandbox tab across chat transitions", async () => {
    fullProfile = true;
    renderInRouter("sess-1", false);
    const terminal = await screen.findByRole("tab", { name: "Terminal" });
    act(() => terminal.focus());
    fireEvent.click(terminal);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Terminal" })));
    const chat = screen.getByRole("tab", { name: "Chat" });
    act(() => chat.focus());
    fireEvent.click(chat);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Chat" })));
  });

  it("renders the transcript and composer either way", async () => {
    renderInRouter("sess-1", true);
    expect(await screen.findByTestId("message-list")).toBeTruthy();
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  it("refetches messages on queue changes, so signal turns render live in a session", async () => {
    renderInRouter("sess-1", false);
    expect(await screen.findByTestId("message-list")).toBeTruthy();
    expect(queueStateRefetch).toHaveBeenCalledWith("sess-1", undefined);
  });
});

describe("SessionView: background work status line", () => {
  afterEach(() => vi.restoreAllMocks());
  const work = () => ({
    wakeups: [{ id: "wk_1", threadId: "t1", kind: "timer" as const, status: "pending" as const, reason: "check CI", fireAt: Date.now() + 26 * 60_000 + 10_000, createdAt: Date.now() }],
    leases: [],
  });

  it("renders the line with the composer on the session page", async () => {
    vi.spyOn(api, "listSessionWakeups").mockResolvedValue(work());
    renderInRouter("sess-1", false);
    const line = await screen.findByRole("button", { name: /^Background work: / });
    expect(line.textContent).toContain("next wakeup in 26m");
    expect(line.textContent).toContain("1 timer");
    expect(screen.getByTestId("composer").contains(line)).toBe(true);
  });

  it("renders the line in the child panel", async () => {
    const list = vi.spyOn(api, "listSessionWakeups").mockResolvedValue(work());
    renderComponent(() => <ChildPanel childId="sess-1" onClose={() => {}} />);
    const panel = await screen.findByRole("dialog", { name: "Child thread" });
    const line = await within(panel).findByRole("button", { name: /^Background work: / });
    expect(line.textContent).toContain("1 timer");
    expect(list).toHaveBeenCalledWith("sess-1");
  });

  it("renders no line while the session has no background work", async () => {
    const list = vi.spyOn(api, "listSessionWakeups").mockResolvedValue({ wakeups: [], leases: [] });
    renderInRouter("sess-1", false);
    expect(await screen.findByTestId("composer")).toBeTruthy();
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /^Background work: / })).toBeNull();
  });
});



it("shows completed browser work in mobile chat-only conversations", async () => {
  browserActivity = true;
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
  try {
    renderComponent(() => <SessionView sessionId="sess-1" activeThreadId="t1" chatOnly />);
    expect(await screen.findByRole("region", { name: "Mobile browser card" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Browser preview" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Browser" })).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

describe("SessionView processing visibility", () => {
  it.each([
    ["queued", "Valet is queued"],
    ["thinking", "Valet is thinking…"],
    ["tool_calling", "Valet is working…"],
    ["streaming", "Valet is working…"],
    ["blocked_on_decision_gate", "Valet is waiting for a response"],
  ] as const)("shows %s beside the composer without a transcript message", async (status, label) => {
    liveStatus = status;
    renderInRouter("sess-1", false);
    const cue = await screen.findByText(label);
    expect(cue.closest('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(cue.closest('[data-testid="message-list"]')).toBeNull();
    expect(screen.getByTestId("composer")).toBeTruthy();
  });
  it("uses durable queue state for externally submitted work before any live token", async () => {
    queueState = { mode: "followup", status: "running", pendingIds: [], collectingIds: [], activeItemId: "slack-item" };
    renderInRouter("sess-1", true);
    expect(await screen.findByText("Valet is working…")).toBeTruthy();
  });
  it.each(["idle", "error"] as const)("does not claim to work when %s", async status => {
    liveStatus = status;
    renderInRouter("sess-1", false);
    await screen.findByTestId("composer");
    expect(screen.queryByText(/Valet is/)).toBeNull();
  });

});
