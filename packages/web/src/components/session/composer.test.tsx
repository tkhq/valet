// @vitest-environment jsdom
/**
 * Composer-prefill consumption (decision 17): the memory doc pane sets
 * `useComposerPrefillStore` before navigating to `/chat`; the next
 * `Composer` mount must seed its textarea from that store exactly once and
 * leave the store empty afterward, so it doesn't leak into a later
 * mount/remount.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useComposerPrefillStore } from "~/stores/composer-prefill";

const abortMutateAsync = vi.fn().mockResolvedValue({ ok: true });

// importOriginal: see -new-session-dialog.test.tsx for why a bare
// replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSendPrompt: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useAbortThread: () => ({ isPending: false, mutateAsync: abortMutateAsync }),
  };
});

vi.mock("~/stores/stream", () => ({
  useStreamStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ addUserMessage: vi.fn(), setMessageQueueItemId: vi.fn() }),
  useQueueStateForThread: () => undefined,
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

  it("shows Stop instead of Send while the agent is busy, and aborts the active thread on click", async () => {
    useComposerPrefillStore.setState({ text: null });
    const { default: userEvent } = await import("@testing-library/user-event");
    renderComposer("streaming");

    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
    const stopButton = screen.getByRole("button", { name: /stop/i }) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);

    await userEvent.click(stopButton);
    expect(abortMutateAsync).toHaveBeenCalledWith({ threadId: "thread-1" });
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
