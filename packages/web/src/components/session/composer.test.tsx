// @vitest-environment jsdom
/**
 * Composer-prefill consumption (decision 17): the memory doc pane sets
 * `useComposerPrefillStore` before navigating to `/chat`; the next
 * `Composer` mount must seed its textarea from that store exactly once and
 * leave the store empty afterward, so it doesn't leak into a later
 * mount/remount.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useComposerPrefillStore } from "~/stores/composer-prefill";

vi.mock("~/api/queries", () => ({
  useSendPrompt: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock("~/stores/stream", () => ({
  useStreamStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ addUserMessage: vi.fn(), setMessageQueueItemId: vi.fn() }),
  useQueueStateForThread: () => undefined,
}));

import { Composer } from "./composer";

function renderComposer() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Composer sessionId="orchestrator:user-1" threadId="thread-1" agentStatus="idle" />
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
