// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { StreamMessage } from "~/stores/stream";

vi.mock("~/lib/mermaid", () => ({
  renderMermaid: vi.fn().mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"><text>Chat diagram</text></svg>'),
}));
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSessionRatings: () => ({ data: { session: null, entries: {} }, isLoading: false, error: null }),
    useRateMessage: () => ({ isPending: false, mutate: vi.fn() }),
  };
});

import { TooltipProvider } from "~/components/primitives";
import { MessageItem } from "./message-item";

function message(content: string): StreamMessage {
  return {
    id: "m1",
    sessionId: "s1",
    threadId: "t1",
    role: "assistant",
    content,
    parts: [],
    createdAt: Date.now(),
  };
}

describe("MessageItem Mermaid integration", () => {
  it("renders a fenced Mermaid block in a chat message", async () => {
    const view = render(
      <TooltipProvider>
        <MessageItem message={message("```mermaid\ngraph TD\n  A-->B\n```")} />
      </TooltipProvider>,
    );

    await waitFor(() =>
      expect(view.container.querySelector('img[alt="Mermaid diagram"]')).toBeTruthy(),
    );
  });
});
