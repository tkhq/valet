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
import { useComposerPrefillStore } from "~/stores/composer-prefill";

const abortMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const abortMutate = vi.fn();
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
    useSendPrompt: () => ({ isPending: false, mutateAsync: sendMutateAsync }),
    useAbortThread: () => ({
      isPending: false,
      mutateAsync: abortMutateAsync,
      mutate: abortMutate,
    }),
  };
});

vi.mock("~/stores/stream", () => ({
  useStreamStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ addUserMessage, setMessageQueueItemId }),
  useQueueStateForThread: () => queueStateRef.current,
}));

vi.mock("~/hooks/use-commands", () => ({
  useCommands: () => ({
    data: {
      commands: [
        { name: "status", description: "Show session status", source: "builtin" },
        { name: "stop", description: "Stop the agent", source: "builtin" },
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

function renderComposer(agentStatus: "idle" | "streaming" = "idle") {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Composer sessionId="orchestrator:user-1" threadId="thread-1" agentStatus={agentStatus} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queueStateRef.current = undefined;
  useComposerPrefillStore.setState({ text: null });
  sendMutateAsync.mockClear();
  abortMutateAsync.mockClear();
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
 * The submit affordance follows the thread's live queue mode. `steer` means
 * the engine stops the running turn for this message; `followup` means it
 * waits for that turn to end. The composer must not promise the first when
 * the engine does the second.
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

  it("labels the button Steer and says the current turn stops, in steer mode", () => {
    queueStateRef.current = queueState("steer");
    renderComposer("streaming");

    expect(screen.getByRole("button", { name: /^steer$/i })).toBeDefined();
    expect(screen.getByText(/steer stops the current turn/i)).toBeDefined();
  });

  it("labels the button Queue and says the turn completes first, in followup mode", () => {
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

  it("sends a steer message while the agent works", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = queueState("steer");
    renderComposer("streaming");

    await type("stop and read the failing test first");
    const steerButton = screen.getByRole("button", { name: /^steer$/i }) as HTMLButtonElement;
    expect(steerButton.disabled).toBe(false);

    await userEvent.click(steerButton);
    await waitFor(() =>
      expect(sendMutateAsync).toHaveBeenCalledWith({
        text: "stop and read the failing test first",
        threadId: "thread-1",
      }),
    );
  });

  it("sends a followup message while the agent works", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");

    await type("also update the runbook");
    await userEvent.click(screen.getByRole("button", { name: /^queue$/i }));
    await waitFor(() =>
      expect(sendMutateAsync).toHaveBeenCalledWith({
        text: "also update the runbook",
        threadId: "thread-1",
      }),
    );
  });

  it("keeps the submit button disabled while the agent works and the box is empty", () => {
    queueStateRef.current = queueState("followup");
    renderComposer("streaming");
    const queueButton = screen.getByRole("button", { name: /^queue$/i }) as HTMLButtonElement;
    expect(queueButton.disabled).toBe(true);
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
