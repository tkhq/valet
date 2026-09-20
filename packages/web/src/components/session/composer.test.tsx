// @vitest-environment jsdom
/**
 * Composer-prefill consumption (decision 17): the memory doc pane sets
 * `useComposerPrefillStore` before navigating to `/chat`; the next
 * `Composer` mount must seed its textarea from that store exactly once and
 * leave the store empty afterward, so it doesn't leak into a later
 * mount/remount.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WireQueueState } from "@valet/api/wire";
import type { StreamMessage } from "~/stores/stream";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import { ApiError } from "~/api/client";
import { draftKey, useComposerDraftStore } from "~/stores/composer-drafts";

const abortMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const abortMutate = vi.fn();
const sendState = { pending: false };
const sendMutateAsync = vi.fn().mockResolvedValue({ messageId: "q-1", threadId: "thread-1" });
const addUserMessage = vi.fn(() => "user-opt-1");
const setMessageQueueItemId = vi.fn();

// Per-test queue state for the active thread. Held in a container so the
// hoisted `vi.mock` factory closes over a stable binding and each test can
// swap the value the composer reads.
const queueStateRef: { current: WireQueueState | undefined } = { current: undefined };

function queueState(mode: WireQueueState["mode"]): WireQueueState {
  return {
    mode,
    status: "running",
    activeItemId: "q-0",
    pendingIds: [],
    collectingIds: [],
  };
}

// importOriginal: see -new-session-dialog.test.tsx for why a bare
// replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSendPrompt: () => ({ isPending: sendState.pending, mutateAsync: sendMutateAsync }),
    useAbortThread: () => ({
      isPending: false,
      mutateAsync: abortMutateAsync,
      mutate: abortMutate,
    }),
  };
});

vi.mock("~/stores/stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/stores/stream")>();
  return {
    ...actual,
    useStreamStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ addUserMessage, setMessageQueueItemId }),
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
  const tree = (status: "idle" | "streaming") => (
    <QueryClientProvider client={queryClient}>
      <Composer
        sessionId="orchestrator:user-1"
        threadId="thread-1"
        agentStatus={status}
        queuedMessages={queuedMessages}
        queuedItemCount={queuedItemCount}
      />
    </QueryClientProvider>
  );
  const view = render(tree(agentStatus));
  return Object.assign(view, {
    rerenderComposer: (status: "idle" | "streaming" = agentStatus) => view.rerender(tree(status)),
  });
}

beforeEach(() => {
  queueStateRef.current = undefined;
  sendState.pending = false;
  useComposerPrefillStore.setState({ text: null });
  // Drafts live in a module-global store keyed by (session, thread) — the
  // same key across tests would leak one test's draft into the next.
  useComposerDraftStore.setState({ byKey: {} });
  sendMutateAsync.mockReset();
  sendMutateAsync.mockResolvedValue({ messageId: "q-1", threadId: "thread-1" });
  abortMutateAsync.mockClear();
  addUserMessage.mockClear();
  setMessageQueueItemId.mockClear();
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

  it("keeps unresolved pending items visible after reload", () => {
    queueStateRef.current = { ...queueState("followup"), pendingIds: ["q-1", "q-2"] };
    renderComposer("streaming", [], 2);

    expect(screen.getByRole("status").textContent).toBe("2 queued messages are waiting.");
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
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
    const view = renderComposer("streaming");
    const input = screen.getByRole("textbox", { name: "Message" });
    act(() => input.focus());
    act(() => screen.getByRole("button", { name: "Stop" }).focus());
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
    renderComposer("streaming");

    // "Send" is an idle-only label — a mid-turn message steers or queues.
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
    const stopButton = screen.getByRole("button", { name: /stop/i }) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);

    await userEvent.click(stopButton);
    expect(abortMutateAsync).toHaveBeenCalledWith({ threadId: "thread-1" });
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
    expect(abortMutateAsync).toHaveBeenCalledWith({ threadId: "thread-1" });
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
});

describe("Composer — Escape interrupts the running turn", () => {
  beforeEach(() => {
    abortMutate.mockClear();
    useComposerPrefillStore.setState({ text: null });
  });

  it("aborts the active thread on Escape while the agent is busy", () => {
    renderComposer("streaming");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(abortMutate).toHaveBeenCalledTimes(1);
    expect(abortMutate.mock.calls[0][0]).toEqual({ threadId: "thread-1" });
  });

  it("does nothing on Escape while idle", () => {
    renderComposer("idle");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(abortMutate).not.toHaveBeenCalled();
  });

  // Same durable-queue fallback as the Stop button: Escape must interrupt
  // whenever the agent holds the execution context, including after a
  // reload that missed the live status events.
  it("aborts on Escape while the queue reports a running turn, even with agentStatus idle", () => {
    queueStateRef.current = queueState("followup");
    renderComposer("idle");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(abortMutate).toHaveBeenCalledTimes(1);
    expect(abortMutate.mock.calls[0][0]).toEqual({ threadId: "thread-1" });
  });

  it("skips an Escape already claimed by another layer (defaultPrevented)", () => {
    renderComposer("streaming");
    // Simulate a higher-priority dismissal (e.g. ChildPanel close) that
    // claims the event in the capture phase before the interrupt listener.
    const claim = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", claim, { capture: true });
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", claim, { capture: true });
    expect(abortMutate).not.toHaveBeenCalled();
  });

  it("dismisses an open command popup instead of aborting", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
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

  it("labels the button Send and shows no queue hint while the agent is idle", () => {
    renderComposer("idle");
    expect(screen.getByRole("button", { name: /^send$/i })).toBeDefined();
    expect(screen.queryByText(/current turn/i)).toBeNull();
  });

  it("labels the button Queue while the agent works and nothing is self-queued", () => {
    queueStateRef.current = queueState("steer");
    renderComposer("streaming");

    expect(screen.getByRole("button", { name: /^queue$/i })).toBeDefined();
    expect(screen.getByText(/completes the current turn/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /^steer$/i })).toBeNull();
  });

  it("labels the button Queue in followup mode before the first queued item", () => {
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");

    expect(screen.getByRole("button", { name: /^queue$/i })).toBeDefined();
    expect(screen.getByText(/completes the current turn/i)).toBeDefined();
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

  it("queues a mid-turn message with queueMode followup", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = queueState("steer");
    renderComposer("streaming");

    await type("also update the runbook");
    await userEvent.click(screen.getByRole("button", { name: /^queue$/i }));
    await waitFor(() =>
      expect(sendMutateAsync).toHaveBeenCalledWith({
        text: "also update the runbook",
        threadId: "thread-1",
        queueMode: "followup",
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
    expect(screen.getByText(/queued\. press enter again/i)).toBeDefined();
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
        queueMode: "followup",
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
