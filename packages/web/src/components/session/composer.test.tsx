// @vitest-environment jsdom
/**
 * Composer-prefill consumption (decision 17): the memory doc pane sets
 * `useComposerPrefillStore` before navigating to `/chat`; the next
 * `Composer` mount must seed its textarea from that store exactly once and
 * leave the store empty afterward, so it doesn't leak into a later
 * mount/remount.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EditPreviewResponse, WireQueueState } from "@valet/api/wire";
import type { StreamMessage } from "~/stores/stream";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { ApiError } from "~/api/client";
import { AppPageHintContext } from "~/lib/app-page-hint";
import { draftKey, useComposerDraftStore } from "~/stores/composer-drafts";

const navigate = vi.fn().mockResolvedValue(undefined);
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

const abortMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const abortMutate = vi.fn();
const cancelQueuedMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const resumeMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const sendState: { pending: boolean; sessions?: string[] } = { pending: false };
// Sessions whose stop request is in flight.
const abortState: { sessions: string[] } = { sessions: [] };
const sendMutateAsync = vi.fn().mockResolvedValue({ messageId: "q-1", threadId: "thread-1" });
const addUserMessage = vi.fn(() => "user-opt-1");
const setMessageQueueItemId = vi.fn();

// Per-test queue state for the active thread. Held in a container so the
// hoisted `vi.mock` factory closes over a stable binding and each test can
// swap the value the composer reads.
const queueStateRef: { current: WireQueueState | undefined } = { current: undefined };
// The session's live transcript, which prompt recall reads.
const streamMessagesRef: { current: StreamMessage[] } = { current: [] };
// What the edit bar's preview query returns.
const editPreviewRef: { current: EditPreviewResponse | undefined } = { current: undefined };

function queueState(mode: WireQueueState["mode"]): WireQueueState {
  return {
    mode,
    status: "running",
    activeItemId: "q-0",
    pendingIds: [],
    collectingIds: [],
  };
}

// importOriginal keeps the module's other exports real (see vitest.config.ts).
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSendPrompt: (sessionId: string) => ({ isPending: sendState.pending && (sendState.sessions ?? [sessionId]).includes(sessionId), mutateAsync: sendMutateAsync }),
    useAbortThread: (sessionId: string) => ({
      isPending: abortState.sessions.includes(sessionId),
      mutateAsync: abortMutateAsync,
      mutate: abortMutate,
    }),
    useResumeThread: () => ({
      isPending: false,
      mutateAsync: resumeMutateAsync,
    }),
    useCancelQueuedItem: () => ({ isPending: false, mutateAsync: cancelQueuedMutateAsync }),
    useEditPreview: (threadId: string | undefined, entryId: string | undefined) => ({ data: threadId && entryId ? editPreviewRef.current : undefined }),
  };
});

vi.mock("~/api/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api/settings")>()),
  // Prompt recall reads the signed-in person; the fixtures' prompts are theirs.
  useMe: () => ({ data: { id: "user-1" } }),
}));

vi.mock("~/stores/stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/stores/stream")>();
  return {
    ...actual,
    useStreamStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ addUserMessage, setMessageQueueItemId, bySession: { "orchestrator:user-1": { messages: streamMessagesRef.current } } }),
    useQueueStateForThread: () => queueStateRef.current,
  };
});

vi.mock("~/hooks/use-commands", () => ({
  useCommands: () => ({
    data: {
      commands: [
        { name: "status", description: "Show session status", source: "builtin" },
        { name: "stop", description: "Stop the agent", source: "builtin" },
        // "top" vs "stop": typing "/top" prefix-matches one and
        // substring-matches the other — the ranking test needs both.
        { name: "top", description: "Show resource usage", source: "builtin" },
        { name: "skill:review", description: "Run code review", source: "skill" },
        {
          name: "model",
          description: "Switch model or list choices",
          source: "builtin",
          argHint: "[model-id]",
          argOptions: [
            { value: "claude-opus-4-8", label: "Opus 4.8" },
            { value: "claude-haiku-4-5", label: "Haiku 4.5" },
          ],
        },
        {
          name: "compact",
          description: "Compact the thread context",
          source: "builtin",
          argHint: "[instructions]",
        },
      ],
    },
  }),
}));

import { Composer } from "./composer";

function renderComposer(
  agentStatus: "idle" | "streaming" = "idle",
  queuedMessages: StreamMessage[] = [],
  queuedItemCount = queuedMessages.length,
) {
  const queryClient = new QueryClient();
  const tree = (status: "idle" | "streaming", threadId = "thread-1") => (
    <QueryClientProvider client={queryClient}>
      <Composer
        sessionId="orchestrator:user-1"
        threadId={threadId}
        agentStatus={status}
        queuedMessages={queuedMessages}
        queuedItemCount={queuedItemCount}
      />
    </QueryClientProvider>
  );
  const view = render(tree(agentStatus));
  return Object.assign(view, {
    rerenderComposer: (status: "idle" | "streaming" = agentStatus, threadId = "thread-1") => view.rerender(tree(status, threadId)),
  });
}

beforeEach(() => {
  navigate.mockClear();
  queueStateRef.current = undefined;
  editPreviewRef.current = undefined;
  streamMessagesRef.current = [];
  sendState.pending = false;
  sendState.sessions = undefined;
  abortState.sessions = [];
  useComposerPrefillStore.setState({ text: null });
  // Drafts live in a module-global store keyed by (session, thread) — the
  // same key across tests would leak one test's draft into the next.
  useComposerDraftStore.setState({ byKey: {} });
  sendMutateAsync.mockReset();
  sendMutateAsync.mockResolvedValue({ messageId: "q-1", threadId: "thread-1" });
  abortMutateAsync.mockClear();
  cancelQueuedMutateAsync.mockClear();
  resumeMutateAsync.mockClear();
  addUserMessage.mockClear();
  setMessageQueueItemId.mockClear();
});

it("sends the current Ask Valet page on each message while the panel stays mounted", async () => {
  const client = new QueryClient();
  const tree = (pathname: string) => <QueryClientProvider client={client}>
    <AppPageHintContext.Provider value={{ pathname, workspace: "user" }}>
      <Composer sessionId="assistant" threadId="thread-1" agentStatus="idle" />
    </AppPageHintContext.Provider>
  </QueryClientProvider>;
  const view = render(tree("/settings/profile"));
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Help here." } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter", code: "Enter" });
  await waitFor(() => expect(sendMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ appPageHint: { pathname: "/settings/profile", workspace: "user" } })));
  view.rerender(tree("/integrations"));
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Help on this page." } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter", code: "Enter" });
  await waitFor(() => expect(sendMutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ appPageHint: { pathname: "/integrations", workspace: "user" } })));
});

describe("Composer queued-message stack", () => {
  it("renders queued messages in admission order and sends a selected item now", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = { ...queueState("followup"), pendingIds: ["q-1", "q-2"] };
    const queuedMessages: StreamMessage[] = [
      {
        id: "message-1",
        sessionId: "orchestrator:user-1",
        threadId: "thread-1",
        role: "user",
        content: "First queued message",
        parts: [],
        createdAt: 1,
        queueItemId: "q-1",
      },
      {
        id: "message-2",
        sessionId: "orchestrator:user-1",
        threadId: "thread-1",
        role: "user",
        content: "Second queued message",
        parts: [],
        createdAt: 2,
        queueItemId: "q-2",
      },
    ];
    sendMutateAsync.mockResolvedValueOnce({ messageId: "q-3", threadId: "thread-1" });
    renderComposer("streaming", queuedMessages);

    const stack = screen.getByLabelText("Queued messages");
    const stackText = stack.textContent ?? "";
    expect(stackText.indexOf("First queued message")).toBeLessThan(
      stackText.indexOf("Second queued message"),
    );
    const buttons = screen.getAllByRole("button", { name: "Send now" });
    await userEvent.click(buttons[1]);

    await waitFor(() =>
      expect(sendMutateAsync).toHaveBeenCalledWith({
        text: "",
        threadId: "thread-1",
        promoteItemId: "q-2",
      }),
    );
    expect(setMessageQueueItemId).toHaveBeenCalledWith(
      "orchestrator:user-1",
      "message-2",
      "q-3",
    );
  });

  it("keeps unresolved pending items visible after reload, each with Cancel", () => {
    queueStateRef.current = { ...queueState("followup"), pendingIds: ["q-1", "q-2"] };
    renderComposer("streaming", [], 2);

    expect(screen.getAllByText("Queued message. It runs when the current turn ends.")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]!);
    expect(cancelQueuedMutateAsync).toHaveBeenCalledWith({ threadId: "thread-1", itemId: "q-2" });
  });

  it("shows a queued item's text from the queue state after reload, Send now only on the person's message", () => {
    queueStateRef.current = {
      ...queueState("followup"),
      pendingIds: ["q-1", "q-2"],
      pending: [
        { id: "q-1", text: "also check the deploy logs", midTurn: true },
        { id: "q-2", text: "Check the build now.", signal: { type: "wakeup" }, midTurn: true },
      ],
    };
    renderComposer("streaming", [], 2);

    expect(screen.getByText("also check the deploy logs")).toBeTruthy();
    expect(screen.getByText("Wake-up")).toBeTruthy();
    expect(screen.queryByText("Queued message. It runs when the current turn ends.")).toBeNull();
    // The wake-up runs by itself, so only the person's message has Send now.
    expect(screen.getAllByRole("button", { name: "Send now" })).toHaveLength(1);
    expect(screen.getByText("Runs next")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(sendMutateAsync).toHaveBeenCalledWith({ text: "", threadId: "thread-1", promoteItemId: "q-1" });
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(2);
  });

  it("shows a child's result or an event as running next, with Cancel and no Send now", () => {
    queueStateRef.current = {
      ...queueState("followup"),
      pendingIds: ["q-1", "q-2"],
      pending: [
        { id: "q-1", text: "Found two defects.", signal: { type: "child.settled" }, midTurn: true },
        { id: "q-2", text: "A new comment.", signal: { type: "event.matched" }, midTurn: true },
      ],
    };
    renderComposer("streaming", [], 2);

    expect(screen.getByText("Task result")).toBeTruthy();
    expect(screen.getByText("Event")).toBeTruthy();
    expect(screen.getAllByText("Runs next")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(2);
  });

  it("shows the server's corrective text when a cancel is refused", async () => {
    cancelQueuedMutateAsync.mockRejectedValueOnce(
      new ApiError(409, "POST /threads/thread-1/queue/q-1/cancel → 409", {
        error: "This message is no longer queued. If it started, select Stop to end it.",
      }),
    );
    queueStateRef.current = { ...queueState("followup"), pendingIds: ["q-1"] };
    renderComposer("streaming", [], 1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("This message is no longer queued. If it started, select Stop to end it.")).toBeTruthy();
    expect(screen.queryByText(/→ 409/)).toBeNull();
  });

  it("counts pending items when the live queue state is not loaded", () => {
    renderComposer("streaming", [], 2);
    expect(screen.getByRole("status").textContent).toBe("2 queued messages are waiting.");
  });
});

describe("Composer — compact layout", () => {
  it("expands on input focus and collapses when the empty composer loses focus", () => {
    renderComposer();
    const input = screen.getByRole("textbox", { name: "Message" });
    const form = input.closest("form");
    expect(form?.dataset.expanded).toBe("false");
    act(() => input.focus());
    expect(form?.dataset.expanded).toBe("true");
    act(() => input.blur());
    expect(form?.dataset.expanded).toBe("false");
  });

  it("keeps its layout when focus moves from the input to an action", () => {
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");
    const input = screen.getByRole("textbox", { name: "Message" });
    const stop = screen.getByRole("button", { name: "Stop" });
    act(() => stop.focus());
    expect(input.closest("form")?.dataset.expanded).toBe("false");
    act(() => input.focus());
    act(() => stop.focus());
    expect(input.closest("form")?.dataset.expanded).toBe("true");
    act(() => stop.blur());
    expect(input.closest("form")?.dataset.expanded).toBe("false");
  });

  it("focuses pointer-activated actions before the textarea can blur", () => {
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");
    const input = screen.getByRole("textbox", { name: "Message" });
    const stop = screen.getByRole("button", { name: "Stop" });
    act(() => input.focus());
    expect(fireEvent.mouseDown(stop, { button: 0 })).toBe(false);
    expect(document.activeElement).toBe(stop);
    expect(input.closest("form")?.dataset.expanded).toBe("true");
    act(() => stop.blur());
    expect(input.closest("form")?.dataset.expanded).toBe("false");
  });

  // A press on a card above the composer blurs it on pointerdown. Collapsing
  // then moved the card, so the release missed the button and the first
  // click on "Approve step" did nothing.
  it("stays expanded through a press outside, then collapses after its click", async () => {
    renderComposer();
    const input = screen.getByRole("textbox", { name: "Message" });
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => input.focus());
    fireEvent.pointerDown(outside);
    act(() => input.blur());
    expect(input.closest("form")?.dataset.expanded).toBe("true");
    fireEvent.pointerUp(outside);
    await waitFor(() => expect(input.closest("form")?.dataset.expanded).toBe("false"));
    outside.remove();
  });

  // A press on the hint text under the field moved focus to the page, so
  // the next keystrokes went nowhere.
  it("keeps focus in the message field when the box's hint text is pressed", () => {
    renderComposer();
    const input = screen.getByRole("textbox", { name: "Message" });
    act(() => input.focus());
    const hint = screen.getByText(/Shift\+Enter for a new line/);
    expect(fireEvent.mouseDown(hint, { button: 0 })).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.closest("form")?.dataset.expanded).toBe("true");
  });

  it("keeps a draft expanded after blur, then collapses when the draft is cleared", () => {
    renderComposer();
    const input = screen.getByRole("textbox", { name: "Message" });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "A draft" } });
    act(() => input.blur());
    expect(input.closest("form")?.dataset.expanded).toBe("true");
    act(() => useComposerDraftStore.getState().setText(draftKey("orchestrator:user-1", "thread-1"), ""));
    expect(input.closest("form")?.dataset.expanded).toBe("false");
  });

  it("collapses when a focused action disappears after the agent stops", async () => {
    queueStateRef.current = queueState("followup");
    const view = renderComposer("streaming");
    const input = screen.getByRole("textbox", { name: "Message" });
    act(() => input.focus());
    act(() => screen.getByRole("button", { name: "Stop" }).focus());
    queueStateRef.current = undefined;
    view.rerenderComposer("idle");
    await waitFor(() => expect(input.closest("form")?.dataset.expanded).toBe("false"));
  });

  it("stays expanded while sending and restores input focus after the draft clears", () => {
    const view = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message" });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "Send this draft" } });
    sendState.pending = true;
    view.rerenderComposer();
    fireEvent.blur(input);
    act(() => useComposerDraftStore.getState().clear(draftKey("orchestrator:user-1", "thread-1")));
    expect(input.closest("form")?.dataset.expanded).toBe("true");
    sendState.pending = false;
    view.rerenderComposer();
    expect(document.activeElement).toBe(input);
    expect(input.closest("form")?.dataset.expanded).toBe("true");
    act(() => input.blur());
    expect(input.closest("form")?.dataset.expanded).toBe("false");
  });

  it("expands for intake errors and collapses when they are dismissed", () => {
    renderComposer();
    const input = screen.getByRole("textbox", { name: "Message" });
    const key = draftKey("orchestrator:user-1", "thread-1");
    act(() => useComposerDraftStore.getState().setFileErrors(key, ["Choose a smaller file."]));
    expect(input.closest("form")?.dataset.expanded).toBe("true");
    expect(screen.getByText("Choose a smaller file.")).toBeDefined();
    act(() => useComposerDraftStore.getState().setFileErrors(key, []));
    expect(input.closest("form")?.dataset.expanded).toBe("false");
  });
});

describe("Composer — prefill consumption", () => {
  it("seeds the textarea from the prefill store and clears the store", () => {
    useComposerPrefillStore.getState().set("Update memory file journal/2026-07-13.md: ");
    renderComposer();

    const textarea = screen.getByPlaceholderText(/Send a message/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Update memory file journal/2026-07-13.md: ");
    expect(useComposerPrefillStore.getState().text).toBeNull();
  });

  it("starts empty when nothing was prefilled", () => {
    useComposerPrefillStore.setState({ text: null });
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Send a message/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });
});

describe("Composer — stop button", () => {
  it("shows Send (not Stop) while idle", () => {
    useComposerPrefillStore.setState({ text: null });
    renderComposer("idle");
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
    expect(screen.getByRole("button", { name: /send/i })).toBeDefined();
  });

  it("shows Stop next to the submit button while the agent works, and aborts the active thread on click", async () => {
    useComposerPrefillStore.setState({ text: null });
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");

    // "Send" is an idle-only label — a mid-turn message steers or queues.
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
    const stopButton = screen.getByRole("button", { name: /stop/i }) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);

    await userEvent.click(stopButton);
    expect(abortMutateAsync).toHaveBeenCalledWith({ threadId: "thread-1", targetItemId: "q-0" });
  });

  it("shows a failed Stop request and allows retry", async () => {
    queueStateRef.current = queueState("followup");
    abortMutateAsync.mockRejectedValueOnce(new Error("connection lost"));
    renderComposer("streaming");
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("connection lost");
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  // The reload-mid-tool case: the live `status` events were missed (the
  // client connected after they fired), so `agentStatus` still reads idle,
  // but the durable queue state says a submission is running. The Stop
  // button must key off the queue too — the agent holds the execution
  // context for the whole turn, not just while transition events flow.
  it("shows Stop while the queue reports a running turn, even with agentStatus idle", async () => {
    useComposerPrefillStore.setState({ text: null });
    queueStateRef.current = queueState("followup");
    const { default: userEvent } = await import("@testing-library/user-event");
    renderComposer("idle");

    const stopButton = screen.getByRole("button", { name: /stop/i }) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);

    await userEvent.click(stopButton);
    expect(abortMutateAsync).toHaveBeenCalledWith({ threadId: "thread-1", targetItemId: "q-0" });
  });

  it("shows Stop while the queue is blocked on a decision gate", () => {
    useComposerPrefillStore.setState({ text: null });
    queueStateRef.current = {
      mode: "followup",
      status: "blocked_on_decision_gate",
      activeItemId: "q-0",
      pendingIds: [],
      collectingIds: [],
      blockedGateId: "gate-1",
    };
    renderComposer("idle");
    expect(screen.getByRole("button", { name: /stop/i })).toBeDefined();
  });

  it("offers an actionable Run queue control when busy work has no active Stop target", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = {
      mode: "followup",
      status: "queued",
      activeItemId: undefined,
      pendingIds: ["q-9"],
      collectingIds: [],
    };
    renderComposer("idle");

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    const run = screen.getByRole("button", { name: "Run queued messages" }) as HTMLButtonElement;
    expect(run.disabled).toBe(false);

    await userEvent.click(run);
    expect(resumeMutateAsync).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(abortMutateAsync).not.toHaveBeenCalled();
  });
  it("explains that a collecting-only buffer waits and cannot be stopped", () => {
    queueStateRef.current = {
      mode: "collect",
      status: "idle",
      activeItemId: undefined,
      pendingIds: [],
      collectingIds: ["q-collect"],
      collectDeadline: Date.now() + 5_000,
    };
    renderComposer("idle");

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run queued messages" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(
      /Collecting 1 message; they run together in about \d+ seconds\. The collection cannot be stopped\./,
    );
  });

  it("says Stop affects only the active message when collecting alongside it", () => {
    queueStateRef.current = {
      mode: "collect",
      status: "running",
      activeItemId: "q-active",
      pendingIds: [],
      collectingIds: ["q-collect"],
      collectDeadline: Date.now() + 5_000,
    };
    renderComposer("idle");

    expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
    expect(screen.getByRole("status").textContent).toMatch(
      /Collecting 1 message; they run together in about \d+ seconds\. Stop affects only the active message\./,
    );
  });
});

describe("Composer — Escape interrupts the running turn", () => {
  it("does not interrupt a mounted chat while Tasks or Make is active", () => {
    queueStateRef.current = queueState("followup");
    const client = new QueryClient();
    const tree = (active: boolean) => <QueryClientProvider client={client}>
      <Composer sessionId="orchestrator:user-1" threadId="thread-1" agentStatus="streaming" active={active} />
    </QueryClientProvider>;
    const { rerender } = render(tree(false));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(abortMutate).not.toHaveBeenCalled();
    rerender(tree(true));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(abortMutate).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    abortMutate.mockClear();
    useComposerPrefillStore.setState({ text: null });
  });

  it("aborts the active thread on Escape while the agent is busy", () => {
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(abortMutate).toHaveBeenCalledTimes(1);
    expect(abortMutate.mock.calls[0][0]).toEqual({ threadId: "thread-1", targetItemId: "q-0" });
  });

  it("shows a failed Escape interrupt", () => {
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");
    fireEvent.keyDown(document.body, { key: "Escape" });
    act(() => abortMutate.mock.calls[0][1].onError(new Error("connection lost")));
    expect(screen.getByRole("alert").textContent).toContain("connection lost");
  });

  it("keeps a delayed interrupt failure with its original thread", () => {
    queueStateRef.current = queueState("followup");
    const view = renderComposer("streaming");
    fireEvent.keyDown(document.body, { key: "Escape" });
    const reject = abortMutate.mock.calls[0][1].onError;
    view.rerenderComposer("idle", "thread-2");
    act(() => reject(new Error("Thread one connection lost")));
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerenderComposer("streaming", "thread-1");
    expect(screen.getByRole("alert").textContent).toContain("Thread one connection lost");
  });

  it("does nothing on Escape while idle", () => {
    renderComposer("idle");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(abortMutate).not.toHaveBeenCalled();
  });

  // Same durable-queue fallback as the Stop button: Escape must interrupt
  // whenever the agent holds the execution context, including after a
  // reload that missed the live status events.
  it("aborts on Escape while the queue reports a running turn, even with agentStatus idle", () => {
    queueStateRef.current = queueState("followup");
    renderComposer("idle");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(abortMutate).toHaveBeenCalledTimes(1);
    expect(abortMutate.mock.calls[0][0]).toEqual({ threadId: "thread-1", targetItemId: "q-0" });
  });

  it("skips an Escape already claimed by another layer (defaultPrevented)", () => {
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");
    // Simulate a higher-priority dismissal (e.g. ChildPanel close) that
    // claims the event in the capture phase before the interrupt listener.
    const claim = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", claim, { capture: true });
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", claim, { capture: true });
    expect(abortMutate).not.toHaveBeenCalled();
  });

  it("dismisses an open command popup instead of aborting", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");
    // Mid-turn the placeholder names the queue/steer action, not "Send a
    // message" — address the textarea by role so this stays about Escape.
    const textarea = screen.getByRole("textbox");
    await userEvent.type(textarea, "/sta");
    expect(screen.getByRole("listbox")).toBeTruthy();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(abortMutate).not.toHaveBeenCalled();
  });
});

/**
 * Mid-turn Enter always queues (`followup`), even when the thread default
 * is `steer`. After a self-queued item, an empty Enter promotes that item.
 */
describe("Composer — mid-turn submit affordance", () => {
  async function type(text: string) {
    const { default: userEvent } = await import("@testing-library/user-event");
    const textarea = screen.getByRole("textbox");
    await userEvent.type(textarea, text);
  }

  it("labels the button Send while the agent is idle", () => {
    renderComposer("idle");
    expect(screen.getByRole("button", { name: /^send$/i })).toBeDefined();
  });

  it("labels the button Queue while the agent works and nothing is self-queued", () => {
    queueStateRef.current = queueState("steer");
    renderComposer("streaming");

    expect(screen.getByRole("button", { name: /^queue$/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^steer$/i })).toBeNull();
  });

  it("labels the button Queue in followup mode before the first queued item", () => {
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");

    expect(screen.getByRole("button", { name: /^queue$/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^steer$/i })).toBeNull();
  });

  it("falls back to Queue when the queue mode is not known yet", () => {
    queueStateRef.current = undefined;
    renderComposer("streaming");

    expect(screen.getByRole("button", { name: /^queue$/i })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^steer$/i })).toBeNull();
  });

  it("falls back to Queue in collect mode, where the message waits for the window", () => {
    queueStateRef.current = queueState("collect");
    renderComposer("streaming");

    expect(screen.getByRole("button", { name: /^queue$/i })).toBeDefined();
  });

  it("queues a mid-turn message for the running turn's next step", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = queueState("steer");
    renderComposer("streaming");

    await type("also update the runbook");
    await userEvent.click(screen.getByRole("button", { name: /^queue$/i }));
    await waitFor(() =>
      expect(sendMutateAsync).toHaveBeenCalledWith({
        text: "also update the runbook",
        threadId: "thread-1",
        queueMode: "inject",
      }),
    );
    expect(addUserMessage).toHaveBeenCalled();
    expect(setMessageQueueItemId).toHaveBeenCalledWith(
      "orchestrator:user-1",
      "user-opt-1",
      "q-1",
    );
  });

  it("labels the button Steer after a self-queued item and an empty composer", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = queueState("steer");
    renderComposer("streaming");

    await type("follow after this turn");
    await userEvent.click(screen.getByRole("button", { name: /^queue$/i }));
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: /^steer$/i })).toBeDefined();
    expect(screen.getByText(/queued for the next step\. press enter again/i)).toBeDefined();
  });

  it("promotes the queued item on empty Enter and does not add a second bubble", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    sendMutateAsync
      .mockResolvedValueOnce({ messageId: "q-1", threadId: "thread-1" })
      .mockResolvedValueOnce({ messageId: "q-2", threadId: "thread-1" });
    queueStateRef.current = queueState("steer");
    renderComposer("streaming");

    await type("follow after this turn");
    await userEvent.click(screen.getByRole("button", { name: /^queue$/i }));
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalledTimes(1));
    addUserMessage.mockClear();

    await userEvent.click(screen.getByRole("button", { name: /^steer$/i }));
    await waitFor(() =>
      expect(sendMutateAsync).toHaveBeenCalledWith({
        text: "",
        threadId: "thread-1",
        promoteItemId: "q-1",
      }),
    );
    expect(addUserMessage).not.toHaveBeenCalled();
    expect(setMessageQueueItemId).toHaveBeenCalledWith(
      "orchestrator:user-1",
      "user-opt-1",
      "q-2",
    );
  });

  it("queues another followup when the composer has new text after a queued item", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");

    await type("first followup");
    await userEvent.click(screen.getByRole("button", { name: /^queue$/i }));
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalledTimes(1));

    await type("second followup");
    expect(screen.getByRole("button", { name: /^queue$/i })).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: /^queue$/i }));
    await waitFor(() =>
      expect(sendMutateAsync).toHaveBeenLastCalledWith({
        text: "second followup",
        threadId: "thread-1",
        queueMode: "inject",
      }),
    );
  });

  it("keeps the submit button disabled while the agent works and the box is empty", () => {
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");
    const queueButton = screen.getByRole("button", { name: /^queue$/i }) as HTMLButtonElement;
    expect(queueButton.disabled).toBe(true);
  });

  it("omits queueMode on an idle Send", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    renderComposer("idle");

    await type("hello from idle");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() =>
      expect(sendMutateAsync).toHaveBeenCalledWith({
        text: "hello from idle",
        threadId: "thread-1",
      }),
    );
    expect(sendMutateAsync.mock.calls[0][0]).not.toHaveProperty("queueMode");
  });

  it("disarms Steer when the self-queued item is claimed or leaves the queue", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = queueState("steer");
    const { rerenderComposer } = renderComposer("streaming");

    await type("follow after this turn");
    await userEvent.click(screen.getByRole("button", { name: /^queue$/i }));
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /^steer$/i })).toBeDefined();

    queueStateRef.current = { ...queueState("steer"), pendingIds: ["q-1"] };
    rerenderComposer();
    expect(screen.getByRole("button", { name: /^steer$/i })).toBeDefined();

    queueStateRef.current = { ...queueState("steer"), activeItemId: "q-1", pendingIds: [] };
    rerenderComposer();
    expect(screen.queryByRole("button", { name: /^steer$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^queue$/i })).toBeDefined();
  });

  it("disarms Steer when a canceled item was listed before the send resolved", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = queueState("steer");
    const { rerenderComposer } = renderComposer("streaming");

    // The queue update that lists q-1 arrives before POST /messages resolves.
    queueStateRef.current = { ...queueState("steer"), pendingIds: ["q-1"] };
    await type("follow after this turn");
    await userEvent.click(screen.getByRole("button", { name: /^queue$/i }));
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /^steer$/i })).toBeDefined();

    // Cancel removes q-1 from the queue.
    queueStateRef.current = { ...queueState("steer"), pendingIds: [] };
    rerenderComposer();
    expect(screen.queryByRole("button", { name: /^steer$/i })).toBeNull();
    expect(screen.queryByText(/queued\. press enter again/i)).toBeNull();
  });

  it("shows the API error when promote fails", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    sendMutateAsync
      .mockResolvedValueOnce({ messageId: "q-1", threadId: "thread-1" })
      .mockRejectedValueOnce(
        new ApiError(400, "That message is no longer queued.", {
          error: "That message is no longer queued. Send a new message, or wait for the current turn to finish.",
        }),
      );
    queueStateRef.current = queueState("steer");
    renderComposer("streaming");

    await type("follow after this turn");
    await userEvent.click(screen.getByRole("button", { name: /^queue$/i }));
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: /^steer$/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/no longer queued/i),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/send a new message/i);
  });
});

describe("composer focus request", () => {
  it("focuses the input when requestFocus fires (New thread button handoff)", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Send a message/) as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(textarea);
    act(() => {
      useComposerPrefillStore.getState().requestFocus();
    });
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });
});

describe("Composer beside the Ask Valet dock", () => {
  function renderPageAndDock({ status = "streaming", dockSession = "orchestrator:user-1", pageThread = "page", dockThread = "dock", withPage = true }: {
    status?: "idle" | "streaming"; dockSession?: string; pageThread?: string; dockThread?: string; withPage?: boolean;
  } = {}) {
    const queryClient = new QueryClient();
    const tree = (page: boolean, thread = pageThread) => <QueryClientProvider client={queryClient}>
      {page && <main><Composer sessionId="orchestrator:user-1" threadId={thread} agentStatus={status} queuedMessages={[]} queuedItemCount={0} /></main>}
      <aside data-ask-valet-dock=""><Composer sessionId={dockSession} threadId={dockThread} agentStatus={status} queuedMessages={[]} queuedItemCount={0} /></aside>
    </QueryClientProvider>;
    const view = render(tree(withPage));
    const inputs = () => screen.getAllByRole("textbox", { name: "Message" }) as HTMLTextAreaElement[];
    return { page: inputs()[0]!, dock: inputs().at(-1)!, inputs, rerender: (page = withPage, thread = pageThread) => view.rerender(tree(page, thread)) };
  }

  it("ends a recall in both composers when either one edits the shared draft", () => {
    streamMessagesRef.current = [
      { id: "m1", sessionId: "orchestrator:user-1", threadId: "same", role: "user", content: "first prompt", parts: [], createdAt: 1, author: { id: "user-1", interactive: true } },
      { id: "m2", sessionId: "orchestrator:user-1", threadId: "same", role: "user", content: "continue", parts: [], createdAt: 2, author: { id: "user-1", interactive: true } },
    ];
    const { page, dock } = renderPageAndDock({ status: "idle", pageThread: "same", dockThread: "same" });
    fireEvent.keyDown(page, { key: "ArrowUp" });
    expect(dock.value).toBe("continue");

    // The dock's edit is a fresh draft that happens to match the recall.
    fireEvent.change(dock, { target: { value: "" } });
    fireEvent.change(dock, { target: { value: "continue" } });
    fireEvent.keyDown(page, { key: "ArrowUp" });
    expect(page.value).toBe("continue");
    fireEvent.keyDown(page, { key: "ArrowDown" });
    expect(page.value).toBe("continue");
  });

  it("leaves a page focus request to the page's composer", async () => {
    const { page } = renderPageAndDock();
    act(() => useComposerPrefillStore.getState().requestFocus());
    await waitFor(() => expect(document.activeElement).toBe(page));
  });

  it("stops the turn of the composer area that holds focus on Escape", () => {
    queueStateRef.current = queueState("followup");
    const { page, dock } = renderPageAndDock();
    abortMutate.mockClear();
    fireEvent.keyDown(dock, { key: "Escape" });
    expect(abortMutate.mock.calls.map(([target]) => target.threadId)).toEqual(["dock"]);
    abortMutate.mockClear();
    fireEvent.keyDown(page, { key: "Escape" });
    expect(abortMutate.mock.calls.map(([target]) => target.threadId)).toEqual(["page"]);
  });

  it("stops the page's turn first when focus is on the body", () => {
    queueStateRef.current = queueState("followup");
    const { rerender } = renderPageAndDock();
    // Opening another thread registers the page's listener after the dock's.
    rerender(true, "page-2");
    abortMutate.mockClear();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(abortMutate.mock.calls.map(([target]) => target.threadId)).toEqual(["page-2"]);
  });

  it("returns focus after a send from a composer that was never focused", async () => {
    const { page, dock, rerender } = renderPageAndDock({ status: "idle", dockSession: "orchestrator:dock" });
    act(() => dock.focus());
    act(() => useComposerDraftStore.getState().setText(draftKey("orchestrator:user-1", "page"), "Try this in chat"));
    act(() => dock.blur());
    await act(async () => fireEvent.click(within(page.closest("form")!).getByRole("button", { name: "Send" })));
    sendState.pending = true;
    sendState.sessions = ["orchestrator:user-1"];
    rerender();
    sendState.pending = false;
    rerender();
    expect(document.activeElement).toBe(page);
  });

  it("keeps the failed message and newer dock text when a send of the same thread fails", async () => {
    let fail: (error: Error) => void = () => undefined;
    sendMutateAsync.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const slot = draftKey("orchestrator:user-1", "shared");
    const { page, dock } = renderPageAndDock({ status: "idle", pageThread: "shared", dockThread: "shared" });
    act(() => useComposerDraftStore.getState().setFiles(slot, [{ id: "f1", name: "report.csv", bytes: 3, file: new File(["a,b"], "report.csv"), attachmentRef: "ref-1" }]));
    fireEvent.change(page, { target: { value: "first question" } });
    fireEvent.keyDown(page, { key: "Enter" });
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalledTimes(1));
    fireEvent.change(dock, { target: { value: "new unsent text" } });
    await act(async () => fail(new Error("connection lost")));
    expect(dock.value).toBe("first question\n\nnew unsent text");
    expect(useComposerDraftStore.getState().byKey[slot]?.files.map(file => file.name)).toEqual(["report.csv"]);
  });

  it("leaves focus in the dock when a page send settles", () => {
    const { page, dock, rerender } = renderPageAndDock({ status: "idle", dockSession: "orchestrator:dock" });
    act(() => page.focus());
    sendState.pending = true;
    sendState.sessions = ["orchestrator:user-1"];
    rerender();
    act(() => dock.focus());
    sendState.pending = false;
    rerender();
    expect(document.activeElement).toBe(dock);
  });

  it("restores a failed send when the slot holds only an attachment error", async () => {
    let fail: (error: Error) => void = () => undefined;
    sendMutateAsync.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const { page } = renderPageAndDock({ status: "idle", pageThread: "shared", dockThread: "shared" });
    fireEvent.change(page, { target: { value: "first question" } });
    fireEvent.keyDown(page, { key: "Enter" });
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalledTimes(1));
    act(() => useComposerDraftStore.getState().setImageErrors(draftKey("orchestrator:user-1", "shared"), ["That image is too large."]));
    await act(async () => fail(new Error("connection lost")));
    expect(page.value).toBe("first question");
  });

  it("returns focus to the composer used last when sends overlap", () => {
    const { page, dock, rerender } = renderPageAndDock({ status: "idle", dockSession: "orchestrator:dock" });
    act(() => page.focus());
    sendState.pending = true;
    sendState.sessions = ["orchestrator:user-1"];
    rerender();
    act(() => dock.focus());
    // A disabled input drops focus to the body. jsdom does not, so blur first.
    act(() => dock.blur());
    sendState.sessions = ["orchestrator:user-1", "orchestrator:dock"];
    rerender();
    sendState.sessions = ["orchestrator:dock"];
    rerender();
    sendState.pending = false;
    rerender();
    expect(document.activeElement).toBe(dock);
  });

  it("keeps a body Escape with the page while the page's stop is pending", () => {
    queueStateRef.current = queueState("followup");
    const { rerender } = renderPageAndDock({ dockSession: "orchestrator:dock" });
    abortMutate.mockClear();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(abortMutate.mock.calls.map(([target]) => target.threadId)).toEqual(["page"]);
    abortState.sessions = ["orchestrator:user-1"];
    rerender();
    abortMutate.mockClear();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(abortMutate).not.toHaveBeenCalled();
  });

  it("stops the dock's turn on Escape from a page control when the page has no composer", () => {
    queueStateRef.current = queueState("followup");
    renderPageAndDock({ withPage: false });
    const control = document.body.appendChild(document.createElement("button"));
    act(() => control.focus());
    abortMutate.mockClear();
    fireEvent.keyDown(control, { key: "Escape" });
    control.remove();
    expect(abortMutate.mock.calls.map(([target]) => target.threadId)).toEqual(["dock"]);
  });

  it("returns focus to the page composer after Send now settles", () => {
    const queryClient = new QueryClient();
    const queued: StreamMessage[] = [{ id: "message-1", sessionId: "orchestrator:user-1", threadId: "page", role: "user",
      content: "Queued question", parts: [], createdAt: 1, queueItemId: "q-1" }];
    const tree = () => <QueryClientProvider client={queryClient}>
      <main><Composer sessionId="orchestrator:user-1" threadId="page" agentStatus="streaming" queuedMessages={queued} queuedItemCount={1} /></main>
      <aside data-ask-valet-dock=""><Composer sessionId="orchestrator:dock" threadId="dock" agentStatus="idle" queuedMessages={[]} queuedItemCount={0} /></aside>
    </QueryClientProvider>;
    const view = render(tree());
    const [page, dock] = screen.getAllByRole("textbox", { name: "Message" }) as HTMLTextAreaElement[];
    act(() => page!.focus());
    act(() => dock!.focus());
    act(() => dock!.blur());
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    sendState.pending = true;
    sendState.sessions = ["orchestrator:user-1"];
    view.rerender(tree());
    sendState.pending = false;
    view.rerender(tree());
    expect(document.activeElement).toBe(page);
  });

  it("leaves a pending memory prefill to the page composer that mounts after the dock", () => {
    act(() => useComposerPrefillStore.getState().set("Update memory file private.md: "));
    const { rerender, inputs } = renderPageAndDock({ status: "idle", withPage: false });
    expect(inputs()[0]!.value).toBe("");
    rerender(true);
    expect(inputs()[0]!.value).toBe("Update memory file private.md: ");
  });
});

describe("Composer — slash-command keyboard handling", () => {
  it("pressing Enter while popup is open inserts the command and does not send", async () => {
    useComposerPrefillStore.setState({ text: null });
    const { default: userEvent } = await import("@testing-library/user-event");
    renderComposer();

    const textarea = screen.getByPlaceholderText(/Send a message/i) as HTMLTextAreaElement;
    await userEvent.type(textarea, "/sta");
    // Popup should be visible (listbox role).
    expect(screen.getByRole("listbox")).toBeTruthy();

    await userEvent.keyboard("{Enter}");
    // The selected command "status" (first prefix match) is inserted with trailing space.
    // If Enter had sent instead, the textarea would have been cleared to "".
    expect(textarea.value).toBe("/status ");
  });

  it("matches commands by substring, so a skill surfaces without its namespace", async () => {
    useComposerPrefillStore.setState({ text: null });
    const { default: userEvent } = await import("@testing-library/user-event");
    renderComposer();

    const textarea = screen.getByPlaceholderText(/Send a message/i) as HTMLTextAreaElement;
    // "review" is not a prefix of any command name; "skill:review" contains it.
    await userEvent.type(textarea, "/review");
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByText("/skill:review")).toBeTruthy();

    await userEvent.keyboard("{Enter}");
    expect(textarea.value).toBe("/skill:review ");
  });

  it("matches command names case-insensitively", async () => {
    useComposerPrefillStore.setState({ text: null });
    const { default: userEvent } = await import("@testing-library/user-event");
    renderComposer();

    const textarea = screen.getByPlaceholderText(/Send a message/i) as HTMLTextAreaElement;
    await userEvent.type(textarea, "/REVIEW");
    expect(screen.getByText("/skill:review")).toBeTruthy();
  });

  it("ranks a prefix match ahead of a substring match", async () => {
    useComposerPrefillStore.setState({ text: null });
    const { default: userEvent } = await import("@testing-library/user-event");
    renderComposer();

    const textarea = screen.getByPlaceholderText(/Send a message/i) as HTMLTextAreaElement;
    // "top" prefix-matches "top" and substring-matches "stop". "stop" comes
    // first in registry order, so only the prefix-first sort puts "top" on top.
    await userEvent.type(textarea, "/top");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("/top"),
      expect.stringContaining("/stop"),
    ]);

    await userEvent.keyboard("{Enter}");
    expect(textarea.value).toBe("/top ");
  });

  it("an exact-name match outranks a recently used substring match", async () => {
    useComposerPrefillStore.setState({ text: null });
    const { default: userEvent } = await import("@testing-library/user-event");
    // The user sent /stop recently. Typing the full name "top" must still
    // put /top first — match tier beats recency in commandsToItems.
    window.localStorage.setItem(
      "valet-command-recency",
      JSON.stringify({ stop: Date.now() }),
    );
    try {
      renderComposer();
      const textarea = screen.getByPlaceholderText(/Send a message/i) as HTMLTextAreaElement;
      await userEvent.type(textarea, "/top");
      const options = screen.getAllByRole("option");
      expect(options.map((o) => o.textContent)).toEqual([
        expect.stringContaining("/top"),
        expect.stringContaining("/stop"),
      ]);
      await userEvent.keyboard("{Enter}");
      expect(textarea.value).toBe("/top ");
    } finally {
      window.localStorage.removeItem("valet-command-recency");
    }
  });

  it("pressing Esc while popup is open closes the popup without modifying text", async () => {
    useComposerPrefillStore.setState({ text: null });
    const { default: userEvent } = await import("@testing-library/user-event");
    renderComposer();

    const textarea = screen.getByPlaceholderText(/Send a message/i) as HTMLTextAreaElement;
    await userEvent.type(textarea, "/sta");
    expect(screen.getByRole("listbox")).toBeTruthy();

    await userEvent.keyboard("{Escape}");
    // Popup unmounted — listbox gone.
    expect(screen.queryByRole("listbox")).toBeNull();
    // Text is unchanged — no trailing space artifact.
    expect(textarea.value).toBe("/sta");
  });

  it("enumerable arguments get typeahead after the command token", async () => {
    useComposerPrefillStore.setState({ text: null });
    const { default: userEvent } = await import("@testing-library/user-event");
    renderComposer();

    const textarea = screen.getByPlaceholderText(/Send a message/i) as HTMLTextAreaElement;
    await userEvent.type(textarea, "/model ");
    // Argument mode: both model ids listed.
    expect(screen.getByText("claude-opus-4-8")).toBeTruthy();
    expect(screen.getByText("claude-haiku-4-5")).toBeTruthy();

    // Prefix filter narrows to one; Enter fills it without sending.
    await userEvent.type(textarea, "claude-o");
    expect(screen.queryByText("claude-haiku-4-5")).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(textarea.value).toBe("/model claude-opus-4-8 ");
  });

  it("free-text arguments show the argHint as a passive notice", async () => {
    useComposerPrefillStore.setState({ text: null });
    const { default: userEvent } = await import("@testing-library/user-event");
    renderComposer();

    const textarea = screen.getByPlaceholderText(/Send a message/i) as HTMLTextAreaElement;
    await userEvent.type(textarea, "/compact ");
    expect(screen.getByTestId("popup-notice").textContent).toBe("[instructions]");
    // No selectable rows — Enter must send, not select. (Send path clears the box.)
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

describe("Composer — reply target", () => {
  it("shows and cancels the immutable quote chip", () => {
    const onCancelReply = vi.fn();
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <Composer
          sessionId="orchestrator:user-1"
          threadId="thread-1"
          agentStatus="idle"
          replyTarget={{ messageId: "assistant-7", excerpt: "Use the blue deployment." }}
          onCancelReply={onCancelReply}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Replying to Assistant")).toBeTruthy();
    expect(screen.getByText("Use the blue deployment.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(onCancelReply).toHaveBeenCalledOnce();
  });

  it("submits the stable target id and mirrors the quote optimistically", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <Composer
          sessionId="orchestrator:user-1"
          threadId="thread-1"
          agentStatus="idle"
          replyTarget={{ messageId: "assistant-7", excerpt: "Use the blue deployment." }}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "What about staging?" },
    });
    fireEvent.submit(screen.getByRole("textbox", { name: "Message" }).closest("form")!);

    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalled());
    expect(sendMutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      text: "What about staging?",
      threadId: "thread-1",
      replyToMessageId: "assistant-7",
    }));
    expect(addUserMessage).toHaveBeenCalledWith(
      "orchestrator:user-1",
      "What about staging?",
      "thread-1",
      undefined,
      { messageId: "assistant-7", excerpt: "Use the blue deployment." },
    );
  });
});

describe("Composer — edit target", () => {
  const target = { messageId: "user-3", text: "deploy to prod", images: [], droppedFiles: 0 };
  function renderEditing(props: Partial<Parameters<typeof Composer>[0]> = {}, agentStatus: "idle" | "streaming" = "idle") {
    const queryClient = new QueryClient();
    const tree = (extra: Partial<Parameters<typeof Composer>[0]>) => (
      <QueryClientProvider client={queryClient}>
        <Composer sessionId="orchestrator:user-1" threadId="thread-1" agentStatus={agentStatus} {...extra} />
      </QueryClientProvider>
    );
    const view = render(tree(props));
    return Object.assign(view, { rerenderWith: (extra: Partial<Parameters<typeof Composer>[0]>) => view.rerender(tree(extra)) });
  }

  it("puts the message text in the box and gives the earlier draft back on cancel", () => {
    useComposerDraftStore.getState().setText(draftKey("orchestrator:user-1", "thread-1"), "half-typed thought");
    const onCancelEdit = vi.fn();
    const view = renderEditing({ editTarget: target, onCancelEdit });

    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(box.value).toBe("deploy to prod");
    expect(screen.getByText("Editing your message")).toBeTruthy();
    expect(screen.getByText(/Send replaces this message and everything after it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(onCancelEdit).toHaveBeenCalledOnce();

    view.rerenderWith({ onCancelEdit });
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("half-typed thought");
  });

  it("says that Send stops a running reply, and sends instead of queueing", () => {
    renderEditing({ editTarget: target }, "streaming");
    expect(screen.getByText(/Send stops the current reply, then replaces/)).toBeTruthy();
    expect(screen.getByText(/Enter to send/)).toBeTruthy();
    expect(screen.queryByText(/Enter to queue/)).toBeNull();
  });

  it("cancels the edit on Escape instead of stopping the turn", () => {
    abortMutate.mockClear();
    queueStateRef.current = queueState("followup");
    const onCancelEdit = vi.fn();
    renderEditing({ editTarget: target, onCancelEdit }, "streaming");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Escape" });
    expect(onCancelEdit).toHaveBeenCalledOnce();
    expect(abortMutate).not.toHaveBeenCalled();
  });

  it("sends the edit with the edited entry id and no queue mode", async () => {
    queueStateRef.current = queueState("followup");
    const onEditSubmit = vi.fn();
    const onEditResult = vi.fn();
    renderEditing({ editTarget: target, onEditSubmit, onEditResult }, "streaming");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "deploy to staging" } });
    fireEvent.submit(screen.getByRole("textbox", { name: "Message" }).closest("form")!);

    await waitFor(() => expect(onEditResult).toHaveBeenCalledWith(true));
    expect(onEditSubmit).toHaveBeenCalledWith("user-3");
    const body = sendMutateAsync.mock.calls[0]?.[0];
    expect(body).toMatchObject({ text: "deploy to staging", threadId: "thread-1", editEntryId: "user-3" });
    expect(body).not.toHaveProperty("queueMode");
    expect(body).not.toHaveProperty("replyToMessageId");
  });

  it("reports a refused edit and keeps the edited text", async () => {
    sendMutateAsync.mockRejectedValueOnce(new ApiError(400, "Bad Request", { error: "Teammate wrote after this message, and an edit would remove that message. Branch into a new thread instead." }));
    const onEditResult = vi.fn();
    renderEditing({ editTarget: target, onEditResult });
    fireEvent.submit(screen.getByRole("textbox", { name: "Message" }).closest("form")!);

    await waitFor(() => expect(onEditResult).toHaveBeenCalledWith(false));
    expect(screen.getByText(/Teammate wrote after this message/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("deploy to prod");
  });

  it("previews what still stands and offers to undo the files, on by default", async () => {
    editPreviewRef.current = {
      turns: 3, actions: [{ label: "github.create_pull_request: Open the fix", count: 1, urls: [] }], moreActions: 0,
      grants: ["Always allow for me: Create a pull request"], files: ["app/a.txt", "app/b.txt"], pushed: false,
    };
    renderEditing({ editTarget: target, onEditResult: vi.fn() });
    expect(screen.getByText(/Send replaces this message and the 2 later turns/)).toBeTruthy();
    expect(screen.getByText(/Still standing after the edit: github.create_pull_request: Open the fix, Always allow for me: Create a pull request/)).toBeTruthy();
    const undo = screen.getByRole("checkbox");
    expect(undo.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Also undo file changes (2 files)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show files" }));
    expect(screen.getByText("app/b.txt")).toBeTruthy();
    fireEvent.submit(screen.getByRole("textbox", { name: "Message" }).closest("form")!);
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalled());
    expect(sendMutateAsync.mock.calls[0]?.[0]).toMatchObject({ editEntryId: "user-3", undoFiles: true });
  });

  it("leaves file undo off when the replaced turns pushed, and says why", () => {
    editPreviewRef.current = { turns: 1, actions: [], moreActions: 0, grants: [], files: ["app/a.txt"], pushed: true };
    renderEditing({ editTarget: target });
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/pushed commits or opened a pull request/)).toBeTruthy();
  });

  it("shows a refusal and keeps Send off", () => {
    editPreviewRef.current = { refusal: "Teammate wrote after this message.", turns: 0, actions: [], moreActions: 0, grants: [], files: [], pushed: false };
    renderEditing({ editTarget: target });
    expect(screen.getByRole("alert").textContent).toBe("Teammate wrote after this message.");
    expect((screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names files the edit cannot carry", () => {
    renderEditing({ editTarget: { ...target, droppedFiles: 2 } });
    expect(screen.getByText(/Attach its files again if the edit needs them/)).toBeTruthy();
  });
});

describe("Composer prompt recall", () => {
  function sent(id: string, content: string, threadId = "thread-1"): StreamMessage {
    return { id, sessionId: "orchestrator:user-1", threadId, role: "user", content, parts: [], createdAt: 1, author: { id: "user-1", interactive: true } };
  }

  it("steps through this thread's earlier prompts with Up and Down", () => {
    streamMessagesRef.current = [sent("m1", "first prompt"), sent("m2", "elsewhere", "thread-2"), sent("m3", "second prompt")];
    renderComposer();
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("second prompt");
    expect(box.selectionStart).toBe("second prompt".length);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("first prompt");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.value).toBe("second prompt");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.value).toBe("");
  });

  it("keeps a typed draft and an edited recall", () => {
    streamMessagesRef.current = [sent("m1", "first prompt")];
    renderComposer();
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    fireEvent.change(box, { target: { value: "my draft" } });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("my draft");

    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.change(box, { target: { value: "first prompt, fixed" } });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.value).toBe("first prompt, fixed");
  });

  it("steps past a recalled slash command without opening the command popup", async () => {
    streamMessagesRef.current = [sent("m1", "first prompt"), sent("m2", "/status")];
    renderComposer();
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("/status");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("first prompt");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ text: "/status" })));
  });

  it("opens the command popup again once a recalled command is edited", () => {
    streamMessagesRef.current = [sent("m1", "/status")];
    renderComposer();
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.change(box, { target: { value: "/st" } });
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("treats typed text that matches an earlier prompt as a draft after a recall is sent", async () => {
    streamMessagesRef.current = [sent("m1", "earlier prompt"), sent("m2", "continue")];
    renderComposer();
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("continue");
    fireEvent.keyDown(box, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ text: "continue" })));

    fireEvent.change(box, { target: { value: "continue" } });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("continue");
  });

  it("keeps a recall when a refetch rewrites its row as the skill command", () => {
    streamMessagesRef.current = [sent("m1", "first prompt"), sent("m2", "/review")];
    const { rerenderComposer } = renderComposer();
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("/review");

    streamMessagesRef.current = [sent("m1", "first prompt"), { ...sent("m2", "Review the change."), skill: { name: "review" } }];
    rerenderComposer();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("first prompt");
  });

  it("sends a recalled prompt as a new message", async () => {
    streamMessagesRef.current = [sent("m1", "rerun the report")];
    renderComposer();
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ text: "rerun the report", threadId: "thread-1" })));
  });
});

it("opens the destination returned by /fork after sending the command", async () => {
  sendMutateAsync.mockResolvedValueOnce({ messageId: null, threadId: "thread-1", fork: { id: "fork-thread", sessionId: "fork-session" } });
  renderComposer();
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "/fork keep going" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/threads/$threadId", params: { threadId: "fork-thread" } }));
  expect(sendMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ text: "/fork keep going", threadId: "thread-1" }));
});

it("keeps the source open when a fork command returns no destination", async () => {
  sendMutateAsync.mockResolvedValueOnce({ messageId: null, threadId: "thread-1" });
  renderComposer();
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "/fork" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(sendMutateAsync).toHaveBeenCalled());
  expect(navigate).not.toHaveBeenCalled();
});
